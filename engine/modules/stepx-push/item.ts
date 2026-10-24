// 精选条目的读取与映射：拉取接口（server.ts）和定时推送（push.ts）共用同一份，
// 避免两个出口对同一条给出不同字段。
import { sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { ITEM_COLUMNS, ITEM_FROM } from "@aihot/backend/publication/items";
import { seatedCondition } from "@aihot/backend/publication/scope";
import { externalIdOf, iso, type StepxItem } from "./payload.ts";

/** 一行查询结果：ITEM_COLUMNS 的字段 + 来源全文许可与正文。 */
export interface Row {
  id: string;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[] | null;
  score: string | number | null;
  selected: boolean;
  seat: boolean;
  channel: string;
  url: string;
  published_at: Date | string | null;
  discovered_at: Date | string;
  timeline_at: Date | string;
  visibility: string;
  body_mode: string;
  syndicate: boolean;
  source_syndicate_fulltext: boolean;
  updated_at: Date | string;
  indexable: boolean;
  fact_id: number | null;
  source_name: string;
  source_mode: string;
  x_post: Record<string, unknown> | null;
  author: string | null;
  language: string | null;
  story_public_id: string | null;
  story_title: string | null;
  zh_text: string | null;
  quoted_zh: string | null;
  source_fulltext: boolean;
  body_text: string | null;
}

/** 部署方确认可以把正文再分发给 stepx；默认关，和 AIHOT 公开页的许可一致。 */
export function bodyAllowed(): boolean {
  return process.env.STEPX_INCLUDE_BODY === "true";
}

export function toItem(row: Row, withBody: boolean): StepxItem {
  // 两份许可同时成立才给正文：来源明确允许站内全文（sources.site_fulltext）＋ 部署方确认可转授。
  const bodyText = withBody && row.source_fulltext && row.source_syndicate_fulltext && row.syndicate && row.body_mode === "full" ? row.body_text : null;
  return {
    externalId: externalIdOf(row.id),
    sourceItemId: row.id,
    tombstone: false,
    title: row.title,
    summary: row.summary,
    originalTitle: row.original_title,
    language: row.language,
    sourceName: row.source_name,
    originalUrl: row.url,
    aihotUrl: `${config.siteUrl}/item/${row.id}`,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) ?? iso(row.timeline_at)!,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    score: row.score === null || row.score === undefined ? null : Math.round(Number(row.score)),
    reason: row.reason,
    storyId: row.story_public_id,
    storyTitle: row.story_title,
    bodyText,
    author: row.author,
  };
}

/** 每次查询共用的列：正文只在来源允许时才取，减少无用 IO。 */
export const PAGE_COLUMNS = sql`${ITEM_COLUMNS},
  p.updated_at, p.syndicate, s.syndicate_fulltext AS source_syndicate_fulltext,
  s.site_fulltext AS source_fulltext,
  CASE WHEN s.site_fulltext AND s.syndicate_fulltext AND p.syndicate AND p.body_mode = 'full' THEN a.body_text ELSE NULL END AS body_text`;

/** 时间线预览查询，仅供管理页试拉；真实同步进度由 sync.ts 的快照与账本负责。 */
export async function readSeated(
  since: { at: Date; id: string } | null,
  limit: number,
  order: "asc" | "desc",
  now = new Date(),
): Promise<Row[]> {
  const after = since
    ? sql`AND (p.timeline_at, p.article_id) ${order === "asc" ? sql`>` : sql`<`} (${since.at}, ${since.id})`
    : sql``;
  const direction = order === "asc" ? sql`ASC` : sql`DESC`;
  return sql<Row[]>`
    SELECT ${PAGE_COLUMNS}
    ${ITEM_FROM}
    WHERE ${seatedCondition(now)} ${after}
    ORDER BY p.timeline_at ${direction}, p.article_id ${direction}
    LIMIT ${limit + 1}`;
}

/** 单条：核对接口用；撤回或未精选时返回 null（调用方转成 tombstone）。 */
export async function readOne(articleId: string, now = new Date()): Promise<Row | null> {
  const rows = await sql<Row[]>`
    SELECT ${PAGE_COLUMNS}
    ${ITEM_FROM}
    WHERE p.article_id = ${articleId} AND ${seatedCondition(now)}
    LIMIT 1`;
  return rows[0] ?? null;
}

/** 补齐账本的海洋扩展字段；仍由唯一公开读取层决定当前是否可以分发。 */
export async function readByIds(ids: string[], now = new Date()): Promise<Row[]> {
  if (ids.length === 0) return [];
  return sql<Row[]>`
    SELECT ${PAGE_COLUMNS} ${ITEM_FROM}
    WHERE p.article_id IN ${sql([...new Set(ids)])} AND ${seatedCondition(now)}`;
}

/** 统计：给后台页与运维日报用。 */
export async function seatedCounts(now = new Date()): Promise<{ selected: number; lastDay: number; oldest: string | null; newest: string | null }> {
  const [row] = await sql<Array<{ selected: number; last_day: number; oldest: Date | string | null; newest: Date | string | null }>>`
    SELECT count(*)::int AS selected,
           count(*) FILTER (WHERE p.timeline_at > now() - interval '24 hours')::int AS last_day,
           min(p.published_at) AS oldest,
           max(p.published_at) AS newest
    FROM publications p
    WHERE ${seatedCondition(now)}`;
  return {
    selected: Number(row?.selected ?? 0),
    lastDay: Number(row?.last_day ?? 0),
    oldest: row?.oldest ? new Date(row.oldest).toISOString() : null,
    newest: row?.newest ? new Date(row.newest).toISOString() : null,
  };
}
