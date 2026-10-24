// stepx 推送契约：把 AIHOT 的“精选条目”变成一个与 stepx 条目表一一对应的 JSON。
//
// 设计原则（与 stepx 那边的约定，改字段就是改契约，必须同步升级 interfaceVersion）：
//   1. 只推“机器出口的精选”，即 publication/scope.ts 的 seatedCondition：同一事实只出一条代表稿。
//      这样 stepx 的条目表不会出现同一件事三条稿，审核员也不用自己去重。
//   2. 幂等键 externalId = "aihot:<article_id>"。article_id 是 AIHOT 自己的主键，永不变；
//      stepx 侧用它做唯一索引，重推不会产生第二条。
//   3. 撤回也是数据：tombstone=true 且只有 id。stepx 收到后把这条下架（软删），不要物理删除。
//   4. 正文不下发，除非来源允许站内全文与再分发、条目许可允许且部署方设置 STEPX_INCLUDE_BODY=true。
//      默认只给摘要 + 原文链接，和 AIHOT 自己的公开页一致。
//   5. 时间一律 ISO 8601 UTC；按 publishedAt 展示，增量只续传 nextSince 账本游标。

import { createHmac, timingSafeEqual } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

/** 一条要推给 stepx 的条目。字段名刻意用 camelCase，和 stepx 现有条目表的映射写在 docs/STEPX_INTEGRATION.md。 */
export interface StepxItem {
  /** 幂等键："aihot:<article_id>"。stepx 侧唯一索引。 */
  externalId: string;
  /** 兼容字段：去掉前缀的 article_id，排查问题时用。 */
  sourceItemId: string;
  /** 撤回标记：true 时除 externalId/sourceItemId/updatedAt 外的字段都为 null 或空。 */
  tombstone: boolean;
  title: string | null;
  /** AIHOT 写的中文摘要。 */
  summary: string | null;
  /** 原文标题（外文时与 title 不同）。 */
  originalTitle: string | null;
  /** 原文语言，BCP 47，例如 "en"、"zh"。 */
  language: string | null;
  sourceName: string | null;
  /** 原文链接。 */
  originalUrl: string | null;
  /** AIHOT 条目页，审核员对照用。 */
  aihotUrl: string | null;
  /** 原文发布日期，ISO 8601；没有可信日期时为 null（这类条目 AIHOT 也不会公开，正常不会出现）。 */
  publishedAt: string | null;
  /** 本条内容最近更正的时间；同步进度仍以 nextSince 为准。 */
  updatedAt: string;
  /** 海洋类别 key（physical / climate / …），见 industry/taxonomy.ts 的 CATEGORIES。 */
  category: string | null;
  tags: string[];
  /** 两次独立评分的平均分，0–100。stepx 可以据此排序，不要据此改精选结论。 */
  score: number | null;
  /** 推荐理由，AIHOT 卡片上显示的那句。 */
  reason: string | null;
  /** 事件（同一件事的聚合）标识与综述，stepx 做“专题”时用。 */
  storyId: string | null;
  storyTitle: string | null;
  /** 正文纯文本；只有 STEPX_INCLUDE_BODY=true 且来源允许全文时才非空。 */
  bodyText: string | null;
  /** 署名/机构，来源缺失时为 null。 */
  author: string | null;
}

export interface StepxEnvelope {
  /** 契约版本；字段语义变了就升，stepx 侧按版本分支。 */
  schema: "stepx.ocean.v1";
  /** 这次响应的生成时间。 */
  generatedAt: string;
  /** 本页最后一条的游标，下一页原样带回；本页为空时为 null。 */
  nextSince: string | null;
  /** 本页之后还有没有。 */
  hasMore: boolean;
  /** 本页条数。 */
  count: number;
  items: StepxItem[];
}

/** 幂等键前缀：同一条推送以后要能认出“这是我推的”。 */
export const EXTERNAL_PREFIX = "aihot:";

export function externalIdOf(articleId: string): string {
  return `${EXTERNAL_PREFIX}${articleId}`;
}

export function articleIdOf(externalId: string): string | null {
  return externalId.startsWith(EXTERNAL_PREFIX) ? externalId.slice(EXTERNAL_PREFIX.length) : null;
}

/** 撤回条目：只保留身份与时间，其余字段清空，避免 stepx 侧继续展示旧摘要。 */
export function tombstoneOf(articleId: string, updatedAt: Date): StepxItem {
  return {
    externalId: externalIdOf(articleId),
    sourceItemId: articleId,
    tombstone: true,
    title: null,
    summary: null,
    originalTitle: null,
    language: null,
    sourceName: null,
    originalUrl: null,
    aihotUrl: null,
    publishedAt: null,
    updatedAt: updatedAt.toISOString(),
    category: null,
    tags: [],
    score: null,
    reason: null,
    storyId: null,
    storyTitle: null,
    bodyText: null,
    author: null,
  };
}

/**
 * 签名：stepx 的云函数收到推送（outbound 模式）时校验。
 * 只签 rawBody + timestamp，避免 JSON 重新序列化导致签名对不上。
 * 头：X-Stepx-Timestamp（unix 秒）、X-Stepx-Signature（sha256=hex）。
 */
export function sign(rawBody: string, timestamp: number, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** 常数时间比较；长度不同直接 false，不泄露长度以外的信息。 */
export function verifies(rawBody: string, timestamp: number, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(rawBody, timestamp, secret));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 时间戳容差：防重放。5 分钟对一天一次的定时任务足够。 */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** 游标：timeline_at 毫秒 + article_id，按这个顺序翻页，避免同一毫秒的条目被跳过。 */
export function encodeCursor(timelineAt: Date, articleId: string): string {
  return Buffer.from(`${timelineAt.getTime()}|${articleId}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    // Buffer 的 base64 解码会忽略非法字符；只接受 encodeCursor 生成的规范形式。
    if (!/^[a-zA-Z0-9_-]+$/.test(cursor)) return null;
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return null;
    const match = /^(-?\d+)\|([a-zA-Z0-9_-]{1,80})$/.exec(bytes.toString("utf8"));
    if (!match) return null;
    const ms = Number(match[1]);
    const date = new Date(ms);
    if (!Number.isSafeInteger(ms) || !Number.isFinite(date.getTime())) return null;
    return { at: date, id: match[2]! };
  } catch {
    return null;
  }
}

/** 常量时间比较 token；空值一律拒绝（避免没配 token 就对外开放）。 */
export function tokenMatches(given: string | undefined, expected: string | null): boolean {
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SQL 里 text 类型的时间戳转成 ISO；null 原样返回。 */
export function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 5 段式 cron 的保守校验：只接受数字与星号、斜杠、逗号、连字符，
 * 复用 pg-boss 的 cron-parser 校验每一段的范围、步长和日期组合。
 * 坏表达式回退到默认值——pg-boss 收到坏 cron 会让 worker 起不来，宁可静默降级。
 */
export function validCron(expression: string | undefined, fallback = "*/30 * * * *"): string {
  const value = (expression ?? "").trim();
  if (!/^\S+ \S+ \S+ \S+ \S+$/.test(value)) return fallback;
  if (!/^[\d*/,\-\s]+$/.test(value)) return fallback;
  try {
    CronExpressionParser.parse(value, { tz: "UTC", strict: false });
    return value;
  } catch {
    return fallback;
  }
}
