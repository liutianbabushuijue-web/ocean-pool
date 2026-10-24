# AIHOT × stepx：海洋内容同步与验收

AIHOT 负责采集、筛选、中文标题与摘要；stepx 保存内容、审核并使用现有会员权限。本文是接口约定与实施参考；文中示例不代表云函数已经部署、真实字段已经对齐或端到端联调已经通过。

## 1. 数据怎么走

```
AIHOT 公开精选 → 首次快照 → 后续变更账本
       ├── 拉：stepx 调 GET /api/stepx/v1/items
       └── 推：AIHOT worker POST 到 stepx webhook
                       ↓
stepx：按 externalId 幂等保存，新条目 pending
                       ↓
运营核对 → published → App 按会员权限读取
```

拉取需要 stepx 的平台定时器；推送使用 AIHOT 常驻 worker，stepx 只需接收 webhook。两者使用同一套快照/变更协议，不能用管理员浏览器会话充当长期定时凭据。建议先手动拉通少量真实数据，再接自动推送。

```bash
# AIHOT .env；生产 webhook 使用 HTTPS
STEPX_WEBHOOK_URL=https://你的-stepx-云函数地址
STEPX_WEBHOOK_SECRET=与接收端一致的密钥
STEPX_PUSH_CRON=*/30 * * * *
```

未设置专用 webhook 密钥时，发送端可复用 `STEPX_TOKEN`；接收端必须使用同一把实际生效的密钥。建议显式配置专用密钥。修改环境变量后运行 `docker compose up -d --force-recreate api worker web`；单纯 restart 不会重新读取 Compose 的 env_file。

发送端每页只有收到 2xx 后才提交持久游标；网络错误、非 2xx 或超时会重试。接收端必须允许重复投递。重试不保证原始 JSON 字节、签名和生成时间相同，幂等身份使用 `externalId`。

## 2. 拉取接口与游标

```http
GET /api/stepx/v1/items?limit=100
Authorization: Bearer <STEPX_TOKEN>
```

首次不传 `since`，服务器建立公开精选快照；后续原样带回响应的 `nextSince`：

```http
GET /api/stepx/v1/items?since=<nextSince>&limit=100
Authorization: Bearer <STEPX_TOKEN>
```

| 参数 | 约定 |
|---|---|
| `limit` | 1–200，默认 50 |
| `since` | 不透明的 `ax1` 游标。客户端不得解析、拼接时间或自行增减 |
| `nextSince` | 本页成功保存后才持久化；即使 `hasMore=false` 也要保存 |
| `hasMore` | true 时继续拉页；false 时结束本轮，下轮仍从已保存的 nextSince 继续 |

首次快照完成后，同一游标协议切换到内置精选变更账本。新增、更正、撤回及代表稿变更从账本续传，不再把文章原始时间当成增量水位。保存内容和推进游标应在接收端同一事务中完成。

旧版 `timeline_at|article_id` 游标不兼容；服务器返回 HTTP 409、`snapshot_required` 时，保留本地审核与人工内容，清除同步游标后重新快照并按 externalId 对账，不能把它当成空页或静默跳过。快照失效等需要重建快照的情况也按这个恢复流程处理。

响应结构保持 `stepx.ocean.v1`：

```json
{
  "schema": "stepx.ocean.v1",
  "generatedAt": "2026-10-23T00:00:00.000Z",
  "nextSince": "<服务器返回的不透明 ax1 游标>",
  "hasMore": false,
  "count": 1,
  "items": [{
    "externalId": "aihot:example",
    "sourceItemId": "example",
    "tombstone": false,
    "title": "海洋知识条目示例",
    "summary": "中文摘要",
    "originalTitle": "Original title",
    "language": "en",
    "sourceName": "来源机构",
    "originalUrl": "https://example.org/article",
    "aihotUrl": "https://你的域名/item/example",
    "publishedAt": "2026-10-22T13:00:00.000Z",
    "updatedAt": "2026-10-23T00:00:00.000Z",
    "category": "climate",
    "tags": [],
    "score": 71,
    "reason": null,
    "storyId": null,
    "storyTitle": null,
    "bodyText": null,
    "author": null
  }]
}
```

示例不是实际可重放的游标，也不是线上实测条目。空页不等于从头重拉，始终遵守服务器返回的 nextSince。

### 单条核对与签名响应

```http
GET /api/stepx/v1/items/aihot:<article_id>
Authorization: Bearer <STEPX_TOKEN>
```

