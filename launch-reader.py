#!/usr/bin/env python3
"""Open the local ocean reader. Serves only site/ on loopback; no model calls."""
from __future__ import annotations

import argparse
from functools import partial
import hashlib
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent
READER_ID = hashlib.sha256(str(ROOT).casefold().encode('utf-8')).hexdigest()[:24]


class ReaderServer(ThreadingHTTPServer):
    # Windows can otherwise bind a second SO_REUSEADDR socket over the first one.
    allow_reuse_address = False
    allow_reuse_port = False


class ReaderHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Ocean-Reader', '1')
        self.send_header('X-Ocean-Reader-Project', READER_ID)
        super().end_headers()

    def translate_path(self, path):
        candidate = Path(super().translate_path(path)).resolve()
        # Never follow a link from site/ into engine credentials or another directory.
        if not candidate.is_relative_to((ROOT / 'site').resolve()):
            return str(ROOT / 'site' / '.unavailable')
        return str(candidate)


def is_this_reader(port):
    """Recognize this exact local checkout, without following redirects or proxies."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1.5)
    try:
        connection.request('HEAD', '/index.html')
        response = connection.getresponse()
        return (response.status == 200
                and response.getheader('X-Ocean-Reader') == '1'
                and response.getheader('X-Ocean-Reader-Project') == READER_ID)
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description='海洋阅读页：仅在本机打开，无付费模型调用。')
    parser.add_argument('--refresh', action='store_true', help='打开前读取公开订阅；失败时保留旧快照')
    parser.add_argument('--no-open', action='store_true', help='只启动本机服务，不自动打开浏览器')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error('需要 Python 3.11 或以上。')
    if not 1024 <= args.port <= 65535:
        parser.error('端口需在 1024 到 65535 之间。')
    if not (ROOT / 'site/index.html').is_file():
        parser.error('缺少 site/index.html，请完整解压项目。')
    if args.refresh:
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/refresh.py'), '--config', str(ROOT / 'config/sources.json'), '--output-dir', str(ROOT / 'site')], cwd=ROOT, check=False)
        if result.returncode:
            print('本轮更新未完成；阅读页将显示保留的数据与来源状态。', flush=True)
    url = f'http://127.0.0.1:{args.port}/'
    if is_this_reader(args.port):
        print(f'海洋阅读页已经运行：{url}\n已重新打开阅读页；原来的服务窗口请继续保留。', flush=True)
        if not args.no_open:
            webbrowser.open(url, new=2)
        return 0
    try:
        handler = partial(ReaderHandler, directory=str(ROOT / 'site'))
        server = ReaderServer(('127.0.0.1', args.port), handler)
        server.daemon_threads = True
    except OSError:
        if is_this_reader(args.port):
            url = f'http://127.0.0.1:{args.port}/'
            print(f'海洋阅读页已经运行：{url}\n已重新打开阅读页；原来的服务窗口请继续保留。', flush=True)
            if not args.no_open:
                webbrowser.open(url, new=2)
            return 0
        print(f'本机端口 {args.port} 已占用。已有阅读窗口请继续使用；或用 --port 8766 指定另一个端口。', file=sys.stderr)
        return 1
    print(f'海洋阅读页：{url}\n保留此窗口即可阅读；按 Ctrl+C 关闭。\n页面刷新读取已有快照，更新公开订阅请运行“更新订阅.cmd”。', flush=True)
    if not args.no_open:
        webbrowser.open(url, new=2)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n海洋阅读服务已关闭。', flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
