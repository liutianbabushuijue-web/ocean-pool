#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中文海洋一手信源的采集器：抓列表 → 抓正文 → 推给 AIHOT 的 /api/ingest/items。

为什么中文源单独写：
  AIHOT 的 RSS / JSON 采集器要求结构化列表；自然资源部、国家海洋信息中心、中国海洋大学新闻网、
  中科院海洋所这些站没有 RSS，页面是 jQuery 模板，CSS 选择器一改就全废。
  但它们的列表页都有稳定的 URL 规律（t20261022_2940884.html、/c/2026-09-07/85811.shtml、
  /2026/1021/c91a122954/page.htm），正文容器也有固定 id（#doccon、#zoom、.bodytext）。
  所以这里用「URL 正则 + 正文容器」两个参数适配一个站，新增一个站只加一段配置。

推送走 AIHOT 自己的 ingest 接口（external 信源，Bearer INGEST_TOKEN）：
  - 判重、发布时间窗口、旧文归档、后续处理全部由 AIHOT 负责，这里不重复实现；
  - 每条都带上正文纯文本，AIHOT 会直接用它做分析，不必再抓一次原文；
  - 外部推送默认按原文时间归档，不会把三年前的旧稿灌进“今天”。

用法：
  export AIHOT_BASE=http://localhost:3000
  export INGEST_TOKEN=<.env 里的 INGEST_TOKEN>
  python tools/cn_collector.py --list                 # 看有哪些源
  python tools/cn_collector.py --source mnr --dry-run # 只看抓到什么，不推送
  python tools/cn_collector.py --source all --limit 8 # 正式推送
  python tools/cn_collector.py --source ouc --state .data/cn-state.json

建议部署后用 cron 每 2 小时跑一次：
  0 */2 * * * cd /srv/oceanhot && /usr/bin/python3 tools/cn_collector.py --source all >> /var/log/oceanhot-cn.log 2>&1
"""

from __future__ import annotations

import argparse
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_DEFAULT = ROOT / ".data" / "cn-collector-state.json"
UA = "DeepBlueBot/1.0 (+https://example.invalid/bot)"
CN_TZ = timezone(timedelta(hours=8))
NOW = datetime.now(timezone.utc)

# ── 站点配置 ─────────────────────────────────────────────────────────────────
# 加一个站：往 SOURCES 里加一项。article_pattern 决定哪些链接算文章；
# body_ids / body_classes 是正文容器（按顺序试），url_date 用来从 URL 里补日期。


@dataclass
class CnSource:
    key: str
    source_id: str
    name: str
    list_urls: list[str]
    article_pattern: str
    body_ids: list[str] = field(default_factory=list)
    body_classes: list[str] = field(default_factory=list)
    url_date: str | None = None
    title_suffix: list[str] = field(default_factory=list)
    max_items: int = 12


SOURCES: dict[str, CnSource] = {
    "mnr": CnSource(
        key="mnr",
        source_id="ext-cn-mnr",
        name="自然资源部 · 海洋",
        list_urls=["https://www.mnr.gov.cn/dt/hy/"],
        article_pattern=r"/dt/(?:hy|ywbb)/\d{6}/t\d{8}_\d+\.html$",
        body_ids=["doccon", "content1"],
        body_classes=["ky_article_center"],
        max_items=10,
    ),
    "nmdis": CnSource(
        key="nmdis",
        source_id="ext-cn-nmdis",
        name="国家海洋信息中心",
        list_urls=[
            "https://www.nmdis.org.cn/hyxw/gnhyxw/",
            "https://www.nmdis.org.cn/hyxw/gjhyxw/",
        ],
        article_pattern=r"/c/\d{4}-\d{2}-\d{2}/\d+\.shtml$",
        body_classes=["bodytext", "detail-content"],
        max_items=10,
    ),
    "ouc": CnSource(
        key="ouc",
        source_id="ext-cn-ouc",
        name="中国海洋大学 · 新闻网",
        list_urls=["http://news.ouc.edu.cn/"],
        article_pattern=r"/\d{4}/\d{4}/c\d+a\d+/page\.htm$",
        body_classes=["article", "wp_articlecontent", "v_news_content"],
        title_suffix=["- 中国海洋大学新闻网", "- 新闻网"],
        max_items=10,
    ),
    "iocas": CnSource(
        key="iocas",
        source_id="ext-cn-iocas",
        name="中国科学院海洋研究所",
        list_urls=[
            "https://qdio.cas.cn/2019Ver/News/kyjz/",
            "https://qdio.cas.cn/2019Ver/News/PicNews/",
        ],
        article_pattern=r"/News/(?:kyjz|PicNews|zhxw|xwdt)/\d{6}/t\d{8}_\d+\.html$",
        body_ids=["zoom"],
        body_classes=["TRS_Editor"],
        max_items=10,
    ),
    "sio": CnSource(
        key="sio",
        source_id="ext-cn-sio",
        name="自然资源部第二海洋研究所",
        list_urls=["https://www.sio.org.cn/snyw.html"],
        article_pattern=r"/a/snyw/\d+\.html$",
        body_ids=["content1"],
        body_classes=["content", "TRS_Editor"],
        max_items=8,
    ),
}


# ── 抓取 ─────────────────────────────────────────────────────────────────────
def fetch(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        ctype = r.headers.get("Content-Type", "")
    # 中文站大量使用 gb2312 / gbk，也有 utf-8；先看头，再看 meta
    charset = ""
    m = re.search(r"charset=([\w-]+)", ctype, re.I)
    if m:
        charset = m.group(1)
    if not charset:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", raw[:4000], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    for enc in (charset, "utf-8", "gb18030"):
        if not enc:
            continue
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def clean_text(s: str) -> str:
    s = htmllib.unescape(s)
    s = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", s)
    return re.sub(r"\s+", " ", s).strip()


class AnchorParser(HTMLParser):
    """收集 <a href> 与它的文字（嵌套标签会被拼起来）。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self._stack: list[dict] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href") or ""
            self._stack.append({"href": href, "text": "", "title": dict(attrs).get("title") or ""})

    def handle_data(self, data: str) -> None:
        if self._stack:
            self._stack[-1]["text"] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._stack:
            link = self._stack.pop()
            if link["href"]:
                self.links.append(link)


