#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stepx 只读同步契约检查，不修改远端数据。

逐页校验，直到 hasMore=false；超过 --max-pages 明确失败，不能声称已完整读取。
增量事件允许同 externalId 多次出现，按序 upsert/下架。不存在 ID 的 tombstone
不等于真实撤回验证；只读检查也不能证明源端没有漏发。

推荐：先设置环境变量，再运行，避免密钥出现在进程参数中：
  python tools/stepx_contract_check.py --base https://你的域名 --token-env STEPX_TOKEN
  python tools/stepx_contract_check.py --self-test
省略 token 参数时也读取 STEPX_TOKEN。self-test 仅验证本地模拟，不能代替真实联调。
退出码：0 本次检查通过；1 FAIL/未完成；2 参数错误。
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMA = "stepx.ocean.v1"
REQUIRED = ["externalId", "sourceItemId", "tombstone", "title", "summary", "originalTitle", "language",
            "sourceName", "originalUrl", "aihotUrl", "publishedAt", "updatedAt", "category", "tags", "score",
            "reason", "storyId", "storyTitle", "bodyText", "author"]


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Scan:
    checks: list[Check] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)
    next_since: str | None = None
    pages: int = 0
    complete: bool = False


def request(base: str, path: str, token: str | None) -> tuple[int, object | str]:
    req = urllib.request.Request(base.rstrip("/") + path, headers={"accept": "application/json"})
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            try:
                return response.status, json.loads(response.read().decode("utf-8", "replace"))
            except json.JSONDecodeError:
                return response.status, "non-JSON response"
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return error.code, "non-JSON response"
    except Exception as error:
        # 不打印响应正文/请求头；服务可能把凭据回显进错误。
        return 0, type(error).__name__


