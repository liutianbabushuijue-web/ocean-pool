// 复用引擎的快照与变更账本。文章发布时间只能排序，不能作为同步高水位：
// 更正、晚入选、撤回和代表稿更换都有自己的账本序号。
import { decodeCursor } from "@aihot/backend/lib/cursor";
import { selectedSnapshot, selectedChanges, SnapshotRequiredError } from "@aihot/backend/publication/v1";
import { bodyAllowed, readByIds, toItem } from "./item.ts";
import { tombstoneOf, type StepxEnvelope } from "./payload.ts";

export { SnapshotRequiredError };

export function syncPhase(since: string | null): "page" | "sync" {
  let kind = "page";
  if (since !== null) {
    try {
      kind = decodeCursor<{ k: string }>("ax1", since).k;
    } catch {
      throw new SnapshotRequiredError("旧版或无效游标；清空同步游标后重新读取完整快照");
    }
    if (kind !== "page" && kind !== "sync") throw new SnapshotRequiredError("未知同步游标");
  }

  return kind as "page" | "sync";
}

export async function readSyncPage(since: string | null, limit: number, now = new Date()): Promise<StepxEnvelope> {
  if (syncPhase(since) === "page") {
    const snapshot = await selectedSnapshot({ page: since, limit }, now);
    const ids = snapshot.items.map((item) => item.id);
    const rows = new Map((await readByIds(ids, now)).map((row) => [row.id, row]));
    const items = ids.map((id) => rows.has(id) ? toItem(rows.get(id)!, bodyAllowed()) : tombstoneOf(id, now));
    return {
      schema: "stepx.ocean.v1", generatedAt: now.toISOString(),
      nextSince: snapshot.nextPage ?? snapshot.cursor, hasMore: snapshot.hasMore,
      count: items.length, items,
    };
  }

  const changes = await selectedChanges({ cursor: since!, limit }, now);
  const ids = changes.changes.flatMap((change) => change.op === "upsert" ? [change.item.id] : []);
  const rows = new Map((await readByIds(ids, now)).map((row) => [row.id, row]));
  const items = changes.changes.map((change) => {
    const id = change.op === "remove" ? change.id : change.item.id;
    const row = rows.get(id);
    if (change.op === "remove" || !row) return tombstoneOf(id, new Date(change.changedAt));
    return toItem(row, bodyAllowed());
  });
  return {
    schema: "stepx.ocean.v1", generatedAt: now.toISOString(),
    nextSince: changes.cursor, hasMore: changes.hasMore, count: items.length, items,
  };
}
