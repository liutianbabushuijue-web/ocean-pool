// Real PostgreSQL integration tests. The runner gives this file its own throwaway
// database; publishArticle creates every ledger entry, and HTTP never leaves loopback.
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { readSyncPage, SnapshotRequiredError } from "../sync.ts";
import { pushPending, pushStatus } from "../push.ts";
import { registerStepxRoutes } from "../server.ts";
import { registerStepxAdminRoutes } from "../admin.ts";
import { encodeCursor, verifies, type StepxEnvelope } from "../payload.ts";

const SOURCE = "stepx-sync-fixture";
const SECRET = "stepx-local-test-secret-0123456789";
let serial = 0;

beforeEach(async () => {
  // tests/databases.ts clones the template per file. No shared or production data.
  await sql`TRUNCATE sources, selected_ledger, selected_state, stepx_push_state CASCADE`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Ocean fixture', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  delete process.env.STEPX_WEBHOOK_URL;
  process.env.STEPX_WEBHOOK_SECRET = SECRET;
  process.env.STEPX_INCLUDE_BODY = "false";
});

after(async () => {
  await stopBoss();
  await closeDb();
});

async function article(options: { selected?: boolean; ageMs?: number } = {}) {
  const n = ++serial;
  const at = new Date(Date.now() - (options.ageMs ?? 60_000));
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/stepx-fixture-${n}`,
    title: `Ocean fixture ${n}`, bodyText: `Ocean body ${n}`, bodyHtml: `<p>Ocean body ${n}</p>`,
    bodyStatus: "ok", via: "import", publishedAt: at, discoveredAt: at,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', 'physical', ${`海温观测${n}`}, ${`观测摘要${n}`}, '一手观测', 90, ${options.selected ?? true}, ${["海温"]})`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: at });
  return articleId;
}

async function drain(since: string | null, limit = 2) {
  const items: StepxEnvelope["items"] = [];
  let cursor = since;
  for (let n = 0; n < 30; n++) {
    const page = await readSyncPage(cursor, limit);
    assert.equal(page.count, page.items.length);
    assert.ok(page.nextSince, "even an empty page retains a resumable watermark");
    items.push(...page.items);
    cursor = page.nextSince;
    if (!page.hasMore) return { items, cursor };
  }
  throw new Error("sync did not finish within 30 fixture pages");
}

test("snapshot pages contain every item once; its final cursor receives subsequent additions", async () => {
  const ids = [];
  for (let n = 0; n < 5; n++) ids.push(await article());
  const initial = await drain(null, 2);
  assert.deepEqual(new Set(initial.items.map((item) => item.sourceItemId)), new Set(ids));
  assert.equal(initial.items.length, ids.length);
  const empty = await readSyncPage(initial.cursor, 2);
  assert.equal(empty.count, 0);
  assert.equal(empty.nextSince, initial.cursor);
  const next = await article();
  const changes = await drain(empty.nextSince, 1);
  assert.deepEqual(changes.items.map((item) => item.sourceItemId), [next]);
  assert.equal(changes.items[0]!.sourceName, "Ocean fixture");
  assert.ok(changes.items[0]!.originalUrl?.startsWith("https://example.com/"));
});

test("a corrected old article and an old article selected late both cross the saved watermark", async () => {
  const old = await article({ ageMs: 30 * 86400_000 });
  const late = await article({ selected: false, ageMs: 60 * 86400_000 });
  const baseline = await drain(null);
  assert.deepEqual(baseline.items.map((item) => item.sourceItemId), [old]);
  await sql`UPDATE analyses SET title_zh = '已核实的旧文更正', summary_zh = '更正后的摘要' WHERE article_id = ${old}`;
  await publishArticle(old);
  await sql`UPDATE analyses SET selected = true WHERE article_id = ${late}`;
  await publishArticle(late);
  const changes = await drain(baseline.cursor, 1);
  assert.deepEqual(changes.items.map((item) => item.sourceItemId), [old, late]);
  assert.equal(changes.items[0]!.title, "已核实的旧文更正");
  assert.equal(changes.items[0]!.summary, "更正后的摘要");
  assert.ok(new Date(changes.items[0]!.updatedAt).getTime() > Date.now() - 60_000);
});

