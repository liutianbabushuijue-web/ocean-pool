#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成一份「示例条目」JSON，用于 stepx 侧联调 / 演示，不连数据库、不调模型。

它做的事：把 ocean-pack/industry/sources.json 里每条信源的最新 1–2 条真实条目抓下来，
整理成与 /api/stepx/v1/items 完全相同的字段结构（摘要位置留空，由你或模型补）。

为什么需要它：
  - stepx 侧可以在 AIHOT 还没跑起来时先把「条目表 + 审核页 + App 列表」做出来；
  - 演示时不用等 30 分钟冷启动；
  - 字段契约有任何歧义，以这份文件为准对一遍。

用法：
  python tools/make_demo_entries.py --limit 2 --out ocean-pack/demo-entries.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_sources as vs  # noqa: E402  复用同一套抓取与字段映射


def article_id(url: str) -> str:
    """与 AIHOT 的 article id 形态接近：可读前缀 + 短哈希，仅用于演示。"""
    return "demo-" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser(description="生成演示用条目 JSON")
    ap.add_argument("--limit", type=int, default=2, help="每条信源取几条")
    ap.add_argument("--out", type=Path, default=HERE.parent / "ocean-pack" / "demo-entries.json")
    ap.add_argument("--source", default=None, help="只取某个信源 id")
    args = ap.parse_args()

    sources = vs.SRC if args.source is None else [s for s in vs.SRC if s["id"] == args.source]
    items: list[dict] = []
    seen: set[str] = set()
    for src in sources:
        r = vs.verify(src)
        if not r.ok:
            print(f"skip {src['id']}: {r.error}", file=sys.stderr)
            continue
        for f in r.findings[: args.limit]:
            if not f.url or f.url in seen:
                continue
            seen.add(f.url)
            aid = article_id(f.url)
            items.append({
                "externalId": f"aihot:{aid}",
                "sourceItemId": aid,
                "tombstone": False,
                "title": f.title,
                "summary": None,
                "originalTitle": None,
                "language": "en",
                "sourceName": src["name"],
                "originalUrl": f.url,
                "aihotUrl": f"http://localhost:3000/item/{aid}",
                "publishedAt": f.published.isoformat().replace("+00:00", "Z") if f.published else None,
                "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "category": None,
                "tags": src.get("tags", []),
                "score": None,
                "reason": None,
                "storyId": None,
                "storyTitle": None,
                "bodyText": None,
                "author": None,
                "_demo": {"sourceId": src["id"], "tier": src["tier"]},
            })
        print(f"{src['id']:<40} +{min(args.limit, len(r.findings))}")

    payload = {
        "$comment": (
            "演示用条目。字段与 GET /api/stepx/v1/items 的 items[] 完全一致；summary/category/score 为 null 是因为"
            "这里没有调模型。stepx 侧联调时按这份结构写 upsert，正式环境换成真实接口即可。"
        ),
        "schema": "stepx.ocean.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(items),
        "items": items,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n写入 {args.out}（{len(items)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
