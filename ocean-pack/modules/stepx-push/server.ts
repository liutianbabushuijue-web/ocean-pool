// stepx 的同步出口（拉）。推送见 push.ts；后台页见 admin.ts + web/admin-sync.tsx。
//
// 为什么两种都有：
//   拉 /api/stepx/v1/items：stepx 侧有平台定时器时用，AIHOT 不需要配 webhook；
//   推 stepx.push 定时任务：stepx 侧没有定时器、管理员会话会过期时用，AIHOT 主动 POST。
// 两条路读的是同一个读取函数（item.ts），不会对同一条给出不同字段。
//
// 三个地址（在 module.ts 的 apiPaths 里声明）：
//   GET  /api/stepx/v1/items?since=<cursor>&limit=50    增量拉取精选（Bearer STEPX_TOKEN）
//   GET  /api/stepx/v1/items/:externalId                单条核对（撤回返回 tombstone）
//   GET  /api/stepx/v1/outbox?since=<cursor>&limit=200  同一份 JSON + HMAC 签名头

import { credential } from "@aihot/backend/config";
import type { ServerModule } from "@aihot/backend/modules";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerStepxAdminRoutes } from "./admin.ts";
import { bodyAllowed, readOne, seatedCounts, toItem } from "./item.ts";
import { pushSchedule } from "./push.ts";
import { sign, tokenMatches, tombstoneOf, type StepxEnvelope } from "./payload.ts";
import { readSyncPage, SnapshotRequiredError } from "./sync.ts";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseQuery(req: FastifyRequest): { since: string | null; limit: number } {
  const q = req.query as Record<string, string | undefined>;
  const rawSince = typeof q.since === "string" ? q.since.trim() : "";
  const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit))) : DEFAULT_LIMIT;
  return { since: rawSince || null, limit };
}

function bearer(req: FastifyRequest): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).header("Cache-Control", "no-store").type("application/json; charset=utf-8")
    .send({ error: "unauthorized", detail: "Set Authorization: Bearer <STEPX_TOKEN>." });
}

async function page(req: FastifyRequest): Promise<StepxEnvelope> {
  const { since, limit } = parseQuery(req);
  return readSyncPage(since, limit);
}

export function registerStepxRoutes(app: FastifyInstance): void {
  app.get("/api/stepx/v1/items", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!tokenMatches(bearer(req), credential("integrations", "STEPX_TOKEN"))) return unauthorized(reply);
    try { return await page(req); }
    catch (error) {
      if (error instanceof SnapshotRequiredError) return reply.code(409).send({ error: "snapshot_required", detail: error.message });
      throw error;
    }
  });

  app.get("/api/stepx/v1/items/:externalId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!tokenMatches(bearer(req), credential("integrations", "STEPX_TOKEN"))) return unauthorized(reply);
    const externalId = String((req.params as { externalId?: string }).externalId ?? "");
    const articleId = externalId.startsWith("aihot:") ? externalId.slice(6) : externalId;
    const now = new Date();
    const row = await readOne(articleId, now);
    // 已经撤回或从未精选：返回 tombstone，stepx 侧照常下架，不必区分“没推过”。
    if (!row) return reply.send({ schema: "stepx.ocean.v1", item: tombstoneOf(articleId, now) });
    return reply.send({ schema: "stepx.ocean.v1", item: toItem(row, bodyAllowed()) });
  });

  // 推送模式：同一份 JSON，加签名头。stepx 的云函数按 X-Stepx-Signature 校验后入库。
  app.get("/api/stepx/v1/outbox", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const secret = credential("integrations", "STEPX_TOKEN");
    if (!tokenMatches(bearer(req), secret)) return unauthorized(reply);
    let envelope: StepxEnvelope;
    try { envelope = await page(req); }
    catch (error) {
      if (error instanceof SnapshotRequiredError) return reply.code(409).send({ error: "snapshot_required", detail: error.message });
      throw error;
    }
    const raw = JSON.stringify(envelope);
    const at = Math.floor(Date.now() / 1000);
    return reply
      .header("X-Stepx-Timestamp", String(at))
      .header("X-Stepx-Signature", sign(raw, at, secret!))
      .type("application/json; charset=utf-8")
      .send(raw);
  });
}

const serverModule: ServerModule = {
  name: "stepx-push",
  http: (app) => {
    registerStepxRoutes(app);
    registerStepxAdminRoutes(app);
  },
  // worker 的定时推送；没配 STEPX_WEBHOOK_URL 时不注册。
  schedules: [pushSchedule],
  llms: () => ({
    ways: ["海洋知识库同步：GET /api/stepx/v1/items（Bearer STEPX_TOKEN，增量游标 since）"],
  }),
  // 运维日报里补一行：推送失败会在这里出现，不用等后台。
  sourceHealth: async () => {
    try {
      const counts = await seatedCounts();
      return [`stepx 同步：精选 ${counts.selected} 条，近 24 小时 ${counts.lastDay} 条`];
    } catch {
      return [];
    }
  },
};

export default serverModule;