test("withdrawal becomes a tombstone in incremental pages and removes the item from a new snapshot", async () => {
  const id = await article();
  const baseline = await drain(null);
  await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${id}, 'withdrawn')`;
  await publishArticle(id);
  const changes = await drain(baseline.cursor, 1);
  assert.equal(changes.items.length, 1);
  const item = changes.items[0]!;
  assert.equal(item.externalId, `aihot:${id}`);
  assert.equal(item.tombstone, true);
  assert.equal(item.title, null);
  assert.equal(item.summary, null);
  assert.equal(item.bodyText, null);
  assert.equal((await drain(null)).items.length, 0);
});

test("retrying a page is idempotent and previously withdrawn content never reappears as an upsert", async () => {
  const baseline = await drain(null);
  const id = await article();
  const first = await readSyncPage(baseline.cursor, 1);
  const retry = await readSyncPage(baseline.cursor, 1);
  assert.deepEqual(retry.items, first.items);
  assert.equal(retry.nextSince, first.nextSince);
  await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${id}, 'withdrawn')`;
  await publishArticle(id);
  const afterWithdrawal = await drain(baseline.cursor, 1);
  assert.ok(afterWithdrawal.items.length >= 1);
  assert.ok(afterWithdrawal.items.every((item) => item.sourceItemId === id && item.tombstone));
});

test("malformed and legacy timeline cursors require a fresh snapshot", async () => {
  for (const cursor of ["broken", "", encodeCursor(new Date(), "old_article")]) {
    await assert.rejects(readSyncPage(cursor, 2), SnapshotRequiredError);
  }
});

