#!/usr/bin/env python3
"""A small, model-free ocean RSS/Atom/Crossref reader. Python 3.11+, stdlib only.

Only configured public feeds are fetched. No article page, JavaScript, or HTML is executed.
Per-source failures preserve the previous archive and its last successful fetch timestamp.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime, format_datetime
import gzip
import hashlib
from html import unescape
from html.parser import HTMLParser
import http.client
import io
import ipaddress
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import socket
import ssl
import tempfile
import threading
import time
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
_editorial_spec = importlib.util.spec_from_file_location('ocean_chinese_editorial', ROOT / 'scripts/chinese_editorial.py')
_editorial = importlib.util.module_from_spec(_editorial_spec)
_editorial_spec.loader.exec_module(_editorial)
UTC = timezone.utc
RULE_VERSION = 'ocean-keywords-v2'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_ARCHIVE = 2000
TOPICS = {
    'physical': ('ocean current', 'circulation', 'tidal', 'tide', 'salinity', 'ocean mixing', 'upwelling', 'oceanography', '海流', '环流', '潮汐', '水团', '盐度', '海气'),
    'climate': ('climate', 'warming', 'sea level', 'heatwave', 'amoc', 'enso', 'sea ice', '气候', '变暖', '海平面', '海洋热浪', '海冰'),
    'biology': ('biodiversity', 'plankton', 'coral', 'reef', 'whale', 'dolphin', 'kelp', 'siphonophore', 'marine life', 'ecosystem', '珊瑚', '浮游', '海豚', '鲸', '海洋生物', '生态'),
    'chemistry': ('biogeochem', 'carbon', 'acidification', 'nutrient', 'oxygen', 'pollution', 'microplastic', '碳', '酸化', '营养盐', '溶解氧', '污染', '微塑料'),
    'policy': ('policy', 'treaty', 'unc los', 'unclos', 'b b n j', 'bbnj', 'governance', 'protected area', '政策', '治理', '协定', '海洋保护区', '公约'),
    'engineering': ('robot', 'auv', 'rov', 'glider', 'buoy', 'sensor', 'observatory', 'offshore wind', 'ocean model', '机器人', '滑翔机', '浮标', '传感器', '观测网', '海工', '海上风电'),
    'deepsea': ('deep sea', 'deep-sea', 'abyss', 'hadal', 'hydrothermal', 'arctic', 'antarctic', 'polar', '深海', '深渊', '热液', '北极', '南极', '极地'),
    'fisheries': ('fishery', 'fisheries', 'fishing', 'aquaculture', 'seafood', '渔业', '捕捞', '养殖', '海产品'),
}
MARINE_WORDS = ('ocean', 'oceans', 'oceanic', 'oceanographic', 'oceanography', 'marine', 'maritime', 'sea', 'seas', 'seawater', 'seabed', 'seafloor', 'coastal', 'coastline', 'coral', 'reef', 'reefs', 'fisheries', 'fishery', 'aquaculture', 'whale', 'whales', 'kelp', 'plankton', 'siphonophore', 'neustonic', 'estuary', 'estuarine', 'atlantic', 'pacific ocean', 'indian ocean', 'southern ocean', 'antarctica', 'antarctic', '海洋', '海水', '海底', '深海', '珊瑚', '海岸', '海冰', '海平面', '渔业', '海洋生物', '海洋碳')
# Keep explicit, bounded inflections rather than treating every word stem as a match.
PLURALS = {'coral': 'corals', 'reef': 'reefs', 'whale': 'whales', 'dolphin': 'dolphins',
           'siphonophore': 'siphonophores', 'estuary': 'estuaries',
           'ocean current': 'ocean currents', 'tide': 'tides', 'heatwave': 'heatwaves',
           'nutrient': 'nutrients', 'microplastic': 'microplastics', 'ecosystem': 'ecosystems',
           'protected area': 'protected areas', 'robot': 'robots', 'glider': 'gliders',
           'buoy': 'buoys', 'sensor': 'sensors', 'observatory': 'observatories', 'ocean model': 'ocean models'}
GENERAL_SOURCES = {'rss-noaa', 'rss-noaa-arctic', 'rss-nature', 'rss-nature-climate', 'rss-nature-geoscience', 'rss-science-news', 'rss-eos', 'rss-mongabay', 'rss-carbonbrief', 'rss-physicsworld', 'rss-newscientist', 'rss-nature-comms', 'json-crossref-global-biogeochem', 'json-crossref-limnology'}
TRACKING = {'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid'}


def timestamp(value: datetime | None = None) -> str:
    return (value or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipped = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.rsplit(':', 1)[-1]
        if tag.lower() in {'script', 'style', 'iframe', 'object', 'svg', 'math', 'template'}:
            self.skipped += 1
        elif not self.skipped and tag.lower() in {'p', 'br', 'div', 'li'}:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        tag = tag.rsplit(':', 1)[-1]
        if tag.lower() in {'script', 'style', 'iframe', 'object', 'svg', 'math', 'template'} and self.skipped:
            self.skipped -= 1
        elif not self.skipped:
            self.parts.append(' ')

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


def plain(value, limit=240) -> str:
    if value is None:
        return ''
    parser = PlainText()
    try:
        parser.feed(str(value)[:100_000])
        text = unescape(''.join(parser.parts))
    except Exception:
        text = ''
    # Ensure already entity-escaped markup does not become a clickable/script fragment in consumers.
    text = re.sub(r'<[^>]*>', ' ', text)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff\ufffe\uffff]', '', text)
    return re.sub(r'\s+', ' ', text).strip()[:limit]


def public_url(value: str, base: str | None = None) -> str:
    value = str(value or '').strip()
    if base:
        value = urljoin(base, value)
    if not value or len(value) > 4096 or re.search(r'[\x00-\x20\x7f\\]', value):
        raise ValueError('invalid URL')
    parts = urlsplit(value)
    if parts.scheme.lower() not in {'https', 'http'} or parts.username is not None or parts.password is not None:
        raise ValueError('only public http(s) URLs without credentials are allowed')
    host = (parts.hostname or '').rstrip('.').lower()
    if not host or '%' in host or host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        raise ValueError('local hostname is forbidden')
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            raise ValueError('non-public IP address is forbidden')
    except ValueError as error:
        if 'forbidden' in str(error):
            raise
        # Legacy numeric representations can resolve to loopback (127.1, 2130706433, 0x7f000001).
        if '.' not in host or re.fullmatch(r'[0-9.]+', host) or re.fullmatch(r'0x[0-9a-f]+', host):
            raise ValueError('ambiguous or non-public hostname')
        try:
            host = host.encode('idna').decode('ascii')
        except UnicodeError as exc:
            raise ValueError('invalid hostname') from exc
    port = parts.port  # also validates malformed/out-of-range ports
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('invalid port')
    authority = f'[{host}]' if ':' in host else host
    if port and port != (443 if parts.scheme.lower() == 'https' else 80):
        authority += f':{port}'
    return urlunsplit((parts.scheme.lower(), authority, parts.path or '/', parts.query, ''))


def canonical_url(value: str) -> str:
    parts = urlsplit(public_url(value))
    query = [(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
             if not key.lower().startswith('utm_') and key.lower() not in TRACKING]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(sorted(query)), ''))


def normalize_doi(value) -> str | None:
    value = unquote(str(value or '')).strip()
    value = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', value, flags=re.I)
    if re.fullmatch(r'10\.\d{4,9}/[^\s<>"?#]+', value, flags=re.I):
        return value.lower()
    return None


def date_value(value) -> tuple[str | None, str | None, str | None]:
    """Never substitute a fetch/create/index timestamp for an unknown publication date."""
    if isinstance(value, list):
        if value and isinstance(value[0], list):
            value = value[0]
        if not value or not all(isinstance(x, int) for x in value) or len(value) > 3:
            return None, None, None
        try:
            year = value[0]
            month = value[1] if len(value) > 1 else 1
            day = value[2] if len(value) > 2 else 1
            parsed = datetime(year, month, day, tzinfo=UTC)
        except (ValueError, TypeError):
            return None, None, None
        precision = ('year', 'month', 'day')[len(value) - 1]
        label = parsed.strftime({'year': '%Y', 'month': '%Y-%m', 'day': '%Y-%m-%d'}[precision])
        return (timestamp(parsed) if precision == 'day' else None), precision, label
    if not isinstance(value, str) or not value.strip():
        return None, None, None
    value = value.strip()
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        try:
            parsed = datetime.fromisoformat(value).replace(tzinfo=UTC)
            return timestamp(parsed), 'day', value
        except ValueError:
            return None, None, None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (ValueError, TypeError, OverflowError):
            return None, None, None
    if parsed.tzinfo is None:
        return None, None, None
    return timestamp(parsed), 'second', parsed.astimezone(UTC).date().isoformat()


def hit_words(text: str, words) -> list[str]:
    text = text.casefold()
    return [word for word in words if (word.casefold() in text if re.search(r'[^\x00-\x7f]', word)
            else any(re.search(r'(?<![a-z0-9])' + re.escape(form.casefold()) + r'(?![a-z0-9])', text)
                     for form in (word, PLURALS.get(word, word))))]


def analysis_text(value: str, source: dict) -> str:
    # Publisher/institution branding is not evidence that the subject of a story is marine.
    for branding in [source['name'], 'Scripps Institution of Oceanography', 'Scripps Oceanography']:
        if branding:
            value = re.sub(re.escape(branding), ' ', value, flags=re.I)
    return re.sub(r'\s+', ' ', value).strip()


def make_item(source: dict, title, url, summary, published=None, doi=None, now=None) -> dict | None:
    try:
        url = canonical_url(url)
    except (ValueError, TypeError):
        return None
    title = plain(title, 300)
    if not title:
        return None
    # Crossref also indexes journal front matter, which is not a research/news item.
    if source.get('kind') == 'json_list' and title.casefold().strip(' .:;') in {
            'editorial board', 'journal information and table of contents'}:
        return None
    excerpt = plain(summary, 240)
    clean_title = analysis_text(title, source)
    clean_excerpt = analysis_text(excerpt, source)
    text = clean_title + ' ' + clean_excerpt
    title_hits = hit_words(clean_title, MARINE_WORDS)
    summary_hits = hit_words(clean_excerpt, MARINE_WORDS)
    hits = sorted(set(title_hits) | set(summary_hits))
    reader = source.get('reader', {})
    needs_rule = reader.get('requireOceanKeyword', source.get('requiresMarineKeyword', source['id'] in GENERAL_SOURCES))
    # A freshwater/lunar story can compare something to seawater or name an oceanography
    # institution. With no title hit, these weak summary-only terms do not establish its subject.
    meaningful_summary = set(summary_hits) - {'sea', 'seas', 'seawater', 'oceanography'}
    if needs_rule and not (title_hits or meaningful_summary):
        return None
    doi = normalize_doi(doi) or (normalize_doi(url) if urlsplit(url).hostname in {'doi.org', 'dx.doi.org'} else None)
    key = 'doi:' + doi if doi else 'url:' + url
    published_at, precision, published_date = date_value(published)
    cutoff, _, _ = date_value(source.get('config', {}).get('publishedAfter'))
    if cutoff and published_at and published_at < cutoff:
        return None
    return {'id': hashlib.sha256(key.encode()).hexdigest()[:24], 'title': title, 'url': url,
            'sourceId': source['id'], 'sourceName': source['name'], 'publishedAt': published_at,
            'publishedDate': published_date, 'publishedDatePrecision': precision,
            'summary': excerpt, 'topics': sorted(set(topic for topic, words in TOPICS.items() if hit_words(text, words)) | set(topic for topic in reader.get('topics', []) if topic in TOPICS)),
            'collectedAt': now or timestamp(), 'ruleMatched': bool(hits), 'ruleHits': sorted(hits),
            'filterMode': 'marine-keyword' if needs_rule else 'configured-marine-source',
            **({'doi': doi} if doi else {})}


def local_name(tag) -> str:
    return tag.rsplit('}', 1)[-1].lower()


def child(node, *names):
    return next((x for x in node if local_name(x.tag) in names), None)


def node_text(node) -> str:
    if node is None:
        return ''
    if len(node):
        # Keep markup so script/style descendants can be dropped by the inert text parser.
        return ''.join(ET.tostring(part, encoding='unicode') for part in node) if not node.text else (node.text + ''.join(ET.tostring(part, encoding='unicode') for part in node))
    return node.text or ''


def parse_feed(body: bytes, source: dict, base: str, limit: int, now: str) -> list[dict]:
    # Refuse DTD/entities before parsing, including UTF-16/UTF-32 declarations with NUL padding.
    compact = body.replace(b'\0', b'').upper()
    if b'<!DOCTYPE' in compact or b'<!ENTITY' in compact:
        raise ValueError('feed DTD/entities are not accepted')
    root = ET.fromstring(body)
    if local_name(root.tag) not in {'rss', 'rdf', 'feed'}:
        raise ValueError('response is not RSS/Atom')
    atom = local_name(root.tag) == 'feed'
    entries = [node for node in root.iter() if local_name(node.tag) == ('entry' if atom else 'item')][:limit]
    result = []
    for entry in entries:
        title = node_text(child(entry, 'title'))
        if atom:
            links = [x for x in entry if local_name(x.tag) == 'link' and x.get('rel', 'alternate') == 'alternate']
            url = next((x.get('href') for x in links if x.get('href')), '')
            summary = node_text(child(entry, 'summary'))  # Atom content can contain an article body: do not republish it.
            published = node_text(child(entry, 'published'))  # updated is a modification date, not a publication date.
        else:
            url = node_text(child(entry, 'link'))
            if not url:
                guid = child(entry, 'guid')
                url = node_text(guid) if guid is not None and guid.get('isPermaLink', 'true').lower() != 'false' else ''
            summary = node_text(child(entry, 'description', 'summary'))  # no content:encoded full text
            published = node_text(child(entry, 'pubdate', 'date', 'published'))
        try:
            resolved = public_url(url, base) if url else ''
        except ValueError:
            continue
        doi = node_text(child(entry, 'doi', 'identifier'))
        item = make_item(source, title, resolved, summary, published, doi, now)
        if item:
            result.append(item)
    return result


def path_value(value, dotted):
    for part in str(dotted).split('.'):
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def parse_crossref(body: bytes, source: dict, limit: int, now: str) -> list[dict]:
    data = json.loads(body)
    config = source['config']
    rows = path_value(data, config.get('itemsPath', 'message.items'))
    if not isinstance(rows, list):
        raise ValueError('Crossref items path is not an array')
    result = []
    for row in rows[:limit]:
        if not isinstance(row, dict):
            continue
        title = next((path_value(row, p) for p in config.get('titlePaths', ['title.0']) if path_value(row, p)), '')
        summary = next((path_value(row, p) for p in config.get('summaryPaths', ['abstract']) if path_value(row, p)), '')
        doi = normalize_doi(path_value(row, config.get('externalIdPath', 'DOI')))
        template = config.get('urlTemplate', 'https://doi.org/{DOI}')
        url = template.replace('{DOI}', quote(doi, safe='/:()')) if doi else row.get('URL', '')
        published = path_value(row, config.get('publishedAtPath', 'published.date-parts'))
        if published is None:
            published = path_value(row, 'published-online.date-parts')
        item = make_item(source, title, url, summary, published, doi, now)
        if item:
            result.append(item)
    return result


def resolve_public(host: str, port: int, deadline: float) -> list[tuple]:
    result = queue.Queue(maxsize=1)
    def resolve():
        try:
            result.put(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except Exception as exc:
            result.put(exc)
    threading.Thread(target=resolve, daemon=True).start()
    try:
        addresses = result.get(timeout=max(.01, deadline - time.monotonic()))
    except queue.Empty as exc:
        raise TimeoutError('DNS deadline exceeded') from exc
    if isinstance(addresses, Exception):
        raise OSError('DNS lookup failed') from addresses
    if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
        raise ValueError('DNS resolved to a non-public address')
    return addresses


def fetch_public(url: str, timeout=12.0, max_bytes=MAX_RESPONSE) -> tuple[bytes, str]:
    """Resolve/check every redirect, then connect to the checked IP (prevent DNS rebinding)."""
    deadline = time.monotonic() + timeout
    for _ in range(5):
        url = public_url(url)
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == 'https' else 80)
        addresses = resolve_public(parts.hostname, port, deadline)
        last_error = None
        sock = None
        for family, socktype, protocol, _, address in addresses:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('source deadline exceeded')
            candidate = socket.socket(family, socktype, protocol)
            candidate.settimeout(remaining)
            try:
                candidate.connect(address)
                candidate.settimeout(max(.01, deadline - time.monotonic()))
                if parts.scheme == 'https':
                    candidate = ssl.create_default_context().wrap_socket(candidate, server_hostname=parts.hostname)
                sock = candidate
                break
            except (OSError, ssl.SSLError) as exc:
                candidate.close()
                last_error = exc
        if sock is None:
            raise OSError('public source connection failed') from last_error
        connection = http.client.HTTPConnection(parts.hostname, port, timeout=max(.01, deadline - time.monotonic()))
        connection.sock = sock
        try:
            sock.settimeout(max(.01, deadline - time.monotonic()))
            target = quote(parts.path or '/', safe="/%:@!$&'()*+,;=-._~") + ('?' + parts.query if parts.query else '')
            connection.request('GET', target, headers={'Host': parts.netloc, 'User-Agent': 'OceanKnowledgeHub/1.0 (RSS/Atom metadata reader; no full-text crawling)', 'Accept': 'application/rss+xml, application/atom+xml, application/json, application/xml, text/xml;q=0.9', 'Accept-Encoding': 'identity', 'Connection': 'close'})
            sock.settimeout(max(.01, deadline - time.monotonic()))
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader('Location')
                if not location:
                    raise ValueError('redirect lacks a destination')
                url = public_url(location, url)
                continue
            if response.status != 200:
                raise OSError(f'HTTP {response.status}')
            size = response.getheader('Content-Length')
            if size and int(size) > max_bytes:
                raise ValueError('response exceeds byte limit')
            chunks, total = [], 0
            # HTTPResponse closes its file/socket as soon as Content-Length reaches zero. In
            # particular on Windows, settimeout() on the next iteration then raises WinError10038.
            while not response.isclosed():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('source deadline exceeded')
                sock.settimeout(remaining)
                chunk = response.read(min(65536, max_bytes + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError('response exceeds byte limit')
            body = b''.join(chunks)
            encoding = (response.getheader('Content-Encoding') or 'identity').lower()
            if encoding == 'gzip':
                with gzip.GzipFile(fileobj=io.BytesIO(body)) as zipped:
                    body = zipped.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise ValueError('decompressed response exceeds byte limit')
            elif encoding not in {'identity', ''}:
                raise ValueError('unsupported response encoding')
            return body, url
        finally:
            connection.close()
    raise ValueError('too many redirects')


def load_config(file: Path) -> dict:
    payload = json.loads(file.read_text(encoding='utf-8-sig'))
    if not isinstance(payload, dict) or not isinstance(payload.get('sources'), list) or len(payload['sources']) > 100:
        raise ValueError('config must contain at most 100 sources')
    seen = set()
    for source in payload['sources']:
        if not isinstance(source, dict) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', str(source.get('id', ''))) or source['id'] in seen:
            raise ValueError('invalid or duplicate source id')
        seen.add(source['id'])
        if not isinstance(source.get('name'), str) or not source['name'].strip():
            raise ValueError('source name is required')
        if source.get('kind') not in {'rss', 'atom', 'json_list', 'external'}:
            raise ValueError('unsupported source kind')
        if not isinstance(source.get('config', {}), dict):
            raise ValueError('source config must be an object')
        source.setdefault('config', {})
        if source.get('kind') != 'external':
            endpoint = source['config'].get('feedUrl') or source['config'].get('url')
            public_url(endpoint)
            if source['kind'] == 'json_list' and urlsplit(endpoint).hostname != 'api.crossref.org':
                raise ValueError('json_list currently supports the public Crossref API only')
        if 'enabled' in source and not isinstance(source['enabled'], bool):
            raise ValueError('source enabled must be boolean')
        reader = source.get('reader', {})
        if not isinstance(reader, dict) or ('requireOceanKeyword' in reader and not isinstance(reader['requireOceanKeyword'], bool)) or not isinstance(reader.get('topics', []), list) or any(topic not in TOPICS for topic in reader.get('topics', [])):
            raise ValueError('source reader rules/topics are invalid')
    return payload


def source_info(source: dict) -> dict:
    reader = source.get('reader', {})
    candidate = (reader.get('homepage') or source.get('homeUrl') or source.get('url')) if source['kind'] == 'external' else (source['config'].get('feedUrl') or source['config'].get('url'))
    try:
        url = public_url(candidate)
    except ValueError:
        url = None
    return {'id': source['id'], 'name': source['name'], 'kind': source['kind'], 'url': url,
            'mode': 'manual' if source['kind'] == 'external' else 'auto', 'enabled': source.get('enabled', True),
            'requiresMarineKeyword': reader.get('requireOceanKeyword', source.get('requiresMarineKeyword', source['id'] in GENERAL_SOURCES))}


def merge_items(old: list[dict], fresh: list[dict], source_ids: set, statuses: dict) -> list[dict]:
    merged = {}
    # Keep the existing archive when a feed rolls past an entry or has no new matching entries.
    for item in old + fresh:
        if not isinstance(item, dict) or item.get('sourceId') not in source_ids:
            continue
        try:
            url = canonical_url(item['url'])
        except (KeyError, ValueError):
            continue
        doi = normalize_doi(item.get('doi')) or (normalize_doi(url) if urlsplit(url).hostname in {'doi.org', 'dx.doi.org'} else None)
        key = 'doi:' + doi if doi else 'url:' + url
        stable_id = hashlib.sha256(key.encode()).hexdigest()[:24]
        current = {**item, 'id': stable_id, 'url': url, 'title': plain(item.get('title'), 300), 'summary': plain(item.get('summary'))}
        if not current['title']:
            continue
        previous = merged.get(stable_id)
        provenance = {p['id']: p for p in (previous or {}).get('sources', [])}
        for p in current.get('sources', [{'id': current['sourceId'], 'name': current['sourceName']}]):
            if isinstance(p, dict) and p.get('id') in source_ids:
                provenance[p['id']] = {'id': p['id'], 'name': plain(p.get('name'), 200)}
        if previous:
            current['collectedAt'] = min(previous['collectedAt'], current['collectedAt'])
            current['topics'] = sorted(set(previous.get('topics', [])) | set(current.get('topics', [])))
            current['ruleHits'] = sorted(set(previous.get('ruleHits', [])) | set(current.get('ruleHits', [])))
            current['ruleMatched'] = bool(current['ruleHits'])
            # Preserve primary attribution across runs; other sightings remain visible as provenance.
            current['sourceId'], current['sourceName'] = previous['sourceId'], previous['sourceName']
        current['sources'] = sorted(provenance.values(), key=lambda p: p['id'])
        current['stale'] = all(statuses.get(p['id'], {}).get('status') in {'stale', 'error'} for p in current['sources'])
        merged[stable_id] = current
    # An unknown publication date must not become "newest" just because we fetched it today.
    return sorted(merged.values(), key=lambda i: (i.get('publishedAt') or '', i['id']), reverse=True)[:MAX_ARCHIVE]


def reapply_rules(items: list[dict], sources: list[dict]) -> list[dict]:
    """Reclassify saved short excerpts with current rules without changing acquisition dates."""
    by_id = {source['id']: source for source in sources}
    result = []
    for item in items:
        ids = [item.get('sourceId')] + [p.get('id') for p in item.get('sources', []) if isinstance(p, dict)]
        accepted = []
        for source_id in dict.fromkeys(ids):
            if source_id not in by_id:
                continue
            candidate = make_item(by_id[source_id], item.get('title'), item.get('url'), item.get('summary'),
                                  item.get('publishedAt'), item.get('doi'), item.get('collectedAt'))
            if candidate:
                accepted.append(candidate)
        if accepted:
            result.append({**item, 'title': accepted[0]['title'], 'summary': accepted[0]['summary'],
                           'sourceId': accepted[0]['sourceId'], 'sourceName': accepted[0]['sourceName'],
                           'sources': [{'id': candidate['sourceId'], 'name': candidate['sourceName']} for candidate in accepted],
                           'topics': sorted(set(topic for candidate in accepted for topic in candidate['topics'])),
                           'ruleHits': sorted(set(hit for candidate in accepted for hit in candidate['ruleHits'])),
                           'ruleMatched': any(candidate['ruleMatched'] for candidate in accepted),
                           'filterMode': accepted[0]['filterMode']})
    return result


def refresh(config: dict, previous: dict | None = None, *, fetcher=fetch_public, now=None, workers=4, timeout=12, limit=20, base_url=None) -> tuple[dict, int]:
    fixed_now = now
    now = now or timestamp()
    previous = previous or {}
    old_status = {s['id']: s for s in previous.get('metadata', {}).get('sourceStatus', []) if isinstance(s, dict) and 'id' in s}
    sources = config['sources']
    statuses, fresh, pending = {}, [], []
    for source in sources:
        info = source_info(source)
        prior = old_status.get(source['id'], {})
        state = {**info, 'status': 'manual' if info['mode'] == 'manual' else 'disabled',
                 'lastAttemptAt': prior.get('lastAttemptAt'), 'lastSuccessAt': prior.get('lastSuccessAt'),
                 'itemCount': prior.get('itemCount', 0), 'error': None}
        if source.get('enabled', True) and info['mode'] == 'auto':
            pending.append(source)
            state['lastAttemptAt'] = now
        statuses[source['id']] = state
    def collect(source):
        endpoint = source['config'].get('feedUrl') or source['config'].get('url')
        if source['kind'] == 'json_list':
            parts = urlsplit(endpoint)
            params = [(k, str(min(limit, int(v))) if k == 'rows' and v.isdigit() else v) for k, v in parse_qsl(parts.query, keep_blank_values=True)]
            endpoint = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), ''))
        body, final_url = fetcher(endpoint, timeout=timeout, max_bytes=MAX_RESPONSE)
        observed_at = fixed_now or timestamp()
        return parse_crossref(body, source, limit, observed_at) if source['kind'] == 'json_list' else parse_feed(body, source, final_url, limit, observed_at)
    successes = 0
    with ThreadPoolExecutor(max_workers=max(1, min(4, workers))) as pool:
        jobs = {pool.submit(collect, source): source for source in pending}
        for future in as_completed(jobs):
            source = jobs[future]
            state = statuses[source['id']]
            try:
                items = future.result()
                fresh.extend(items)
                state.update(status='ok', lastSuccessAt=fixed_now or timestamp(), itemCount=len(items), error=None)
                successes += 1
            except Exception as exc:
                state.update(status='stale' if state.get('lastSuccessAt') else 'error',
                             error=plain(f'{type(exc).__name__}: {exc}', 200))
    items = merge_items(reapply_rules(previous.get('items', []), sources), sorted(fresh, key=lambda i: (i['sourceId'], i['id'])), {s['id'] for s in sources}, statuses)
    # The reader labels this as retained content, so count the deduplicated archive,
    # including old items retained after a source failure or a rolling feed window.
    for source_id, state in statuses.items():
        state['itemCount'] = sum(any(p['id'] == source_id for p in item['sources']) for item in items)
    site_url = base_url or config.get('siteUrl')
    if site_url:
        site_url = public_url(site_url).rstrip('/') + '/'
    metadata = {'generatedAt': fixed_now or timestamp(), 'lastAttemptAt': now,
                'lastSuccessAt': max(state['lastSuccessAt'] for state in statuses.values() if state['status'] == 'ok') if successes else previous.get('metadata', {}).get('lastSuccessAt'),
                'ruleVersion': RULE_VERSION, 'siteUrl': site_url, 'feedUrlConfigured': bool(site_url), 'totalItems': len(items),
                'successfulSources': successes, 'automaticSources': len(pending),
                'sourceStatus': [statuses[s['id']] for s in sources],
                'notice': 'Rules match marine keywords; no AI review or quality scoring. Feed-provided excerpts only; full-text redistribution permission is not inferred.'}
    return {'schemaVersion': 1, 'metadata': metadata, 'items': items, 'sources': [source_info(s) for s in sources]}, (0 if successes or not pending else 1)


def atomic_write(file: Path, body: bytes):
    file.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=file.parent, prefix='.' + file.name, delete=False) as stream:
        stream.write(body)
        temp = Path(stream.name)
    try:
        os.replace(temp, file)
    finally:
        if temp.exists():
            temp.unlink()


def write_outputs(data: dict, directory: Path):
    meta = data['metadata']
    dc_namespace = 'http://purl.org/dc/elements/1.1/'
    ET.register_namespace('dc', dc_namespace)
    sources = {source['id']: source for source in data['sources']}
    rss = ET.Element('rss', version='2.0')
    channel = ET.SubElement(rss, 'channel')
    ET.SubElement(channel, 'title').text = 'Ocean Knowledge Hub'
    ET.SubElement(channel, 'link').text = meta.get('siteUrl') or ''
    chinese_mode = meta.get('editorial', {}).get('enabled') is True
    ET.SubElement(channel, 'description').text = ('海洋公开来源的中文标题与摘要整理，点击查看原文；不等于事实核验或AI选稿。'
                                                if chinese_mode else 'Ocean source links and short feed excerpts; keyword rules, no AI review.')
    if meta.get('lastSuccessAt'):
        ET.SubElement(channel, 'lastBuildDate').text = format_datetime(datetime.fromisoformat(meta['lastSuccessAt'].replace('Z', '+00:00')), usegmt=True)
    feed_items = [item for item in data['items'] if not chinese_mode or item.get('titleZh') and item.get('summaryZh')]
    for item in feed_items[:200]:
        node = ET.SubElement(channel, 'item')
        ET.SubElement(node, 'title').text = item.get('titleZh') or item['title']
        ET.SubElement(node, 'link').text = item['url']
        ET.SubElement(node, 'guid', isPermaLink='false').text = 'urn:ocean-knowledge:' + item['id']
        summary = item.get('summaryZh') or item['summary']
        if item.get('editorial', {}).get('basis') == 'title_only':
            summary = '【仅据标题，来源未提供摘要】' + summary
        ET.SubElement(node, 'description').text = summary
        original_source = sources.get(item['sourceId'], {})
        if original_source.get('kind') in {'rss', 'atom'} and original_source.get('url'):
            ET.SubElement(node, 'source', url=original_source['url']).text = item['sourceName']
        else:
            # RSS <source> requires the source feed's URL. A Crossref JSON endpoint is not RSS.
            ET.SubElement(node, f'{{{dc_namespace}}}source').text = item['sourceName']
        if item.get('publishedAt'):
            ET.SubElement(node, 'pubDate').text = format_datetime(datetime.fromisoformat(item['publishedAt'].replace('Z', '+00:00')), usegmt=True)
        for topic in item['topics']:
            ET.SubElement(node, 'category').text = topic
    opml = ET.Element('opml', version='2.0')
    ET.SubElement(ET.SubElement(opml, 'head'), 'title').text = 'Ocean RSS/Atom sources'
    body = ET.SubElement(opml, 'body')
    for source in data['sources']:
        if source['kind'] in {'rss', 'atom'} and source.get('url'):
            ET.SubElement(body, 'outline', text=source['name'], title=source['name'], type='rss', xmlUrl=source['url'])
    atomic_write(directory / 'feed.xml', ET.tostring(rss, encoding='utf-8', xml_declaration=True))
    opml_bytes = ET.tostring(opml, encoding='utf-8', xml_declaration=True)
    atomic_write(directory / 'ocean-sources.opml', opml_bytes)
    atomic_write(directory / 'sources.opml', opml_bytes)
    # JSON last: the UI never sees an empty or half-written dataset after a fetch failure.
    atomic_write(directory / 'data.json', (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'config/sources.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'site')
    parser.add_argument('--max-items-per-source', type=int, default=20)
    parser.add_argument('--timeout', type=float, default=12)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--base-url', default=os.environ.get('OCEAN_SITE_URL'))
    parser.add_argument('--check', action='store_true', help='Validate configuration and any saved JSON without network access')
    parser.add_argument('--rebuild', action='store_true', help='Reapply current rules to saved excerpts and exports without network access or advancing success timestamps')
    args = parser.parse_args(argv)
    if not 1 <= args.max_items_per_source <= 20 or not 0 < args.timeout <= 30 or not 1 <= args.workers <= 4:
        parser.error('max-items-per-source must be 1..20, timeout 0..30 seconds, workers 1..4')
    try:
        config = load_config(args.config)
        previous_file = args.output_dir / 'data.json'
        previous = json.loads(previous_file.read_text(encoding='utf-8-sig')) if previous_file.exists() else None
        if previous is not None and (previous.get('schemaVersion') != 1 or not isinstance(previous.get('items'), list) or not isinstance(previous.get('metadata'), dict)):
            raise ValueError('existing data.json has an unsupported schema; preserved without overwrite')
        if args.check:
            print(f'Config valid: {len(config["sources"])} sources; saved data valid: {previous is not None}; no network requests.')
            return 0
        if args.rebuild:
            if not previous:
                raise ValueError('--rebuild requires an existing real data.json snapshot')
            states = {s['id']: s for s in previous['metadata'].get('sourceStatus', [])}
            items = merge_items([], reapply_rules(previous['items'], config['sources']), {s['id'] for s in config['sources']}, states)
            for source in config['sources']:
                if source['id'] in states:
                    states[source['id']].update(source_info(source))
                    states[source['id']]['itemCount'] = sum(any(p['id'] == source['id'] for p in item['sources']) for item in items)
            rebuilt_at = timestamp()
            data = {**previous, 'metadata': {**previous['metadata'], 'ruleVersion': RULE_VERSION,
                    'generatedAt': rebuilt_at, 'ruleRebuiltAt': rebuilt_at, 'totalItems': len(items),
                    'sourceStatus': list(states.values())}, 'items': items,
                    'sources': [source_info(s) for s in config['sources']]}
            data = _editorial.apply_editorial(data, _editorial.load_editorial(args.config.parent / 'chinese-editorial.json'))
            write_outputs(data, args.output_dir)
            print(f'Rebuilt {len(items)} saved items with current keyword rules; acquisition/success timestamps preserved; no network requests.')
            return 0
        data, status = refresh(config, previous, workers=args.workers, timeout=args.timeout, limit=args.max_items_per_source, base_url=args.base_url)
        data = _editorial.apply_editorial(data, _editorial.load_editorial(args.config.parent / 'chinese-editorial.json'))
        write_outputs(data, args.output_dir)
        for source in data['metadata']['sourceStatus']:
            print(f'{source["status"]:8} {source["id"]}: {source["itemCount"]} items' + (f' ({source["error"]})' if source['error'] else ''))
        print(f'Saved {len(data["items"])} items; {data["metadata"]["successfulSources"]}/{data["metadata"]["automaticSources"]} automatic sources succeeded. Last success: {data["metadata"]["lastSuccessAt"]}')
        return status
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f'Refresh refused: {exc}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
