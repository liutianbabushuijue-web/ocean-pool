// 后台「海洋同步」页：stepx 那边能用之前，先在这里确认「有内容可拉、token 对、拉得到」。
//
// 为什么把 token 留在服务器：loader/action 在 web 进程里跑，读 ADMIN_SYNC_TOKEN 后只用来转一次请求，
// 浏览器拿到的是状态与样例，不是密钥。页面上看不到、也复制不到真实 token。
//
// 类型说明：这里不引用 react-router 生成的 ./+types（模块页面的类型生成只覆盖接口路径，
// 用了会在 tsc 里报找不到模块）。loader / action / 组件的类型按运行时契约手写，行为不受影响。

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { API_BASE_URL } from "../../../apps/web/app/lib/api.server.ts";
import { adminSignedIn } from "../../../apps/web/app/lib/admin.server.ts";
import { SITE } from "@aihot/site";
import { AdminPage, Badge, Card, KV, Stat } from "../../../apps/web/app/features/admin/ui";

interface PushStatus {
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
}

interface SyncStatus {
  site: { name: string; apiVersion: string };
  token: { present: boolean; masked: string | null };
  includeBody: boolean;
  adminTokenPresent: boolean;
  counts: { selected: number; lastDay: number; oldest: string | null; newest: string | null };
  push: PushStatus;
}

interface Probe {
  ok: boolean;
  count: number;
  sample: Array<{ title: string; sourceName: string; publishedAt: string | null }>;
  error?: string;
}

interface PageData {
  status: SyncStatus | null;
  probe: Probe | null;
  error: string | null;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

function apiHeaders(request: Request): HeadersInit {
  const token = process.env.ADMIN_SYNC_TOKEN;
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "user-agent": request.headers.get("user-agent") ?? "",
  };
}