async function webhook(answer: (body: StepxEnvelope, hit: number) => Promise<number> | number) {
  const envelopes: StepxEnvelope[] = [];
  const signatures: boolean[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    signatures.push(verifies(raw, Number(req.headers["x-stepx-timestamp"]), String(req.headers["x-stepx-signature"]), SECRET));
    const envelope = JSON.parse(raw) as StepxEnvelope;
    envelopes.push(envelope);
    const status = await answer(envelope, envelopes.length);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/receive`, envelopes, signatures,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("push commits each successful page and retries only the failed page without inflating totals", async () => {
  for (let n = 0; n < 3; n++) await article();
  const receiver = await webhook((_body, hit) => hit === 2 ? 503 : 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    const first = await pushPending({ limit: 1, maxPages: 5 });
    assert.equal(first.ok, false);
    assert.equal(first.pushed, 1);
    assert.equal(first.status, 503);
    const failed = await pushStatus();
    assert.equal(failed.state?.pushedTotal, 1);
    assert.ok(failed.state?.lastSuccessAt);
    assert.equal(failed.state?.lastStatus, 503);
    const retry = await pushPending({ limit: 1, maxPages: 5 });
    assert.equal(retry.ok, true);
    assert.equal(retry.pushed, 2);
    assert.deepEqual(receiver.envelopes[2]!.items, receiver.envelopes[1]!.items);
    assert.equal((await pushStatus()).state?.pushedTotal, 3);
    assert.ok(receiver.signatures.every(Boolean), "each HTTP delivery signs the exact raw body");
    const before = receiver.envelopes.length;
    assert.equal((await pushPending({ limit: 1 })).pushed, 0);
    assert.equal(receiver.envelopes.length, before, "an unchanged watermark creates no duplicate delivery");
  } finally { await receiver.close(); }
});

test("changing the webhook target starts a new snapshot", async () => {
  const id = await article();
  const first = await webhook(() => 200);
  const second = await webhook(() => 200);
  try {
    process.env.STEPX_WEBHOOK_URL = first.url;
    assert.equal((await pushPending()).pushed, 1);
    process.env.STEPX_WEBHOOK_URL = second.url;
    assert.equal((await pushPending()).pushed, 1);
    assert.equal(second.envelopes[0]!.items[0]!.sourceItemId, id);
  } finally { await first.close(); await second.close(); }
});

test("overlapping manual and scheduled pushes are rejected until the first delivery finishes", async () => {
  await article();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const receiver = await webhook(async () => { entered(); await gate; return 200; });
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  const pending = pushPending();
  try {
    await started;
    const overlapping = await pushPending();
    assert.equal(overlapping.ok, false);
    assert.match(overlapping.error ?? "", /正在运行/);
    assert.equal(overlapping.pushed, 0);
    release();
    assert.equal((await pending).ok, true);
    assert.equal(receiver.envelopes.length, 1);
  } finally { release(); await pending; await receiver.close(); }
});

async function expireReconciliation() {
  await sql`UPDATE stepx_push_state SET reconciled_at = now() - interval '2 days'`;
}

async function pushProgress() {
  const [row] = await sql<Array<{ sync_cursor: string | null; reconcile_cursor: string | null; reconciled_at: Date | null }>>`
    SELECT sync_cursor, reconcile_cursor, reconciled_at FROM stepx_push_state`;
  assert.ok(row, "the fixture has one configured webhook channel");
  return row;
}

async function ledgerSequence() {
  const [row] = await sql<{ seq: number }[]>`SELECT coalesce(max(seq), 0) AS seq FROM selected_ledger`;
  return Number(row!.seq);
}

test("daily reconciliation delivers tag-only corrections without replacing the main incremental watermark", async () => {
  const id = await article();
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending()).ok, true);
    const initial = await pushProgress();
    assert.ok(initial.reconciled_at, "the first completed snapshot counts as reconciliation");
    const seq = await ledgerSequence();
    await sql`UPDATE analyses SET tags = ${["海温", "已校正海区"]} WHERE article_id = ${id}`;
    await publishArticle(id);
    assert.equal(await ledgerSequence(), seq, "tags alone are absent from the engine ledger payload hash");
    const before = receiver.envelopes.length;
    await expireReconciliation();
    assert.equal((await pushPending()).ok, true);
    const delivered = receiver.envelopes.slice(before).flatMap((page) => page.items);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.sourceItemId, id);
    assert.deepEqual(delivered[0]!.tags, ["海温", "已校正海区"]);
    const done = await pushProgress();
    assert.equal(done.sync_cursor, initial.sync_cursor);
    assert.equal(done.reconcile_cursor, null);
    assert.ok(done.reconciled_at!.getTime() > Date.now() - 60_000);
  } finally { await receiver.close(); }
});

test("daily reconciliation clears a previously distributed body when redistribution permission is revoked", async () => {
  const id = await article();
  process.env.STEPX_INCLUDE_BODY = "true";
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending()).ok, true);
    assert.match(receiver.envelopes[0]!.items[0]!.bodyText ?? "", /Ocean body/);
    const seq = await ledgerSequence();
    await sql`UPDATE sources SET syndicate_fulltext = false WHERE id = ${SOURCE}`;
    await publishArticle(id);
    assert.equal(await ledgerSequence(), seq, "licence changes do not alter the engine's summary-only sync payload");
    await expireReconciliation();
    const before = receiver.envelopes.length;
    assert.equal((await pushPending()).ok, true);
    const delivered = receiver.envelopes.slice(before).flatMap((page) => page.items);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.sourceItemId, id);
    assert.equal(delivered[0]!.tombstone, false);
    assert.equal(delivered[0]!.bodyText, null, "the receiver gets an explicit null to remove the stale body");
  } finally { await receiver.close(); }
});

test("a failed reconciliation page resumes after its acknowledged predecessor and preserves the incremental cursor", async () => {
  for (let n = 0; n < 3; n++) await article();
  let failAt = -1;
  const receiver = await webhook((_body, hit) => hit === failAt ? 503 : 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending({ limit: 1, maxPages: 5 })).pushed, 3);
    const initial = await pushProgress();
    await expireReconciliation();
    const before = receiver.envelopes.length;
    failAt = before + 2;
    const failed = await pushPending({ limit: 1, maxPages: 5 });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 503);
    assert.equal(failed.pushed, 1);
    const partial = await pushProgress();
    assert.ok(partial.reconcile_cursor, "the first acknowledged reconciliation page is durable");
    assert.equal(partial.sync_cursor, initial.sync_cursor);
    assert.equal((await pushStatus()).state?.pushedTotal, 4);
    assert.equal((await pushPending({ limit: 1, maxPages: 5 })).ok, true);
    assert.deepEqual(receiver.envelopes[before + 2]!.items, receiver.envelopes[before + 1]!.items, "retry starts at the failed page");
    const done = await pushProgress();
    assert.equal(done.reconcile_cursor, null);
    assert.equal(done.sync_cursor, initial.sync_cursor);
    assert.equal((await pushStatus()).state?.pushedTotal, 6);
  } finally { await receiver.close(); }
});

test("reconciliation shares the page budget and resumes its pending snapshot even when its timestamp is fresh", async () => {
  for (let n = 0; n < 3; n++) await article();
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending({ limit: 1, maxPages: 5 })).pushed, 3);
    const main = (await pushProgress()).sync_cursor;
    await expireReconciliation();
    const before = receiver.envelopes.length;
    assert.equal((await pushPending({ limit: 1, maxPages: 2 })).pushed, 1, "one empty incremental page leaves one reconciliation page in the shared budget");
    assert.equal(receiver.envelopes.length, before + 1);
    const firstCursor = (await pushProgress()).reconcile_cursor;
    assert.ok(firstCursor);
    await sql`UPDATE stepx_push_state SET reconciled_at = now()`;
    assert.equal((await pushPending({ limit: 1, maxPages: 2 })).pushed, 1);
    assert.notEqual((await pushProgress()).reconcile_cursor, firstCursor);
    assert.equal((await pushPending({ limit: 1, maxPages: 2 })).pushed, 1);
    const done = await pushProgress();
    assert.equal(done.reconcile_cursor, null);
    assert.equal(done.sync_cursor, main);
    const ids = receiver.envelopes.slice(before).flatMap((page) => page.items.map((item) => item.sourceItemId));
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "continuation never restarts acknowledged snapshot pages");
  } finally { await receiver.close(); }
});

test("a withdrawal committed between incremental acknowledgement and reconciliation is delivered on the next incremental run", async () => {
  const corrected = await article();
  const removed = await article();
  let withdrawOnDelivery = false;
  const receiver = await webhook(async () => {
    if (withdrawOnDelivery) {
      withdrawOnDelivery = false;
      // The incremental page has a watermark already. Reconciliation starts after
      // this acknowledgement and sees the removal in its newer snapshot watermark.
      await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${removed}, 'withdrawn')`;
      await publishArticle(removed);
    }
    return 200;
  });
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending()).pushed, 2);
    await sql`UPDATE analyses SET title_zh = '经核实的最新更正' WHERE article_id = ${corrected}`;
    await publishArticle(corrected);
    await expireReconciliation();
    const before = receiver.envelopes.length;
    withdrawOnDelivery = true;
    assert.equal((await pushPending({ maxPages: 5 })).ok, true);
    const incremental = receiver.envelopes[before]!;
    assert.equal(incremental.items[0]!.sourceItemId, corrected);
    assert.equal(incremental.items[0]!.tombstone, false);
    assert.equal((await pushProgress()).sync_cursor, incremental.nextSince, "the independent snapshot cannot advance the incremental watermark past unseen removals");
    const afterReconciliation = receiver.envelopes.length;
    assert.equal((await pushPending()).ok, true);
    const following = receiver.envelopes.slice(afterReconciliation).flatMap((page) => page.items);
    assert.ok(following.some((item) => item.sourceItemId === removed && item.tombstone), "the concurrent withdrawal must reach the receiver");
  } finally { await receiver.close(); }
});

