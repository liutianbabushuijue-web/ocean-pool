// 定时推送：worker 每 N 分钟把新精选 POST 到 stepx 的 webhook。
//
// 为什么要有它：stepx 的云函数不会自己定时，管理员会话又会过期，不能当 cron 凭据。
// 与其让 stepx 那边想办法定时拉，不如由 AIHOT 主动推——它本来就有常驻 worker 和 cron。
// 两条路并存，任选其一：
//   拉（server.ts 的 /api/stepx/v1/items）：stepx 侧有平台定时器时用，最省 AIHOT 的配置；
//   推（本文件）：stepx 侧没有定时器时用，stepx 只需要一个收 webhook 的函数。
//
// 投递语义：至少一次。游标只在 2xx 后前进；失败下一轮重投同一批，stepx 按 externalId upsert 去重。
// 一页最多 200 条、一轮最多 5 页（可由 STEPX_PUSH_MAX_PAGES 调），避免一个 worker 周期被长事务占住。

import { createHash } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import type { Scheduled } from "@aihot/backend/modules";
import { iso, sign, validCron, type StepxEnvelope } from "./payload.ts";
import { readSyncPage, syncPhase } from "./sync.ts";

const PAGE = 200;
const DEFAULT_MAX_PAGES = 5;

export interface PushState {
  channel: string;
  sync_cursor: string | null;
  reconcile_cursor: string | null;
  reconciled_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_success_at: Date | string | null;
  last_status: number | null;
  last_count: number;
  last_error: string | null;
  pushed_total: string | number;
}

export interface PushResult {
  ok: boolean;
  /** 本轮成功投递的条数。 */
  pushed: number;
  status: number | null;
  error: string | null;
}

function webhookUrl(): string | null {
  const value = credential("integrations", "STEPX_WEBHOOK_URL");
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) return null;
    return url.href;
  } catch { return null; }
}

// 更换接收地址必须重新发快照，不能让新目标继承旧目标的进度；URL 中的凭据不入库。
function channel(): string {
  return `webhook:${createHash("sha256").update(webhookUrl() ?? "").digest("hex").slice(0, 24)}`;
}

function webhookSecret(): string | null {
  const value = credential("integrations", "STEPX_WEBHOOK_SECRET") ?? credential("integrations", "STEPX_TOKEN");
  return value && value.length >= 16 ? value : null;
}

/** 从 payload.ts 再导出，调用方（含测试）不必知道它定义在哪。 */
export { validCron };

/** 推送是否配置齐全；worker 启动时据此决定要不要注册这个定时任务。 */
export function pushConfigured(): boolean {
  return Boolean(webhookUrl() && webhookSecret());
}

async function readState(key: string): Promise<PushState | null> {
  const [row] = await sql<PushState[]>`SELECT * FROM stepx_push_state WHERE channel = ${key}`;
  return row ?? null;
}

async function writeAttempt(key: string, result: PushResult, cursor: string | null, count: number): Promise<void> {
  const now = new Date();
  await sql`
    INSERT INTO stepx_push_state (channel, sync_cursor, last_attempt_at, last_success_at, last_status, last_count, last_error, pushed_total)
    VALUES (${key}, ${cursor}, ${now},
            ${result.ok && result.status !== null ? now : null}, ${result.status}, ${count}, ${result.error},
            ${result.ok ? count : 0})
    ON CONFLICT (channel) DO UPDATE SET
      sync_cursor = COALESCE(EXCLUDED.sync_cursor, stepx_push_state.sync_cursor),
      last_attempt_at = EXCLUDED.last_attempt_at,
      last_success_at = COALESCE(EXCLUDED.last_success_at, stepx_push_state.last_success_at),
      last_status = EXCLUDED.last_status,
      last_count = EXCLUDED.last_count,
      last_error = EXCLUDED.last_error,
      pushed_total = stepx_push_state.pushed_total + ${result.ok ? count : 0}`;
}

/** 把一批条目 POST 到 webhook；2xx 才算成功。 */
async function deliver(envelope: StepxEnvelope): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const url = webhookUrl();
  const secret = webhookSecret();
  if (!url || !secret) return { ok: false, status: null, error: "STEPX_WEBHOOK_URL / STEPX_WEBHOOK_SECRET 未配置" };

  const raw = JSON.stringify(envelope);
  const at = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-stepx-timestamp": String(at),
        "x-stepx-signature": sign(raw, at, secret),
        "x-stepx-schema": "stepx.ocean.v1",
        "user-agent": "DeepBlueBot/1.0 (+stepx-push)",
      },
      body: raw,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    await res.body?.cancel();
    return { ok: true, status: res.status, error: null };
  } catch (error) {
    return { ok: false, status: null, error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300) };
  }
}

/**
 * 推送一轮：首次快照后续接变更账本，逐页投递，直到没有更多或达到页数上限。
 * 失败即停：不跳过前面没投成功的条目，否则会在 stepx 侧留下空档。
 */