返回 `{schema, item}`；不存在或已不在公开精选范围的条目返回 200 与 `tombstone=true`。接收端软下架并保留审核记录。

`GET /api/stepx/v1/outbox` 提供同一分页协议的签名响应，签名使用 `STEPX_TOKEN`；主动 webhook 使用 `STEPX_WEBHOOK_SECRET`（未设时回退 STEPX_TOKEN），不要混淆两者。

### 当前账本范围与周期对账

主要新增、标题/摘要更正、撤回与代表稿变化由精选账本覆盖。仅 tags、story、body 或来源全文许可等扩展字段变化时，可能不产生账本事件；不能承诺每项扩展字段都即时同步。默认正文关闭。

主动 push 另维护 reconcile_cursor 与 reconciled_at：距离上次完成对账达到 24 小时后，使用独立游标重新扫描当前精选。每轮先追账本增量，再用剩余 maxPages 预算续传对账快照，绝不覆盖主 sync_cursor。积压或接收失败会延后对账完成，24 小时是触发间隔，不是全部字段更新时限。

拉模式接收端需自己安排周期完整快照对账，建议每日启动并监测完成时间。独立保存对账游标，主增量游标继续保留；完整成功后才判定本地哪些上游条目应下架，不能根据失败或未完成的部分快照批量删除。对账与增量写入需串行或按版本协调，防止旧快照复活刚撤回的内容。

接收端不能只用 updatedAt 严格增大才接受所有字段：未记账的扩展字段可能保持同一版本时间。完整对账应允许同版本刷新扩展字段，并对撤回、重新公开等可见性变化做最新状态核对。是否真正补齐须以接收端入库结果验收。

## 3. 字段与 stepx 存储

| 字段 | 类型与含义 |
|---|---|
| `externalId` | string，`aihot:<article_id>`；唯一幂等键 |
| `sourceItemId` | string，AIHOT 原始 article_id |
| `tombstone` | boolean；true 时软下架，其他展示字段可为 null 或空 |
| `title` / `summary` | 中文标题 / 摘要；撤回时为 null，摘要本身也可为空 |
| `originalTitle` / `language` | 原文标题 / 语言，可为空 |
| `sourceName` / `originalUrl` | 正常条目必须有来源名 / 原文链接；前端必须可点击原文 |
| `aihotUrl` | 审核员对照页 |
| `publishedAt` | 原文发布日期，可为空；UTC 保存，按 Asia/Shanghai 展示 |
| `updatedAt` | 同步版本的更新时间，包含更正；不得替代原文日期或本地审核时间 |
| `category` / `tags` | 分类 key / 标签数组 |
| `score` / `reason` | 评分 / 推荐理由；评分用于排序，不覆盖人工审核结论 |
| `storyId` / `storyTitle` | 事件聚合标识 / 标题，可为空 |
| `bodyText` | 默认 null；仅在部署启用 STEPX_INCLUDE_BODY、来源明确允许再分发、条目 syndicate 允许且 body_mode=full 时提供 |
| `author` | 署名或机构，可为空 |

分类为 `physical` 物理海洋、`climate` 海洋与气候、`biology` 生物与生态、`chemistry` 海洋化学、`policy` 政策与治理、`engineering` 工程技术、`deepsea` 深海与极地、`fisheries` 渔业与蓝色经济。stepx 得到细分类原值；AIHOT 公开 /api/v1 的部分分类可能合并，不能直接拿其 tab 做一对一映射。

当前项目的实际表名、幂等字段和审核值见文末「实际落地记录」。接入其他项目时重新核对这些字段，并按同一星球范围建立 externalId 唯一约束，不能直接套用本项目字段。

新条目一律 pending，App 端不可见；更正保留人工备注，正文或结论发生实质变化时重新审核；tombstone 下架。来源再分发许可撤销后，全量对账的 bodyText=null 必须覆盖已存旧正文，不能因为 null 就保留旧值。后续旧批次重投不得覆盖更高版本或复活已撤回条目。恢复公开也必须遵守审核策略，不能机械地把 removed 永久锁死或直接发布。

会员判断继续使用 stepx 现有的 `is_planet_member()` 与数据库权限。只在前端隐藏按钮不足以保护内容，需实测访客、非会员、会员与管理员的读取范围。

## 4. webhook 验签与可靠接收

签名为 HMAC-SHA256(secret, timestamp + "." + rawBody)，头为 `X-Stepx-Timestamp` 与 `X-Stepx-Signature: sha256=<hex>`。必须在 JSON.parse 前使用收到的原始字节验签；不能重新 JSON.stringify 已解析的对象。