const READ_TOKEN = "stepx-http-fixture-token-0123456789";
const authorized = { authorization: `Bearer ${READ_TOKEN}` };

function routeApp() {
  process.env.STEPX_TOKEN = READ_TOKEN;
  const app = Fastify({ logger: false });
  registerStepxRoutes(app);
  return app;
}

test("HTTP item, single-item and outbox endpoints reject missing or wrong tokens and allow a valid snapshot", async (t) => {
  const id = await article();
  const app = routeApp();
  t.after(() => app.close());
  for (const url of ["/api/stepx/v1/items", `/api/stepx/v1/items/aihot:${id}`, "/api/stepx/v1/outbox"]) {
    for (const headers of [{}, { authorization: "Bearer definitely-the-wrong-token" }]) {
      const refused = await app.inject({ method: "GET", url, headers });
      assert.equal(refused.statusCode, 401);
      assert.equal(refused.headers["cache-control"], "no-store");
    }
  }
  const response = await app.inject({ method: "GET", url: "/api/stepx/v1/items?limit=1", headers: authorized });
  assert.equal(response.statusCode, 200);
  const page = response.json<StepxEnvelope>();
  assert.equal(page.schema, "stepx.ocean.v1");
  assert.equal(page.count, 1);
  assert.equal(page.items[0]!.externalId, `aihot:${id}`);
  assert.ok(page.nextSince);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("HTTP nextSince resumes additions, corrections and removals after the original snapshot", async (t) => {
  const corrected = await article();
  const removed = await article();
  const app = routeApp();
  t.after(() => app.close());
  const original = await app.inject({ method: "GET", url: "/api/stepx/v1/items", headers: authorized });
  const baseline = original.json<StepxEnvelope>();
  assert.equal(baseline.count, 2);
  assert.equal(baseline.hasMore, false);
  const added = await article();
  await sql`UPDATE analyses SET title_zh = 'HTTP已核实更正' WHERE article_id = ${corrected}`;
  await publishArticle(corrected);
  await sql`INSERT INTO editorial_overrides (article_id, visibility) VALUES (${removed}, 'withdrawn')`;
  await publishArticle(removed);
  const delivered: StepxEnvelope["items"] = [];
  let cursor = baseline.nextSince;
  for (let n = 0; n < 5; n++) {
    assert.ok(cursor);
    const response = await app.inject({ method: "GET", url: `/api/stepx/v1/items?limit=1&since=${encodeURIComponent(cursor)}`, headers: authorized });
    assert.equal(response.statusCode, 200);
    const page = response.json<StepxEnvelope>();
    assert.equal(page.count, 1);
    delivered.push(...page.items);
    cursor = page.nextSince;
    if (!page.hasMore) break;
  }
  assert.deepEqual(delivered.map((item) => item.sourceItemId), [added, corrected, removed]);
  assert.equal(delivered[1]!.title, "HTTP已核实更正");
  assert.equal(delivered[2]!.tombstone, true);
  const empty = await app.inject({ method: "GET", url: `/api/stepx/v1/items?since=${encodeURIComponent(cursor!)}`, headers: authorized });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json<StepxEnvelope>().count, 0);
});

test("HTTP legacy cursors return an explicit 409 snapshot_required for items and outbox", async (t) => {
  const app = routeApp();
  t.after(() => app.close());
  const oldCursor = encodeCursor(new Date(), "legacy_item");
  for (const path of ["items", "outbox"]) {
    const response = await app.inject({ method: "GET", url: `/api/stepx/v1/${path}?since=${encodeURIComponent(oldCursor)}`, headers: authorized });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json<{ error: string }>().error, "snapshot_required");
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("HTTP a missing single item returns a 200 tombstone rather than a 404", async (t) => {
  const app = routeApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/stepx/v1/items/aihot:never_existed", headers: authorized });
  assert.equal(response.statusCode, 200);
  const { item } = response.json<{ item: StepxEnvelope["items"][number] }>();
  assert.equal(item.externalId, "aihot:never_existed");
  assert.equal(item.tombstone, true);
  assert.equal(item.title, null);
  assert.equal(item.originalUrl, null);
});

test("HTTP outbox signs its exact response bytes with the pull token", async (t) => {
  const id = await article();
  const app = routeApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/stepx/v1/outbox", headers: authorized });
  assert.equal(response.statusCode, 200);
  const timestamp = Number(response.headers["x-stepx-timestamp"]);
  const signature = String(response.headers["x-stepx-signature"]);
  assert.ok(Number.isInteger(timestamp));
  assert.ok(Math.abs(Date.now() / 1000 - timestamp) < 5);
  assert.equal(verifies(response.body, timestamp, signature, READ_TOKEN), true);
  assert.equal(verifies(`${response.body} `, timestamp, signature, READ_TOKEN), false);
  assert.equal(verifies(response.body, timestamp, signature, SECRET), false, "outbox signing uses its pull credential, distinct from worker webhook signing");
  assert.equal(response.json<StepxEnvelope>().items[0]!.sourceItemId, id);
});

test("administrator can explicitly recover a broken push cursor without deleting content or history", async (t) => {
  const id = await article();
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  const adminToken = "stepx-reset-fixture-admin-token-0123456789";
  process.env.ADMIN_SYNC_TOKEN = adminToken;
  const app = Fastify({ logger: false });
  registerStepxAdminRoutes(app);
  t.after(async () => { await app.close(); await receiver.close(); });
  assert.equal((await pushPending()).pushed, 1);
  await sql`UPDATE stepx_push_state SET sync_cursor = 'broken'`;
  assert.equal((await pushPending()).ok, false);
  const refused = await app.inject({ method: "POST", url: "/api/stepx/admin/reset", payload: {} });
  assert.equal(refused.statusCode, 403);
  assert.equal((await pushProgress()).sync_cursor, "broken");
  const reset = await app.inject({ method: "POST", url: "/api/stepx/admin/reset", headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
  assert.equal(reset.statusCode, 200);
  assert.equal((await pushProgress()).sync_cursor, null);
  assert.equal(Number((await sql`SELECT count(*) AS n FROM publications WHERE article_id = ${id}`)[0]!.n), 1);
  assert.equal((await pushStatus()).state?.pushedTotal, 1);
  assert.equal((await pushPending()).pushed, 1);
  assert.equal((await pushStatus()).state?.pushedTotal, 2);
});

test("a requested single-page budget cannot starve reconciliation", async () => {
  await article();
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending()).pushed, 1);
    await expireReconciliation();
    assert.equal((await pushPending({ maxPages: 1 })).pushed, 1);
    assert.equal((await pushProgress()).reconcile_cursor, null);
  } finally { await receiver.close(); }
});

test("an empty poll does not claim a new successful webhook delivery", async () => {
  const receiver = await webhook(() => 200);
  process.env.STEPX_WEBHOOK_URL = receiver.url;
  try {
    assert.equal((await pushPending()).pushed, 0);
    assert.equal(receiver.envelopes.length, 0);
    assert.equal((await pushStatus()).state?.lastSuccessAt, null);
    await article();
    assert.equal((await pushPending()).pushed, 1);
    await sql`UPDATE stepx_push_state SET last_success_at = '2026-01-01T00:00:00Z'`;
    assert.equal((await pushPending()).pushed, 0);
    assert.equal((await pushStatus()).state?.lastSuccessAt, "2026-01-01T00:00:00.000Z");
  } finally { await receiver.close(); }
});