export async function pushPending(options: { maxPages?: number; limit?: number } = {}): Promise<PushResult> {
  if (!pushConfigured()) return { ok: false, pushed: 0, status: null, error: "STEPX_WEBHOOK_URL / STEPX_WEBHOOK_SECRET 未配置" };
  const maxPages = Math.max(2, Math.min(20, Math.floor(options.maxPages ?? (Number(process.env.STEPX_PUSH_MAX_PAGES) || DEFAULT_MAX_PAGES))));
  const limit = Math.max(1, Math.min(PAGE, options.limit ?? PAGE));
  const key = channel();
  // API 的“立即推送”和 worker 定时任务可以同时发生。使用跨进程会话锁，
  // 每页进度独立提交；进程中断释放锁，已确认的页不需要重新开始。
  const lock = await sql.reserve();
  let acquired = false;
  let pushed = 0;
  let lastStatus: number | null = null;
  try {
    const [held] = await lock<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`;
    acquired = held?.acquired === true;
    if (!acquired) return { ok: false, pushed: 0, status: null, error: "已有推送正在运行，请稍后查看状态" };
    let cursor = (await readState(key))?.sync_cursor ?? null;
    let pages = 0;
    let caughtUp = false;
    for (; pages < maxPages; pages += 1) {
      const snapshot = syncPhase(cursor) === "page";
      const envelope = await readSyncPage(cursor, limit);
      const result: { ok: boolean; status: number | null; error: string | null } = envelope.count ? await deliver(envelope) : { ok: true, status: lastStatus, error: null };
      lastStatus = result.status;
      if (!result.ok) {
        const failed = { ...result, pushed };
        await writeAttempt(key, failed, null, 0);
        return failed;
      }
      cursor = envelope.nextSince;
      pushed += envelope.count;
      await writeAttempt(key, { ...result, pushed }, cursor, envelope.count);
      if (!envelope.hasMore) {
        if (snapshot) await sql`UPDATE stepx_push_state SET reconciled_at = now(), reconcile_cursor = NULL WHERE channel = ${key}`;
        caughtUp = true;
        pages += 1;
        break;
      }
    }

    // 扩展字段（标签、专题、正文许可）不都属于引擎 v1 账本 payload。
    // 每日独立快照补齐这些更正；绝不覆盖主高水位，否则快照期间的撤回会被跳过。
    const state = await readState(key);
    const due = !state?.reconciled_at || Date.now() - new Date(state.reconciled_at).getTime() >= 86400_000;
    if (caughtUp && state && (state.reconcile_cursor !== null || due)) {
      let reconcile = state.reconcile_cursor;
      for (; pages < maxPages; pages += 1) {
        const envelope = await readSyncPage(reconcile, limit);
        const result: { ok: boolean; status: number | null; error: string | null } = envelope.count ? await deliver(envelope) : { ok: true, status: lastStatus, error: null };
        lastStatus = result.status;
        if (!result.ok) {
          const failed = { ...result, pushed };
          await writeAttempt(key, failed, null, 0);
          return failed;
        }
        pushed += envelope.count;
        await writeAttempt(key, { ...result, pushed }, null, envelope.count);
        reconcile = envelope.hasMore ? envelope.nextSince : null;
        await sql`UPDATE stepx_push_state SET reconcile_cursor = ${reconcile},
          reconciled_at = CASE WHEN ${!envelope.hasMore} THEN now() ELSE reconciled_at END
          WHERE channel = ${key}`;
        if (!envelope.hasMore) break;
      }
    }
    return { ok: true, pushed, status: lastStatus, error: null };
  } catch (error) {
    const failed: PushResult = { ok: false, pushed, status: lastStatus, error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300) };
    if (acquired) await writeAttempt(key, failed, null, 0);
    return failed;
  } finally {
    try { if (acquired) await lock`SELECT pg_advisory_unlock(hashtext(${key}))`; }
    finally { lock.release(); }
  }
}

/** 游标失效后由管理员明确启动重新核对；保留内容、审核数据和历史投递统计。 */
export async function resetPushCursor(): Promise<boolean> {
  const key = channel();
  const lock = await sql.reserve();
  let acquired = false;
  try {
    const [held] = await lock<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`;
    acquired = held?.acquired === true;
    if (!acquired) return false;
    await sql`UPDATE stepx_push_state SET sync_cursor = NULL, reconcile_cursor = NULL, reconciled_at = NULL,
      last_error = '管理员已重建同步快照；接收端需核对历史条目的下架状态' WHERE channel = ${key}`;
    return true;
  } finally {
    try { if (acquired) await lock`SELECT pg_advisory_unlock(hashtext(${key}))`; }
    finally { lock.release(); }
  }
}

/** 后台页要显示的推送状态。 */
export async function pushStatus(): Promise<{
  configured: boolean;
  webhookHost: string | null;
  state: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastStatus: number | null;
    lastCount: number;
    lastError: string | null;
    pushedTotal: number;
    reconciledAt: string | null;
    reconciling: boolean;
  } | null;
}> {
  const row = await readState(channel());
  let webhookHost: string | null = null;
  try {
    const url = webhookUrl();
    webhookHost = url ? new URL(url).host : null;
  } catch {
    webhookHost = null;
  }
  return {
    configured: pushConfigured(),
    webhookHost,
    state: row
      ? {
          lastAttemptAt: iso(row.last_attempt_at),
          lastSuccessAt: iso(row.last_success_at),
          lastStatus: row.last_status,
          lastCount: Number(row.last_count),
          lastError: row.last_error,
          pushedTotal: Number(row.pushed_total),
          reconciledAt: iso(row.reconciled_at),
          reconciling: row.reconcile_cursor !== null,
        }
      : null,
  };
}

/** worker 注册的定时任务；没配 webhook 就不注册，后台也不会报错。 */
export const pushSchedule: Scheduled = {
  name: "stepx.push",
  cron: validCron(process.env.STEPX_PUSH_CRON),
  missed: "once",
  when: pushConfigured,
  async run() {
    const result = await pushPending();
    // 失败要能被“运行”页看到：抛出后 job_runs 会记下这次失败，告警也会带上。
    if (!result.ok) throw new Error(`stepx push failed: ${result.error ?? "unknown"}`);
    return result;
  },
};