def is_timestamp(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0
    except (ValueError, TypeError, OverflowError):
        return False


def item_errors(item: object) -> list[str]:
    if not isinstance(item, dict):
        return ["条目必须是对象"]
    missing = [name for name in REQUIRED if name not in item]
    if missing:
        return ["缺必填字段 " + ",".join(missing)]
    errors = []
    source_id = item["sourceItemId"]
    if not isinstance(source_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", source_id):
        errors.append("sourceItemId 无效")
    if item["externalId"] != f"aihot:{source_id}":
        errors.append("externalId 必须是 aihot: + sourceItemId")
    if not isinstance(item["tombstone"], bool):
        errors.append("tombstone 必须是布尔值")
    if not is_timestamp(item["updatedAt"]):
        errors.append("updatedAt 必须是 UTC 时间")
    if not isinstance(item["tags"], list) or any(not isinstance(tag, str) for tag in item["tags"]):
        errors.append("tags 必须是字符串数组")
    if item["tombstone"] is True:
        cleared = [name for name in REQUIRED if name not in {"externalId", "sourceItemId", "tombstone", "updatedAt", "tags"}]
        if any(item[name] is not None for name in cleared) or item["tags"] != []:
            errors.append("tombstone 必须清空展示字段")
        return errors
    for name in ["title", "sourceName", "originalUrl"]:
        if not isinstance(item[name], str) or not item[name].strip():
            errors.append(f"有效条目缺 {name}")
    if isinstance(item["originalUrl"], str):
        try:
            url = urllib.parse.urlparse(item["originalUrl"])
            valid_url = url.scheme in {"http", "https"} and bool(url.netloc)
        except ValueError:
            valid_url = False
        if not valid_url:
            errors.append("originalUrl 必须是 HTTP(S) 原文链接")
    if item["summary"] is not None and not isinstance(item["summary"], str):
        errors.append("summary 必须是字符串或 null")
    for name in ["originalTitle", "language", "aihotUrl", "category", "reason", "storyId", "storyTitle", "bodyText", "author"]:
        if item[name] is not None and not isinstance(item[name], str):
            errors.append(f"{name} 必须是字符串或 null")
    if item["publishedAt"] is not None and not is_timestamp(item["publishedAt"]):
        errors.append("publishedAt 必须是 UTC 时间或 null")
    score = item["score"]
    if score is not None and (isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= 100):
        errors.append("score 必须在 0–100 或为 null")
    return errors


def envelope_errors(body: object, limit: int) -> list[str]:
    if not isinstance(body, dict):
        return ["响应必须是 JSON 对象"]
    errors = []
    if body.get("schema") != SCHEMA:
        errors.append("schema 不匹配")
    if not is_timestamp(body.get("generatedAt")):
        errors.append("generatedAt 必须是 UTC 时间")
    if not isinstance(body.get("hasMore"), bool):
        errors.append("hasMore 必须是布尔值")
    if not isinstance(body.get("nextSince"), str) or not body["nextSince"]:
        errors.append("nextSince 必须保留非空游标，包括空 items")
    items = body.get("items")
    if not isinstance(items, list):
        return errors + ["items 必须是数组"]
    count = body.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or count != len(items):
        errors.append("count 与 items 长度不一致")
    if len(items) > limit:
        errors.append("返回条数超过请求 limit")
    for index, item in enumerate(items):
        errors.extend(f"条目 {index + 1}: {problem}" for problem in item_errors(item))
    return errors


def scan_pages(base: str, token: str, *, page_size: int = 50, max_pages: int = 100, since: str | None = None) -> Scan:
    result = Scan(next_since=since)
    visited = {since} if since else set()
    problem, protocol_ok = "", True
    for number in range(1, max_pages + 1):
        query = {"limit": str(page_size)}
        if result.next_since:
            query["since"] = result.next_since
        status, body = request(base, "/api/stepx/v1/items?" + urllib.parse.urlencode(query), token)
        if status != 200:
            problem, protocol_ok = f"第 {number} 页 HTTP {status}", False
            break
        errors = envelope_errors(body, page_size)
        if errors:
            problem, protocol_ok = f"第 {number} 页：" + "；".join(errors[:3]), False
            break
        items, next_since = body["items"], body["nextSince"]
        if next_since in visited and (items or body["hasMore"] or next_since != result.next_since):
            problem, protocol_ok = f"第 {number} 页游标未推进或形成循环", False
            break
        visited.add(next_since)
        result.items.extend(items)
        result.next_since = next_since  # 空页也保存 checkpoint。
        result.pages = number
        if not body["hasMore"]:
            result.complete = True
            break
    if not result.complete and not problem:
        problem = f"达到 max-pages={max_pages} 且 hasMore=true，未完成分页；调高上限后重跑"
    result.checks = [
        Check("每页 schema、count、必填字段与来源正确", protocol_ok, f"已校验 {result.pages} 页" if protocol_ok else problem),
        Check("分页读取至 hasMore=false，游标推进自洽", result.complete, problem or f"{result.pages} 页，{len(result.items)} 个事件；同 ID 多次变更合法"),
    ]
    return result


def apply_items(current: dict[str, dict], items: list[dict]) -> None:
    for item in items:
        if item["tombstone"]:
            current.pop(item["externalId"], None)
        else:
            current[item["externalId"]] = item


def run(base: str, token: str, *, page_size: int = 50, max_pages: int = 100) -> list[Check]:
    checks: list[Check] = []
    for name, credential in [("无 token", None), ("错误 token", token + "x")]:
        status, _ = request(base, "/api/stepx/v1/items?limit=1", credential)
        checks.append(Check(f"{name}应返回 401", status == 401, f"HTTP {status}"))
    scan = scan_pages(base, token, page_size=page_size, max_pages=max_pages)
    checks.extend(scan.checks)
    if scan.complete:
        followup = scan_pages(base, token, page_size=page_size, max_pages=max_pages, since=scan.next_since)
        checks.extend(Check("增量续读：" + check.name, check.ok, check.detail) for check in followup.checks)
        if followup.complete:
            scan.items.extend(followup.items)
    current: dict[str, dict] = {}
    apply_items(current, scan.items)
    if current:
        first = next(iter(current.values()))
        eid = urllib.parse.quote(first["externalId"], safe="")
        status, body = request(base, f"/api/stepx/v1/items/{eid}", token)
        single = body.get("item") if isinstance(body, dict) else None
        valid = status == 200 and isinstance(body, dict) and body.get("schema") == SCHEMA and not item_errors(single)
        same = valid and single["externalId"] == first["externalId"] and single["tombstone"] is False and single["title"] == first["title"]
        checks.append(Check("单条标题与本次读取的最新事件一致", same, f"HTTP {status}；并发修改可能需要重跑" if not same else f"HTTP {status}"))
    else:
        checks.append(Check("至少有一条有效精选用于单条核对", False, "当前无有效条目，单条标题尚未验证"))
    status, body = request(base, "/api/stepx/v1/items/aihot:contract-missing-00000000", token)
    single = body.get("item") if isinstance(body, dict) else None
    tombstone = (status == 200 and isinstance(body, dict) and body.get("schema") == SCHEMA and not item_errors(single)
                 and single["tombstone"] is True and single["externalId"] == "aihot:contract-missing-00000000")
    checks.append(Check("不存在 ID 返回完整 tombstone（不证明真实撤回）", tombstone, f"HTTP {status}"))
    status, body = request(base, "/api/stepx/v1/items?since=1792728000000&limit=1", token)
    checks.append(Check("旧毫秒游标明确要求重新快照", status == 409 and isinstance(body, dict) and body.get("error") == "snapshot_required", f"HTTP {status}"))
    return checks


def self_test() -> int:
    def make_item(number: int) -> dict:
        return dict(externalId=f"aihot:id-{number}", sourceItemId=f"id-{number}", tombstone=False,
                    title=f"海洋条目 {number}", summary="摘要", originalTitle=None, language="zh", sourceName="NOAA",
                    originalUrl=f"https://example.org/{number}", aihotUrl=None, publishedAt="2026-10-22T00:00:00.000Z",
                    updatedAt="2026-10-23T01:00:00.000Z", category="climate", tags=["论文/研究"], score=70,
                    reason=None, storyId=None, storyTitle=None, bodyText=None, author=None)

    def tombstone_of(eid: str) -> dict:
        result = dict.fromkeys(REQUIRED)
        result.update(externalId=eid, sourceItemId=eid.removeprefix("aihot:"), tombstone=True,
                      updatedAt="2026-10-23T02:00:00.000Z", tags=[])
        return result

    class Handler(BaseHTTPRequestHandler):
        token = "local-contract-test-credential"
        current = {item["externalId"]: item for item in [make_item(number) for number in range(5)]}
        changes: list[dict] = []
        snapshots: dict[int, tuple[list[dict], int]] = {}
        snapshot_id = 0
        fault: str | None = None

        def log_message(self, *args):
            pass

        def send_json(self, code: int, body: object):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            cls = type(self)
            url = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(url.path)
            if self.headers.get("authorization", "") != f"Bearer {self.token}":
                return self.send_json(401, {"error": "unauthorized"})
            if path.startswith("/api/stepx/v1/items/aihot:"):
                eid = path.rsplit("/", 1)[-1]
                return self.send_json(200, {"schema": SCHEMA, "item": cls.current.get(eid, tombstone_of(eid))})
            if path != "/api/stepx/v1/items":
                return self.send_json(404, {"error": "not_found"})
            query = urllib.parse.parse_qs(url.query)
            limit, since = int(query.get("limit", ["50"])[0]), query.get("since", [None])[0]
            if since is None:
                cls.snapshot_id += 1
                snapshot_id, start, mode = cls.snapshot_id, 0, "page"
                cls.snapshots[snapshot_id] = (copy.deepcopy(list(cls.current.values())), len(cls.changes))
            else:
                page = re.fullmatch(r"ax1\.fake-page\.(\d+)\.(\d+)", since)
                sync = re.fullmatch(r"ax1\.fake-sync\.(\d+)", since)
                if page:
                    snapshot_id, start = map(int, page.groups())
                    mode = "page"
                elif sync:
                    start, mode = int(sync.group(1)), "sync"
                else:
                    return self.send_json(409, {"error": "snapshot_required"})
            if mode == "page":
                snapshot, revision = cls.snapshots[snapshot_id]
                items = copy.deepcopy(snapshot[start:start + limit])
                more = start + len(items) < len(snapshot)
                next_since = f"ax1.fake-page.{snapshot_id}.{start + len(items)}" if more else f"ax1.fake-sync.{revision}"
            else:
                items = copy.deepcopy(cls.changes[start:start + limit])
                more = start + len(items) < len(cls.changes)
                next_since = f"ax1.fake-sync.{start + len(items)}"
            body = dict(schema=SCHEMA, generatedAt="2026-10-23T03:00:00.000Z", nextSince=next_since,
                        hasMore=more, count=len(items), items=items)
            if mode == "page" and start > 0:
                if cls.fault == "schema":
                    body["schema"] = "wrong-version"
                elif cls.fault == "count":
                    body["count"] += 1
                elif cls.fault == "fields" and items:
                    del items[0]["summary"]
                elif cls.fault == "source" and items:
                    items[0]["sourceName"] = None
                elif cls.fault == "cursor":
                    body["nextSince"] = since
                elif cls.fault == "cycle" and start >= 4:
                    body["nextSince"] = f"ax1.fake-page.{snapshot_id}.2"
            if cls.fault == "empty-cursor" and not items:
                body["nextSince"] = None
            return self.send_json(200, body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base, checks = f"http://127.0.0.1:{server.server_port}", []
    try:
        checks.extend(run(base, Handler.token, page_size=2, max_pages=20))
        initial = scan_pages(base, Handler.token, page_size=2, max_pages=20)
        local: dict[str, dict] = {}
        apply_items(local, initial.items)
        checks.append(Check("模拟：首次完整快照覆盖全部 5 条", initial.complete and local == Handler.current))
        idle = scan_pages(base, Handler.token, page_size=2, max_pages=20, since=initial.next_since)
        checks.append(Check("模拟：空增量保留原游标", idle.complete and not idle.items and idle.next_since == initial.next_since))
        added = make_item(5)
        Handler.current[added["externalId"]] = added
        Handler.changes.append(copy.deepcopy(added))
        for title in ["海洋条目 0 第一次更正", "海洋条目 0 第二次更正"]:
            changed = dict(Handler.current["aihot:id-0"], title=title, updatedAt="2026-10-23T02:00:00.000Z")
            Handler.current["aihot:id-0"] = changed
            Handler.changes.append(copy.deepcopy(changed))
        del Handler.current["aihot:id-1"]
        Handler.changes.append(tombstone_of("aihot:id-1"))
        delta = scan_pages(base, Handler.token, page_size=2, max_pages=20, since=idle.next_since)
        apply_items(local, delta.items)
        checks.append(Check("模拟：第二轮新增可见，旧发布时间不影响同步", delta.complete and "aihot:id-5" in local))
        repeated = [item for item in delta.items if item["externalId"] == "aihot:id-0"]
        checks.append(Check("模拟：同 ID 多次更新合法，最后一次生效", len(repeated) == 2 and local["aihot:id-0"]["title"].endswith("第二次更正")))
        checks.append(Check("模拟：先发布再撤回，增量 tombstone 下架", any(item["tombstone"] and item["externalId"] == "aihot:id-1" for item in delta.items) and "aihot:id-1" not in local and local == Handler.current))
        status, body = request(base, "/api/stepx/v1/items/aihot:id-1", Handler.token)
        checks.append(Check("模拟：已知撤回条目单条也返回 tombstone", status == 200 and body["item"]["tombstone"] is True))
        again = scan_pages(base, Handler.token, since=delta.next_since)
        checks.append(Check("模拟：后续空轮询继续保留 checkpoint", again.complete and not again.items and again.next_since == delta.next_since))
        for fault, label in [("schema", "后续页 schema 错误"), ("count", "后续页 count 错误"),
                             ("fields", "后续页缺必填字段"), ("source", "后续页缺来源"),
                             ("cursor", "游标不推进"), ("cycle", "游标回到先前页面形成循环")]:
            Handler.fault = fault
            bad = scan_pages(base, Handler.token, page_size=2, max_pages=20)
            checks.append(Check("模拟负例：能拒绝" + label, not bad.complete and any(not check.ok for check in bad.checks)))
        Handler.fault = "empty-cursor"
        bad = scan_pages(base, Handler.token, since=delta.next_since)
        checks.append(Check("模拟负例：能拒绝空页丢失游标", not bad.complete))
        Handler.fault = None
        capped = scan_pages(base, Handler.token, page_size=2, max_pages=1)
        checks.append(Check("模拟负例：达到页数上限明确报告未完成", not capped.complete and not capped.checks[-1].ok and "max-pages=1" in capped.checks[-1].detail))
    finally:
        server.shutdown()
        server.server_close()
    print("仅本地模拟服务自测；通过不代表已连接或验证真实 AIHOT / stepx 服务。\n")
    return report(checks)


def report(checks: list[Check]) -> int:
    failed = 0
    for check in checks:
        print(f"{'PASS' if check.ok else 'FAIL'}  {check.name}" + (f"  ({check.detail})" if check.detail else ""))
        failed += not check.ok
    print(f"\n{len(checks) - failed}/{len(checks)} 通过")
    return int(failed > 0)


def main() -> int:
    parser = argparse.ArgumentParser(description="stepx 只读同步契约检查；不修改远端数据")
    parser.add_argument("--base", help="AIHOT 地址，例如 https://ocean.example.cn")
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--token", help="STEPX_TOKEN（推荐改用 --token-env，避免进程参数泄漏）")
    credentials.add_argument("--token-env", metavar="NAME", help="读取指定环境变量，默认 STEPX_TOKEN")
    parser.add_argument("--max-pages", type=int, default=100, help="每轮最大页数；仍有更多时失败，默认 100")
    parser.add_argument("--page-size", type=int, default=50, help="每页 1–200 条，默认 50")
    parser.add_argument("--self-test", action="store_true", help="仅用本地模拟服务验证检查器")
    args = parser.parse_args()
    if args.max_pages < 1 or not 1 <= args.page_size <= 200:
        parser.error("--max-pages 必须为正数，--page-size 必须在 1–200")
    if args.self_test:
        return self_test()
    token = args.token if args.token is not None else os.environ.get(args.token_env or "STEPX_TOKEN")
    if not args.base or not token:
        parser.error("需要 --base 和 token；先设置环境变量，再传 --token-env STEPX_TOKEN")
    parsed = urllib.parse.urlparse(args.base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("--base 必须是无内嵌凭据、查询参数或片段的 HTTP(S) 地址")
    print("只读契约检查；不存在 ID 的 tombstone 不等于真实撤回验收。\n")
    return report(run(args.base, token, page_size=args.page_size, max_pages=args.max_pages))


if __name__ == "__main__":
    raise SystemExit(main())