class BlockParser(HTMLParser):
    """按容器 id / class 抽正文：进入目标块后收集文字，遇到同名块嵌套时计数。"""

    SKIP = {"script", "style", "noscript", "nav", "header", "footer", "form", "iframe", "svg"}

    def __init__(self, ids: list[str], classes: list[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.ids = {i.lower() for i in ids}
        self.classes = {c.lower() for c in classes}
        self.depth = 0
        self.skip = 0
        self.parts: list[str] = []
        self.matched = False

    def _is_target(self, attrs: list[tuple[str, str | None]]) -> bool:
        d = dict(attrs)
        if d.get("id") and d["id"].lower() in self.ids:
            return True
        cls = (d.get("class") or "").lower().split()
        return any(c in self.classes for c in cls)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.skip += 1
            return
        if self._is_target(attrs):
            if self.depth == 0:
                self.matched = True
            self.depth += 1
        elif self.depth and tag in ("p", "br", "div", "li", "h1", "h2", "h3", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.depth and tag in ("p", "div", "li", "h1", "h2", "h3", "tr"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.depth and not self.skip:
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [clean_text(x) for x in raw.split("\n")]
        kept = [x for x in lines if len(x) >= 2]
        # 去掉重复行（很多模板把标题、来源在正文里又排一遍）
        seen: set[str] = set()
        out: list[str] = []
        for line in kept:
            if line in seen:
                continue
            seen.add(line)
            out.append(line)
        return "\n".join(out)


def parse_date(text: str) -> datetime | None:
    if not text:
        return None
    m = re.search(r"(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})", text)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=CN_TZ)
    except ValueError:
        return None


@dataclass
class Article:
    title: str
    url: str
    published: datetime | None
    body: str


def list_articles(src: CnSource) -> list[dict]:
    pattern = re.compile(src.article_pattern)
    found: dict[str, dict] = {}
    for list_url in src.list_urls:
        try:
            page = fetch(list_url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! 列表抓取失败 {list_url}: {e}", file=sys.stderr)
            continue
        parser = AnchorParser()
        try:
            parser.feed(page)
        except Exception:  # noqa: BLE001
            continue
        for link in parser.links:
            url = urllib.parse.urljoin(list_url, link["href"].strip())
            if not pattern.search(urllib.parse.urlparse(url).path):
                continue
            title = clean_text(link["title"] or link["text"])
            for suffix in src.title_suffix:
                if title.endswith(suffix):
                    title = title[: -len(suffix)].strip()
            if len(title) < 6:
                continue
            found.setdefault(url, {"title": title, "url": url})
    return list(found.values())


def url_date(src: CnSource, url: str) -> datetime | None:
    if not src.url_date:
        return None
    m = re.search(src.url_date, url)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=CN_TZ)
    except (ValueError, IndexError):
        return None


def read_article(src: CnSource, entry: dict) -> Article:
    url = entry["url"]
    page = fetch(url)
    title = entry["title"]
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", page, re.I)
    if m:
        page_title = clean_text(re.sub(r"<[^>]+>", "", m.group(1)))
        # 栏目后缀：“ - 国内海洋新闻 - 中国海洋信息网”“_中国科学院海洋研究所”
        page_title = re.split(r"\s+[-_|—]\s+", page_title)[0].strip()
        for suffix in src.title_suffix:
            if page_title.endswith(suffix):
                page_title = page_title[: -len(suffix)].strip()
        # 页面标题通常比列表标题完整；带栏目标题时取干净的那一份
        if 6 <= len(page_title) <= 120:
            title = page_title
    # 发布日期：先找正文附近的日期，再退回 URL 规律
    published = None
    for zone in [page]:
        published = parse_date(zone)
        if published:
            break
    if not published:
        published = url_date(src, url)
    body = ""
    if src.body_ids or src.body_classes:
        bp = BlockParser(src.body_ids, src.body_classes)
        try:
            bp.feed(page)
        except Exception:  # noqa: BLE001
            pass
        if bp.matched:
            body = bp.text()
    if len(body) < 120:
        # 容器没命中：退一步，取 <p> 段落里最长的一段
        paras = [clean_text(re.sub(r"<[^>]+>", "", p)) for p in re.findall(r"<p\b[^>]*>([\s\S]*?)</p>", page, re.I)]
        paras = [p for p in paras if len(p) >= 30]
        body = "\n".join(paras)
    return Article(title=title, url=url, published=published, body=body)


# ── 推送 ─────────────────────────────────────────────────────────────────────
def push(base: str, token: str, source_id: str, name: str, items: list[dict]) -> dict:
    payload = json.dumps({"sourceId": source_id, "sourceName": name, "items": items}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api/ingest/items",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="中文海洋一手信源采集器")
    ap.add_argument("--source", default="all", help="all 或 " + " / ".join(SOURCES))
    ap.add_argument("--limit", type=int, default=0, help="每个站最多处理几条（0 = 用配置里的 max_items）")
    ap.add_argument("--dry-run", action="store_true", help="只抓取和打印，不推送")
    ap.add_argument("--list", action="store_true", help="列出配置里的源")
    ap.add_argument("--state", type=Path, default=STATE_DEFAULT)
    ap.add_argument("--base", default=os.environ.get("AIHOT_BASE", "http://localhost:3000"))
    ap.add_argument("--token", default=os.environ.get("INGEST_TOKEN", ""))
    args = ap.parse_args()

    if args.list:
        for key, src in SOURCES.items():
            print(f"{key:<8} {src.source_id:<16} 列表 {len(src.list_urls)} 个  {src.name}")
        return 0

    keys = list(SOURCES) if args.source == "all" else [args.source]
    unknown = [k for k in keys if k not in SOURCES]
    if unknown:
        print(f"未知的源：{', '.join(unknown)}", file=sys.stderr)
        return 2
    if not args.dry_run and (not args.token or not args.base):
        print("正式推送需要 INGEST_TOKEN 和 AIHOT_BASE（或用 --token/--base）", file=sys.stderr)
        return 2

    state = load_state(args.state)
    total_pushed = 0
    for key in keys:
        src = SOURCES[key]
        cap = args.limit or src.max_items
        print(f"\n== {src.name}（{src.source_id}）")
        entries = list_articles(src)
        seen = set(state.get(src.source_id, []))
        fresh = [e for e in entries if e["url"] not in seen][:cap]
        print(f"  列表 {len(entries)} 条，未推送 {len(entries) - len([e for e in entries if e['url'] in seen])} 条，本次处理 {len(fresh)} 条")
        items: list[dict] = []
        for entry in fresh:
            try:
                art = read_article(src, entry)
            except Exception as e:  # noqa: BLE001
                print(f"  ! 正文失败 {entry['url']}: {e}", file=sys.stderr)
                continue
            if len(art.body) < 80:
                print(f"  ! 跳过（正文太短 {len(art.body)} 字）{art.title[:40]}")
                continue
            if art.published and art.published > NOW + timedelta(days=2):
                print(f"  ! 跳过（日期在未来）{art.title[:40]} {art.published.date()}")
                continue
            # 太旧的不推：AIHOT 会归档，但没必要占推送额度
            if art.published and art.published < NOW - timedelta(days=45):
                print(f"  - 旧文（{art.published.date()}），跳过 {art.title[:36]}")
                continue
            items.append({
                "title": art.title,
                "url": art.url,
                "publishedAt": art.published.astimezone(timezone.utc).isoformat() if art.published else None,
                "raw": {
                    "externalId": art.url,
                    "bodyText": art.body[:12000],
                    "collector": "cn_collector",
                    "source": src.name,
                },
            })
            print(f"  + {art.published.date() if art.published else '日期未知'}  {len(art.body):>5} 字  {art.title[:50]}")

        if args.dry_run or not items:
            continue
        try:
            result = push(args.base, args.token, src.source_id, src.name, items)
            print(f"  推送结果：{result}")
            total_pushed += int(result.get("created") or 0)
            state[src.source_id] = sorted(seen | {i["url"] for i in items})
            save_state(args.state, state)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            print(f"  ! 推送失败 HTTP {e.code}: {body}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  ! 推送失败：{e}", file=sys.stderr)
        time.sleep(1)  # 对同一台站点的礼貌间隔

    print(f"\n新建 {total_pushed} 条")
    return 0 if total_pushed or args.dry_run else 1


if __name__ == "__main__":
    raise SystemExit(main())
