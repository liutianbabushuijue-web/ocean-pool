// stepx 同步的管理接口：给后台「海洋同步」页面用（web/admin-sync.tsx）。
//
// 为什么用第二把钥匙 ADMIN_SYNC_TOKEN：模块不能导入 apps/api 的 admin 会话实现（架构边界），
// 页面的 loader/action 在 web 进程里跑，由它转发一次，浏览器始终看不到真实密钥。
//
// 路由（都要 Bearer ADMIN_SYNC_TOKEN）：
//   GET  /api/stepx/admin/status    配置、条数、推送状态
//   POST /api/stepx/admin/test      试拉一页（拉模式）
//   POST /api/stepx/admin/push-now  立即推送一轮（推模式）
//   POST /api/stepx/admin/reset     游标失效后由管理员重建快照进度

import { config, credential } from "@aihot/backend/config";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bodyAllowed, readSeated, seatedCounts, toItem } from "./item.ts";
import { pushPending, pushStatus, resetPushCursor } from "./push.ts";
import { tokenMatches } from "./payload.ts";

/** 后台页面的管理密钥：没配就整组接口关闭（403），不会因为漏配而对外开放。 */
function adminToken(): string | null {
  return credential("integrations", "ADMIN_SYNC_TOKEN");
}

function bearer(req: FastifyRequest): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
}

function denied(reply: FastifyReply) {
  return reply.code(403).header("Cache-Control", "no-store").type("application/json; charset=utf-8")
    .send({ error: "forbidden", detail: "Set ADMIN_SYNC_TOKEN in .env and send it as a Bearer token." });
}

/** 页面上的配置只回显掩码，不回显明文。 */
function mask(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 拉一页，供 /test 用。 */
async function probe(limit: number) {
  const now = new Date();
  const rows = await readSeated(null, limit, "desc", now);
  const pageRows = rows.slice(0, limit).map((row) => toItem(row, bodyAllowed()));
  return {
    count: pageRows.length,
    sample: pageRows.map((item) => ({ title: item.title, sourceName: item.sourceName, publishedAt: item.publishedAt })),
  };
}

async function status() {
  const [counts, push] = await Promise.all([seatedCounts(), pushStatus()]);
  return {
    site: { name: config.siteUrl, apiVersion: "stepx.ocean.v1" },
    token: { present: Boolean(credential("integrations", "STEPX_TOKEN")), masked: mask(credential("integrations", "STEPX_TOKEN")) },
    includeBody: bodyAllowed(),
    adminTokenPresent: Boolean(adminToken()),
    counts,
    push,
  };
}

export function registerStepxAdminRoutes(app: FastifyInstance): void {
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    reply.header("Cache-Control", "no-store");
    const expected = adminToken();
    if (!expected || !tokenMatches(bearer(req), expected)) {
      denied(reply);
      return false;
    }
    return true;
  };

  app.get("/api/stepx/admin/status", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return status();
  });

  app.post("/api/stepx/admin/test", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const body = (req.body ?? {}) as { limit?: unknown };
    const limit = Math.min(20, Math.max(1, Math.floor(Number(body.limit) || 5)));
    return { ok: true, ...(await probe(limit)) };
  });

  app.post("/api/stepx/admin/push-now", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const body = (req.body ?? {}) as { maxPages?: unknown };
    const maxPages = Math.min(20, Math.max(1, Math.floor(Number(body.maxPages) || 5)));
    const result = await pushPending({ maxPages });
    return { ...result, syncStatus: await status() };
  });

  app.post("/api/stepx/admin/reset", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    if (!(await resetPushCursor())) return reply.code(409).send({ error: "sync_busy", detail: "推送正在运行，请完成后重试" });
    return { ok: true, note: "已重建快照进度。请运行立即推送，并在接收端核对历史条目的下架状态；此操作不删除内容、审核和会员数据。" };
  });

}