下面的 Node 参考适配需要接入平台提供的原始请求体 API；没有 rawBody 就拒绝请求并修复平台配置：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export async function receive(req) {
  const secret = process.env.STEPX_WEBHOOK_SECRET ?? process.env.STEPX_TOKEN;
  if (!secret) return { status: 503 };

  const input = req.rawBody ?? req.body;
  const raw = Buffer.isBuffer(input)
    ? input
    : typeof input === "string" ? Buffer.from(input, "utf8") : null;
  if (!raw) return { status: 400, body: { error: "raw_body_required" } };

  const tsText = String(req.headers["x-stepx-timestamp"] ?? "");
  if (!/^\d{1,12}$/.test(tsText)) return { status: 401 };
  const ts = Number(tsText);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return { status: 401 };

  const digest = createHmac("sha256", secret)
    .update(tsText + ".").update(raw).digest("hex");
  const expected = Buffer.from("sha256=" + digest);
  const given = Buffer.from(String(req.headers["x-stepx-signature"] ?? ""));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { status: 401 };
  }

  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { return { status: 400 }; }
  if (body.schema !== "stepx.ocean.v1" || !Array.isArray(body.items)) {
    return { status: 400 };
  }
  // 按实际 schema 校验每个条目；错误批次返回非 2xx。
  // persistBatch 必须实现幂等、版本比较、审核策略与事务。
  await persistBatch(body.items);
  return { status: 200, body: { ok: true, received: body.items.length } };
}
```

`persistBatch` 是待实现的持久化步骤，不是平台内置函数。返回 2xx 的前提是整批事务提交，或整批已可靠写入持久队列。禁止先返回 200 再在易被终止的函数进程中异步写库。采用队列时需消费者重试、失败告警和最终入库监测，不能只看发送端成功。

单次投递应在 30 秒内确认；超时后会重投。时间戳窗口限制重放时间，externalId 与版本比较保证重复处理安全。

## 5. 拉取接收端的处理顺序

1. 从持久 sync_state 读取游标，使用服务器凭据发起请求。
2. 非 2xx 失败并保留游标；409 snapshot_required 进入重建快照流程。
3. 检查 schema、items、count、nextSince 等基础结构。
4. 在事务内逐条幂等写入：新条目 pending，撤回软下架，旧版本不覆盖新版本。
5. 同一事务保存 nextSince。hasMore=true 继续；false 结束本轮。
6. 记录最后成功时间、游标状态、各类变更数与错误；连续失败告警。

定时任务与手动同步不可同时无锁更新同一游标。实际数据库实现需提供事务、唯一约束与必要的任务互斥，本文不再用假定的表名冒充可直接部署的 SQL。

## 6. 验收与证据

接口基础检查器在交付根目录和 ocean-pack 的 `tools/stepx_contract_check.py` 各有同一份。站点已部署后可运行：

```bash
cd /srv/ocean-bundle
python3 tools/stepx_contract_check.py --base https://你的域名 --token-env STEPX_TOKEN
```

其 self-test 使用本地假服务，只证明检查器自身；真实地址运行也只提供脚本覆盖到的接口契约证据。不能仅凭“全部 PASS”宣布数据库、webhook、会员权限或自动化服务全部跑通，完整翻页和新增/更新/撤回能力需要以下业务验收。

### 在现有内容上联调的边界

先只读保存内容 ID、审核状态、来源标识、人工编辑字段与推拉游标的基线，并确认本机来源与现有条目的归属。54 条演示资料不能当作生产内容导入。不要向真实接收端发送有效的空完整快照来测试连通，它可能触发按来源收口并下架原有条目；仅给测试条目换一个 ID 前缀也不能隔离全量收口范围。

配对密钥后的第一步可以发送「签名正确但 schema 明确无效」的原始 JSON，预期 400；对同一字节测试错误签名、过期和篡改，预期 401，并核对前后内容与游标不变。真正的 2xx 入库使用经核实的真实来源条目，先进入待审核，再重放同一批确认幂等。新增、更正、撤回、恢复、分页失败和并发故障测试放在独立接收环境，不能通过修改现有公开内容制造测试。

以下清单区分生产只读检查与隔离环境中的写入/故障验收，逐项记录环境、输入和证据。

- [ ] 首次快照完整入库；相同批次重放条目数不增，待审核不可见。
- [ ] 快照结束后新增一条，下一轮从原游标收到，不靠从头扫描。
- [ ] 更正已同步标题/摘要，下一轮更新；原文日期保持不变。
- [ ] 撤回超过 7 天的老条目及更换事件代表稿，30 分钟同步周期下 App 在约定时限内不可见旧内容。
- [ ] 单条核对不存在/已撤回内容返回 tombstone；增量流也收到真实撤回事件。
- [ ] 原始字节验签；错密钥、缺签名、过期时间戳、篡改正文均拒绝。
- [ ] 部分失败、超时重投、进程重启后恢复，无漏条；每页持久确认后才推进游标。
- [ ] 409 触发完整重建快照，保留人工备注和审核状态，完成前不批量下架。
- [ ] 每条来源和原文链接可核对；访客/非会员/会员/管理员权限实测通过。
- [ ] 完整对账能补齐 tags/story/body 等扩展字段变化。
- [ ] 推送状态、接收端持久入库数和 App 实际可见状态三方一致。

`/admin/sync` 保留状态、试拉与立即推送，临时配置保存表单及 admin/config 写接口已移除。正式配置统一写入受保护的 .env 并重建 api/worker；ADMIN_SYNC_TOKEN 变化时还需重建 web。状态页正常不代表接收端已可靠落库。

升级迁移 0091 添加主同步游标，0092/0093 丢弃旧 timeline_at/article_id 推送进度，0094/0095 添加独立对账状态。升级后重新发送首次快照，不删除内容、审核或会员数据；接收端必须在重放时保留人工字段并按 externalId 去重。

## 7. 运营边界

AIHOT 公开站、RSS、API 仍可免费阅读。stepx 付费价值来自人工解读、审核、专题组织、归档与课程服务；不能把相同摘要包装成内容独占。正文默认关闭，开放获取不等于可以任意再分发。

密钥只在服务器保存，不进前端、仓库或日志。来源、联系方式、运营主体、收费与退款规则需与实际服务一致。上线前由运营者确认，不能用示例占位信息替代。

## 2026-10-23 stepx 实际落地记录

当前项目 p_a7282b6bcf38ea84 的预览已完成第 10/11 轮改造（版本 f427057、e78d4b6）。这份记录依据实际浏览器中的项目文件与构建回报，不把模拟测试当成外网联调。

- 内容表使用 planet_topics，幂等字段 external_id；撤回使用 is_removed。实际已审核值为 approved，本文流程图中的 published 是逻辑状态，适配时以 stepx 源码字段为准。
- 入口为 ocean-sync（管理员拉取）与 ocean-webhook（HMAC 推送）。共用 _shared/ocean-sync-core.mjs、_shared/ocean-sync.ts 和事务 RPC ocean_apply_page。
- 来源摘要与全文分别存 external_summary、external_body；bodyText=null 清外部全文，summary=null 只触发展示回退。
- 已审核来源更正进入 ocean_topic_revisions，保留人工编辑，待运营核对采纳。
- webhook 不推进 ocean_sync_settings.cursor，只保存独立的投递信息；拉取维护自己的 cursor。完整快照成功后 ocean_finish_snapshot 在同一事务中推进游标并只对本来源收口核对；失败不能批量下架。
- 新迁移为 20261023230000_ocean_sync_reliability.sql 与 20261024000000_ocean_sync_fencing.sql。后者修正正文语义、版本栅栏与租约持有者校验，保留已执行迁移。
- stepx 报告 test:ocean-sync 24/24、类型检查及构建通过；真实匿名访问已检查部分拒绝行为。普通会员身份、事务故障注入及真实 AIHOT 外网联调仍需验证。
- 内置浏览器此前显示「没有后台权限」。用户报告同一手机号在 Edge 可以进入后台；两个浏览器的应用会话、身份规范化和后台入口是否一致仍需实际核对，不能据此认定用户没有管理员权限。

用户当前要求全部免费，未来 9.9 元/月，会员与订单继续只在 stepx。以上不是已收费或已无人值守上线的声明。

第12轮（ef3bab8）补充：实际 webhook 地址为 `https://br-blush-ling-89556b2c.supabase.aidap-global.cn-shanghai.volces.com/functions/v1/a7282b6bcf38-ocean-webhook`。独立未签名 POST 实测 503 secret_not_configured，表明路由可达但尚未配置密钥，不能视为联调成功。原有模板订阅人数已确认并改为真实内容数/会员聚合，新增迁移 20261024120000_honest_member_counts.sql。新列与内部 RPC 的匿名拒绝行为已在真实后端读取核对；普通会员会话仍需管理员登录后验证。
