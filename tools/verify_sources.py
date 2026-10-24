#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""海洋信源清单 + 独立校验器。

为什么单独写一个校验器：
  AIHOT 的“预览抓取”要等 Docker 跑起来才能点。这个脚本在部署前就把每一条信源抓一遍，
  用与 packages/backend/src/sources/{rss,json-list}.ts 相同的字段映射判断：
    - 抓到的是文章还是导航
    - 日期能不能解析、是不是旧文 / 未来时间
    - 摘要是不是空的
  抓不到的信源不写进已验证名单，避免上线后后台一片红。

用法：
  python tools/verify_sources.py --write     # 重新探测并生成 ocean-pack/industry/sources.json
  python tools/verify_sources.py             # 只校验现有 sources.json
  python tools/verify_sources.py --json report.json
  python tools/verify_sources.py --only rss-noaa
"""

from __future__ import annotations

import argparse
import html
import json
import re
import ssl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ocean-pack" / "industry" / "sources.json"
UA = "OceanHotBot/1.0 (+https://example.invalid/bot)"  # 上线后按站点实际情况改
NOW = datetime.now(timezone.utc)
STALE = timedelta(days=120)

# 本机 Python 的根证书链可能不全；只影响“部署前体检”。AIHOT 自己用 Node 的证书链抓取，不受影响。
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def get(url: str, timeout: int = 25) -> tuple[int, bytes, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return r.status, r.read(), r.headers.get("Content-Type", "")


def strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


DATE_RE = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?"
)
CN_DATE_RE = re.compile(r"(\d{4})\s*[\u5e74/\-.]\s*(\d{1,2})\s*[\u6708/\-.]\s*(\d{1,2})")


def parse_date(text: str, offset: str = "+00:00") -> datetime | None:
    """尽量宽松：ISO、RFC 822、中文日期、只有年月。"""
    if not text:
        return None
    text = str(text).strip()
    # RSS 的 pubDate 有 "Wed, 14 Oct 2026 …"，也有 "Wednesday, 18 March 2026 9:00:00 -0400"
    if re.match(r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,", text, re.I):
        cleaned = re.sub(r"^[A-Za-z]+,?\s+", "", text)  # 去掉星期
        for fmt in ("%d %b %Y %H:%M:%S %z", "%d %B %Y %H:%M:%S %z", "%d %b %Y %H:%M %z", "%d %B %Y %H:%M %z",
                    "%d %b %Y %z", "%d %B %Y %z"):
            try:
                return datetime.strptime(cleaned, fmt).astimezone(timezone.utc)
            except ValueError:
                continue
    if re.match(r"^[A-Za-z]{3},", text):
        try:
            dt = parsedate_to_datetime(text)
            if dt and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc) if dt else None
        except (TypeError, ValueError, IndexError):
            pass
    m = DATE_RE.search(text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hh = int(m.group(4) or 0)
        mm = int(m.group(5) or 0)
        ss = int(m.group(6) or 0)
        tz = m.group(7)
        try:
            if tz and tz != "Z":
                sign = 1 if tz[0] == "+" else -1
                digits = tz[1:].replace(":", "")
                tzinfo = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:])))
                return datetime(y, mo, d, hh, mm, ss, tzinfo=tzinfo).astimezone(timezone.utc)
            if tz == "Z":
                return datetime(y, mo, d, hh, mm, ss, tzinfo=timezone.utc)
            sign = 1 if offset[0] == "+" else -1
            tzinfo = timezone(sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6])))
            return datetime(y, mo, d, hh, mm, ss, tzinfo=tzinfo).astimezone(timezone.utc)
        except (ValueError, IndexError):
            return None
    m = CN_DATE_RE.search(text)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


@dataclass
class Finding:
    title: str
    url: str
    published: datetime | None
    summary: str


@dataclass
class Result:
    source_id: str
    kind: str
    ok: bool = False
    status: int = 0
    error: str = ""
    total: int = 0
    findings: list[Finding] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        dates = [f.published for f in self.findings if f.published]
        return {
            "id": self.source_id,
            "kind": self.kind,
            "ok": self.ok,
            "status": self.status,
            "error": self.error,
            "total": self.total,
            "withDate": len(dates),
            "withSummary": sum(1 for f in self.findings if len(f.summary) >= 40),
            "newest": max(dates).isoformat() if dates else None,
            "oldest": min(dates).isoformat() if dates else None,
            "sample": [
                {"title": f.title[:90], "url": f.url, "published": f.published.isoformat() if f.published else None}
                for f in self.findings[:3]
            ],
            "notes": self.notes,
        }


# ── RSS / Atom / RDF ─────────────────────────────────────────────────────────
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "rss1": "http://purl.org/rss/1.0/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}
XML_BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
RAW_AMP = re.compile(r"&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)")


def sanitize_xml(text: str) -> str:
    """RSS 常见的两种坏 XML：裸 & 与控制字符。浏览器能容错，ElementTree 不能。"""
    text = text.lstrip("\ufeff")
    text = XML_BAD.sub("", text)
    return RAW_AMP.sub("&amp;", text)


def text_of(el, *paths: str) -> str:
    for p in paths:
        found = el.findtext(p, "", NS)
        if found and found.strip():
            return found.strip()
    return ""


def read_rss(config: dict, source_id: str, kind: str) -> Result:
    res = Result(source_id, kind)
    try:
        status, body, _ = get(config["feedUrl"])
        res.status = status
    except Exception as e:  # noqa: BLE001
        res.error = f"{type(e).__name__}: {e}"
        return res
    text = sanitize_xml(body.decode("utf-8", "replace"))
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        # 有的官方源（NOAA NOS）整份 XML 是坏的：<item> 没有闭合，最后多一个 </channel>。
        # 浏览器和 AIHOT 的 RSS 解析器都能容错；这里逐段抢救 item。
        root = salvage_rss(text, res)
        if root is None:
            return res
    # 本地名匹配：RSS 2.0（item）、Atom（entry）、RSS 1.0/RDF（带默认命名空间的 item）
    items = [el for el in root.iter() if el.tag.rsplit("}", 1)[-1] in ("item", "entry")]
    res.total = len(items)
    for it in items:
        title = text_of(it, "title", "atom:title", "rss1:title")
        link = text_of(it, "link", "rss1:link")
        if not link:
            for a in it.findall("atom:link", NS):
                if a.get("rel", "alternate") == "alternate":
                    link = (a.get("href") or "").strip()
                    break
        if not link:
            link = (it.get(f"{{{NS['rdf']}}}about") or "").strip()
        pub = text_of(it, "pubDate", "dc:date", "atom:published", "atom:updated", "published", "updated")
        desc = text_of(it, "description", "dc:description", "atom:summary", "atom:content", "content:encoded")
        res.findings.append(Finding(strip_tags(title), link, parse_date(pub), strip_tags(desc)))
    if not items:
        res.error = "没有 item/entry"
        return res
    res.ok = True
    # AIHOT 自己的 RSS 读取器按发布时间排序（sortByPublishedAt）；这里同样按日期排，关注“最新”而不是“文件里第一条”
    res.findings.sort(key=lambda f: f.published or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return res


def salvage_rss(text: str, res: Result):
    """坏 XML 的抢救：按 <item>…</item> 切块，逐块包成独立 XML 解析，坏块跳过。"""
    chunks = re.findall(r"<item\b[\s\S]*?</item>", text, flags=re.I)
    if not chunks:
        res.error = "XML 损坏且找不到完整的 <item> 块"
        return None
    good: list[str] = []
    for ch in chunks:
        try:
            ET.fromstring(f"<rss><channel>{ch}</channel></rss>")
            good.append(ch)
        except ET.ParseError:
            continue
    if not good:
        res.error = "XML 损坏，且所有 <item> 块都无法解析"
        return None
    res.notes.append(f"整份 XML 损坏；{len(good)}/{len(chunks)} 个 item 可用（AIHOT 的 RSS 解析器更宽松，通常能全部读到）")
    return ET.fromstring(f"<rss><channel>{''.join(good)}</channel></rss>")


# ── JSON list（Crossref 等）──────────────────────────────────────────────────
def get_path(obj, path: str):
    if not path:
        return obj
    cur = obj
    for seg in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, list) and seg.isdigit():
            idx = int(seg)
            cur = cur[idx] if idx < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(seg)
        else:
            return None
    return cur


def first_string(item, paths: list[str]) -> str | None:
    for p in paths:
        v = get_path(item, p)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, (int, float)):
            return str(v)
    return None


def render_template(t: str, item) -> str | None:
    missing = False

    def sub(m: re.Match[str]) -> str:
        nonlocal missing
        raw = m.group(1)
        v = get_path(item, m.group(2))
        if v in (None, ""):
            missing = True
            return ""
        v = str(v)
        return v if raw else urllib.parse.quote(v, safe="/")

    out = re.sub(r"\{(raw:)?([^}]+)\}", sub, t)
    return None if missing else out


def crossref_date(value) -> str:
    """Crossref 的 date-parts 是 [[2026, 10]]，也可能包成 {date-parts: [[...]]}。"""
    if isinstance(value, dict):
        value = value.get("date-parts")
    if isinstance(value, list) and value and isinstance(value[0], list):
        parts = value[0]
        try:
            nums = [int(x) for x in parts]
        except (TypeError, ValueError):
            return ""
        return "-".join(f"{n:02d}" if i else f"{n:04d}" for i, n in enumerate(nums))
    return str(value) if value else ""


def read_json_list(config: dict, source_id: str, kind: str) -> Result:
    res = Result(source_id, kind)
    try:
        status, body, _ = get(config["url"])
        res.status = status
    except Exception as e:  # noqa: BLE001
        res.error = f"{type(e).__name__}: {e}"
        return res
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError as e:
        res.error = f"JSON 解析失败: {e}"
        return res
    items = get_path(data, config.get("itemsPath", "")) if config.get("itemsPath") else data
    if not isinstance(items, list):
        res.error = "itemsPath 没有解析成数组"
        return res
    res.total = len(items)
    for item in items:
        title = first_string(item, config.get("titlePaths", []))
        url = (render_template(config["urlTemplate"], item) if config.get("urlTemplate") else None)
        if not url and config.get("urlTemplateFallback"):
            url = render_template(config["urlTemplateFallback"], item)
        if not title or not url:
            continue
        pub = crossref_date(get_path(item, config.get("publishedAtPath", "")))
        summary = first_string(item, config.get("summaryPaths", [])) or ""
        res.findings.append(Finding(strip_tags(title), url, parse_date(pub), strip_tags(summary)))
    if not items:
        res.error = "返回 0 条"
        return res
    if not res.findings:
        res.error = "没有一条能映射出标题+链接（检查 titlePaths / urlTemplate）"
        return res
    res.ok = True
    res.findings.sort(key=lambda f: f.published or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return res


def verify(source: dict) -> Result:
    kind = source["kind"]
    cfg = source.get("config", {})
    if kind == "rss":
        r = read_rss(cfg, source["id"], kind)
    elif kind == "json_list":
        r = read_json_list(cfg, source["id"], kind)
    else:
        r = Result(source["id"], kind)
        r.error = f"{kind} 需要 API key 或人工确认，脚本不验（上线后在后台预览）"
        return r
    if r.ok:
        nav = [f for f in r.findings if len(f.title) < 6 or len(f.title) > 180]
        if nav and len(nav) == len(r.findings):
            r.ok = False
            r.error = "标题全部过短或过长，可能抓到的是导航而不是文章"
        dates = [f.published for f in r.findings if f.published]
        if not dates:
            r.notes.append("没有一条能解析出日期；上线后按发布日期归档会全部进 unknown")
        if not any(len(f.summary) >= 40 for f in r.findings):
            r.notes.append("摘要普遍为空，模型只能靠标题判断（海洋论文类常见，可接受但要有取舍）")
        if dates and max(dates) < NOW - STALE:
            r.notes.append(f"最新一条是 {(NOW - max(dates)).days} 天前，信源可能已停更")
        future = [d for d in dates if d > NOW + timedelta(days=45)]
        if future:
            r.notes.append(f"{len(future)} 条发布日期在 45 天以后（在线优先/预排期），会按未知日期处理")
    return r


# ─────────────────────────────────────────────────────────────────────────────
# 信源清单
# ─────────────────────────────────────────────────────────────────────────────
def crossref(issn: str, *, rows: int = 30) -> dict:
    # sort=published 会把“预排的 2027 年卷期”顶到最前；改按 DOI 注册时间（created）排，
    # 拿到的是最近上线的文章，published 用在线发表日期。
    return {
        "url": (f"https://api.crossref.org/journals/{issn}/works"
                f"?filter=type:journal-article,from-created-date:2026-06-01&sort=created&order=desc&rows={rows}"
                f"&select=DOI,title,abstract,published,published-online,created,URL,type,author"),
        "itemsPath": "message.items",
        "titlePaths": ["title.0"],
        "summaryPaths": ["abstract"],
        "authorPaths": ["author.0.family"],
        "publishedAtPath": "published.date-parts",
        "externalIdPath": "DOI",
        "urlTemplate": "https://doi.org/{DOI}",
        "publishedAfter": "2026-06-01T00:00:00.000Z",
        "sortByPublishedAt": True,
    }


def rss(feed: str, *, limit: int = 8) -> dict:
    return {"feedUrl": feed, "sortByPublishedAt": True, "_aihot": {"initialBackfillLimit": limit}}


SRC: list[dict] = [
    # ── T1：官方一手与同行评议 ────────────────────────────────────────────────
    dict(id="rss-noaa-nos", name="NOAA National Ocean Service", kind="rss", config=rss("https://oceanservice.noaa.gov/rss/nosnews.xml", limit=6),
         tier="T1", owner_entity_id="noaa", participation_mode="editorial", interval_minutes=120,
         tags=["官方", "机构"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-noaa", name="NOAA News", kind="rss", config=rss("https://www.noaa.gov/rss.xml"),
         tier="T1", owner_entity_id="noaa", participation_mode="editorial", interval_minutes=120,
         tags=["官方"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-noaa-arctic", name="NOAA Arctic Report Card / News", kind="rss", config=rss("https://arctic.noaa.gov/feed/"),
         tier="T1", owner_entity_id="noaa", participation_mode="editorial", interval_minutes=360,
         tags=["官方", "极地"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-nature", name="Nature", kind="rss", config=rss("https://www.nature.com/nature.rss", limit=10),
         tier="T1", owner_entity_id="nature", participation_mode="editorial", interval_minutes=180,
         tags=["期刊", "论文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-nature-climate", name="Nature Climate Change", kind="rss", config=rss("https://www.nature.com/nclimate.rss"),
         tier="T1", owner_entity_id="nature", participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "气候"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-nature-geoscience", name="Nature Geoscience", kind="rss", config=rss("https://www.nature.com/ngeo.rss"),
         tier="T1", owner_entity_id="nature", participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "地球科学"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-science-news", name="Science News", kind="rss", config=rss("https://www.science.org/rss/news_current.xml"),
         tier="T1", owner_entity_id="science", participation_mode="editorial", interval_minutes=240,
         tags=["期刊", "媒体"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-eos", name="Eos (AGU)", kind="rss", config=rss("https://eos.org/feed"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=240,
         tags=["学会", "地球科学"], site_fulltext=False, syndicate_fulltext=False),
    # Crossref：按 ISSN 拉海洋期刊，摘要来自出版商存档
    dict(id="json-crossref-progress-oceanography", name="Progress in Oceanography (Crossref)", kind="json_list", config=crossref("0079-6611"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-deep-sea-research", name="Deep-Sea Research Part I (Crossref)", kind="json_list", config=crossref("0967-0637"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文", "深海"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-jpo", name="Journal of Physical Oceanography (Crossref)", kind="json_list", config=crossref("0022-3670"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文", "物理海洋"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-ocean-modelling", name="Ocean Modelling (Crossref)", kind="json_list", config=crossref("1463-5003"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文", "模式"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-ices-jms", name="ICES Journal of Marine Science (Crossref)", kind="json_list", config=crossref("1054-3139"),
         tier="T1", owner_entity_id="ices", participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文", "渔业"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-marine-policy", name="Marine Policy (Crossref)", kind="json_list", config=crossref("0308-597X"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=720,
         tags=["期刊", "政策"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-marine-pollution", name="Marine Pollution Bulletin (Crossref)", kind="json_list", config=crossref("0025-326X"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "污染"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-limnology", name="Limnology and Oceanography (Crossref)", kind="json_list", config=crossref("0024-3590"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "论文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="json-crossref-global-biogeochem", name="Global Biogeochemical Cycles (Crossref)", kind="json_list", config=crossref("0886-6236"),
         tier="T1", owner_entity_id=None, participation_mode="editorial", interval_minutes=720,
         tags=["期刊", "碳循环"], site_fulltext=False, syndicate_fulltext=False),
    # ── T1_5：准官方、学会、科普机构 ──────────────────────────────────────────
    dict(id="rss-mbari", name="MBARI", kind="rss", config=rss("https://www.mbari.org/feed/"),
         tier="T1_5", owner_entity_id="mbari", participation_mode="editorial", interval_minutes=720,
         tags=["机构", "深海"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-scripps", name="Scripps Institution of Oceanography", kind="rss", config=rss("https://scripps.ucsd.edu/news/feed/"),
         tier="T1_5", owner_entity_id="scripps", participation_mode="editorial", interval_minutes=720,
         tags=["机构"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-frontiers-marine", name="Frontiers in Marine Science", kind="rss", config=rss("https://www.frontiersin.org/journals/marine-science/rss", limit=10),
         tier="T1_5", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "开放获取"], site_fulltext=False, syndicate_fulltext=False),
    # ── T2：媒体与综合科学 ────────────────────────────────────────────────────
    dict(id="rss-sciencedaily-ocean", name="ScienceDaily Oceanography", kind="rss", config=rss("https://www.sciencedaily.com/rss/earth_climate/oceanography.xml"),
         tier="T2", owner_entity_id=None, participation_mode="editorial", interval_minutes=180,
         tags=["媒体"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-mongabay", name="Mongabay", kind="rss", config=rss("https://news.mongabay.com/feed/"),
         tier="T2", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["媒体", "环境"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-carbonbrief", name="Carbon Brief", kind="rss", config=rss("https://www.carbonbrief.org/feed/"),
         tier="T2", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["媒体", "气候"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-physicsworld", name="Physics World", kind="rss", config=rss("https://www.physicsworld.com/feed/"),
         tier="T2", owner_entity_id=None, participation_mode="editorial", interval_minutes=720,
         tags=["媒体", "物理"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-newscientist", name="New Scientist", kind="rss", config=rss("https://www.newscientist.com/feed/home/"),
         tier="T2", owner_entity_id=None, participation_mode="editorial", interval_minutes=360,
         tags=["媒体"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="rss-nature-comms", name="Nature Communications", kind="rss", config=rss("https://www.nature.com/ncomms.rss", limit=10),
         tier="T2", owner_entity_id="nature", participation_mode="editorial", interval_minutes=360,
         tags=["期刊", "综合"], site_fulltext=False, syndicate_fulltext=False),
    # ── 中文一手：不直接抓，由 tools/cn_collector.py 推进来（external）─────────
    dict(id="ext-cn-mnr", name="自然资源部 · 海洋", kind="external", config={},
         tier="T1", owner_entity_id="mnr", participation_mode="editorial", interval_minutes=180,
         tags=["官方", "中文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="ext-cn-nmdis", name="国家海洋信息中心", kind="external", config={},
         tier="T1", owner_entity_id="mnr", participation_mode="editorial", interval_minutes=360,
         tags=["官方", "中文", "数据"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="ext-cn-ouc", name="中国海洋大学 · 新闻网", kind="external", config={},
         tier="T1_5", owner_entity_id="ouc", participation_mode="editorial", interval_minutes=360,
         tags=["高校", "中文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="ext-cn-iocas", name="中国科学院海洋研究所", kind="external", config={},
         tier="T1", owner_entity_id="cas", participation_mode="editorial", interval_minutes=360,
         tags=["官方", "科研", "中文"], site_fulltext=False, syndicate_fulltext=False),
    dict(id="ext-cn-sio", name="自然资源部第二海洋研究所", kind="external", config={},
         tier="T1", owner_entity_id="mnr", participation_mode="editorial", interval_minutes=720,
         tags=["官方", "科研", "中文"], site_fulltext=False, syndicate_fulltext=False),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="校验/生成海洋信源清单")
    ap.add_argument("--write", action="store_true", help="把探测结果写回 sources.json")
    ap.add_argument("--json", type=Path, default=None, help="把完整报告写成 JSON")
    ap.add_argument("--only", default=None, help="只验某个 id，不能与 --write 同用")
    args = ap.parse_args()

    if args.write and args.only is not None:
        ap.error("--write 不能与 --only 同时使用，以免覆盖完整信源清单")

    if args.write or not OUT.exists():
        sources = SRC
    else:
        sources = json.loads(OUT.read_text(encoding="utf-8"))["sources"]
    if args.only is not None:
        sources = [s for s in sources if s["id"] == args.only]
        if not sources:
            ap.error(f"未知信源 id：{args.only!r}")

    reports: list[dict] = []
    failures = 0
    for s in sources:
        r = verify(s)
        rep = r.summary()
        reports.append(rep)
        mark = "OK  " if r.ok else ("SKIP" if s["kind"] == "external" else "FAIL")
        newest = rep["newest"] or "-"
        print(f"{mark} {s['id']:<40} items={r.total:<4} dated={rep['withDate']:<4} newest={newest[:10]}  {r.error}")
        for n in r.notes:
            print(f"      - {n}")
        if not r.ok and s["kind"] != "external":
            failures += 1

    if args.write:
        for s, rep in zip(sources, reports, strict=True):
            # Verification is report metadata, not collector configuration. The engine rejects
            # unknown config._aihot keys, and external sources do not accept _aihot at all.
            s["verification"] = {
                "verifiedAt": NOW.date().isoformat(),
                "verifiedItems": rep["total"],
            }
        payload = {
            "$comment": (
                "海洋信源。首次启动时由 scripts/seed.ts 导入；已存在的不会被覆盖。字段说明见 docs/sources.md。"
                "id 上线后不要改（external 信源的中文采集脚本按 id 推送）。"
                "verification.verifiedAt / verifiedItems 是 tools/verify_sources.py 的实测结果，可删。"
            ),
            "sources": sources,
        }
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n已写入 {OUT}（{len(sources)} 条）")
    if args.json:
        args.json.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"报告：{args.json}")
    print(f"\n失败 {failures} 条")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