async function call<T>(request: Request, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: apiHeaders(request),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(path.endsWith("push-now") ? 180_000 : 30_000)]),
  });
  if (!res.ok) {
    let detail = `api ${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {
      // 不是 JSON
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<PageData> {
  if (!(await adminSignedIn(request))) return { status: null, probe: null, error: "请先登录后台" };
  try {
    const status = await call<SyncStatus>(request, "/api/stepx/admin/status", { method: "GET" });
    const probe = await call<Probe>(request, "/api/stepx/admin/test", { method: "POST", body: JSON.stringify({ limit: 3 }) });
    return { status, probe, error: null };
  } catch (error) {
    return { status: null, probe: null, error: (error as Error).message };
  }
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  if (!(await adminSignedIn(request))) return { ok: false, message: "请先登录后台" };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "test");
  try {
    if (intent === "reset") {
      const result = await call<{ note: string }>(request, "/api/stepx/admin/reset", { method: "POST", body: "{}" });
      return { ok: true, message: result.note };
    }
    if (intent === "push") {
      const result = await call<{ ok: boolean; pushed: number; status: number | null; error: string | null }>(request, "/api/stepx/admin/push-now", {
        method: "POST",
        body: JSON.stringify({ maxPages: 5 }),
      });
      return result.ok
        ? { ok: true, message: `推送成功：${result.pushed} 条${result.pushed === 0 ? "（没有新的）" : ""}` }
        : { ok: false, message: `推送失败：${result.error ?? `HTTP ${result.status}`}` };
    }
    const limit = Math.min(20, Math.max(1, Number(form.get("limit") ?? 5)));
    const probe = await call<Probe>(request, "/api/stepx/admin/test", { method: "POST", body: JSON.stringify({ limit }) });
    return { ok: true, message: `试拉成功：${probe.count} 条` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export const meta = () => [
  { title: `海洋同步 · ${SITE.name} 后台` },
  { name: "robots", content: "noindex, nofollow" },
];

export const headers = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export default function AdminSync({ loaderData, actionData }: { loaderData: PageData; actionData?: ActionResult }) {
  const fetcher = useFetcher<ActionResult>();
  const { status, probe, error } = loaderData;
  const message = fetcher.data?.message ?? actionData?.message;
  const failed = fetcher.data?.ok === false || actionData?.ok === false;

  return (
    <AdminPage
      title="海洋同步"
      subtitle="给 stepx 的同步出口：确认有内容可拉、token 生效、撤回会同步。契约见 docs/STEPX_INTEGRATION.md。"
    >
      {error && (
        <Card title="接口不可用">
          <p className="text-[13.5px] text-ink-2">{error}</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
            最常见的原因是 api 进程里没有 <code className="font-mono">ADMIN_SYNC_TOKEN</code>。在 <code className="font-mono">.env</code> 里加上并重启：
            <code className="ml-1 font-mono">docker compose up -d</code>。
          </p>
        </Card>
      )}

      {status && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="精选条目" value={status.counts.selected} hint="机器出口（同一事实只出一条）" />
            <Stat label="近 24 小时" value={status.counts.lastDay} />
            <Stat label="最新原文日期" value={status.counts.newest ? status.counts.newest.slice(0, 10) : "—"} />
            <Stat label="最早原文日期" value={status.counts.oldest ? status.counts.oldest.slice(0, 10) : "—"} />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card title="配置">
              <KV
                items={[
                  ["站点", status.site.name],
                  ["契约版本", status.site.apiVersion],
                  ["STEPX_TOKEN", status.token.present ? <Badge tone="ok">已配置 {status.token.masked}</Badge> : <Badge tone="bad">未配置</Badge>],
                  ["正文下发", status.includeBody ? <Badge tone="warn">开</Badge> : <Badge tone="muted">关（只给摘要）</Badge>],
                  ["管理密钥", status.adminTokenPresent ? <Badge tone="ok">已配置</Badge> : <Badge tone="bad">未配置</Badge>],
                ]}
              />
            </Card>

            <Card
              title="定时推送（stepx 没有定时器时用）"
              right={
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="push" />
                  <button type="submit" className="rounded-control bg-accent px-3 py-1 text-[13px] font-medium text-white">立即推送</button>
                </fetcher.Form>
              }
            >
              <KV
                items={[
                  ["状态", status.push.configured ? <Badge tone="ok">已配置</Badge> : <Badge tone="muted">未配置（只用拉模式）</Badge>],
                  ["Webhook", status.push.webhookHost ?? "—"],
                  ["上次成功", status.push.state?.lastSuccessAt ? new Date(status.push.state.lastSuccessAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—"],
                  ["上次结果", status.push.state?.lastStatus ? `${status.push.state.lastStatus} · ${status.push.state.lastCount} 条` : "—"],
                  ["累计投递", status.push.state ? `${status.push.state.pushedTotal} 条（含重核）` : "0 条"],
                  ["全量核对", status.push.state?.reconciledAt ? new Date(status.push.state.reconciledAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未完成"],
                  ["核对进度", status.push.state?.reconciling ? "正在分批核对" : "等待下次核对"],
                ]}
              />
              {status.push.state?.lastError && (
                <div className="mt-2">
                  <p className="text-[12px] leading-relaxed text-hot">上次错误：{status.push.state.lastError}</p>
                  <fetcher.Form method="post" className="mt-2">
                    <input type="hidden" name="intent" value="reset" />
                    <button type="submit" className="rounded-control border border-line px-3 py-1 text-[12px]">重建同步快照</button>
                  </fetcher.Form>
                  <p className="mt-1 text-[12px] text-ink-3">仅用于游标失效；重建后仍需在接收端核对历史下架状态。</p>
                </div>
              )}
              <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                配了 <code className="font-mono">STEPX_WEBHOOK_URL</code> 后，worker 每 <code className="font-mono">STEPX_PUSH_CRON</code>（默认 30 分钟）投递一次；投递失败游标不前进，下一轮重投同一批，stepx 按 externalId 去重。
              </p>
            </Card>
          </div>

          <Card
            title="试拉一页"
            right={
              <fetcher.Form method="post" className="flex items-center gap-2">
                <input type="hidden" name="intent" value="test" />
                <input name="limit" defaultValue="5" className="w-14 rounded-control border border-line bg-surface px-2 py-1 text-[13px]" aria-label="条数" />
                <button type="submit" className="rounded-control bg-ink px-3 py-1 text-[13px] font-medium text-bg">试拉</button>
              </fetcher.Form>
            }
          >
            {message && <p className={`mb-3 text-[13px] ${failed ? "text-hot" : "text-accent"}`}>{message}</p>}
            {probe && probe.sample.length > 0 ? (
              <ul className="space-y-2">
                {probe.sample.map((s) => (
                  <li key={s.title} className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-2 last:border-0">
                    <span className="text-[13.5px] text-ink">{s.title}</span>
                    <span className="shrink-0 text-[12px] text-ink-3">
                      {s.sourceName} · {s.publishedAt ? s.publishedAt.slice(0, 10) : "日期未知"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-3">
                还没有可拉的精选。新站第一次采集要 20–40 分钟；也可以先去「信源」页确认抓取成功。
              </p>
            )}
          </Card>

          <div className="mt-4">
            <Card title="接口与契约（给 stepx 的工程师）">
              <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2">
{`# 拉
GET ${status.site.name}/api/stepx/v1/items?limit=50
Authorization: Bearer <STEPX_TOKEN>
# 首次快照后保留 nextSince；以后继续带回它，含新增、更正与撤回
GET .../items?since=<nextSince>&limit=50
# 单条核对（撤回的返回 tombstone=true）
GET .../items/aihot:<articleId>

# 推（配置 STEPX_WEBHOOK_URL 后由 worker 定时投递）
POST <webhook>
X-Stepx-Timestamp: 1761...
X-Stepx-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)
body: { "schema": "stepx.ocean.v1", "generatedAt": "...", "count": N, "items": [...] }`}
              </pre>
            </Card>
          </div>

          <div className="mt-4">
            <Card title="配置与生效状态">
              <p className="text-[13px] leading-relaxed text-ink-2">
                同步配置保存在服务器环境变量中。更新 .env 后需重建 api、worker 和 web 服务，确保手动推送与定时推送使用同一配置。
                接收端地址变更后会重新发送快照；重复条目按 externalId 更新。
              </p>
              <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
                默认只同步摘要与原文链接。正文需要来源允许站内全文、明确允许再分发、条目正文状态允许以及部署方开启 STEPX_INCLUDE_BODY。
              </p>
            </Card>
          </div>
        </>
      )}
    </AdminPage>
  );
}
