"""Loopback-only launcher checks; no source fetches, model calls or browser launch."""
from __future__ import annotations

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / 'launch-reader.py'
SPEC = importlib.util.spec_from_file_location('ocean_launcher', LAUNCHER)
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def available_port():
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


def command(port):
    return [sys.executable, str(LAUNCHER), '--no-open', '--port', str(port)]


class OtherProjectHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.send_header('X-Ocean-Reader', '1')
        self.send_header('X-Ocean-Reader-Project', 'another-project')
        self.end_headers()

    def log_message(self, *_):
        pass


class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = available_port()
        cls.process = subprocess.Popen(command(cls.port), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 10
        while not launcher.is_this_reader(cls.port):
            if cls.process.poll() is not None or time.monotonic() > deadline:
                cls.process.terminate()
                outputs = cls.process.communicate(timeout=5)
                raise AssertionError(f'Reader did not start: {outputs!r}')
            time.sleep(.05)

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.communicate(timeout=5)

    def request(self, path):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            response.read()
            return response.status, dict(response.getheaders())
        finally:
            connection.close()

    def test_identifies_this_checkout(self):
        self.assertTrue(launcher.is_this_reader(self.port))

    def test_repeated_launcher_reuses_reader_with_utf8_output(self):
        result = subprocess.run(command(self.port), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8'))
        self.assertIn('已经运行', result.stdout.decode('utf-8', errors='strict'))

    def test_index_has_safe_cache_and_content_headers(self):
        status, headers = self.request('/')
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('Cache-Control'), 'no-store')
        self.assertEqual(headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(headers.get('X-Ocean-Reader-Project'), launcher.READER_ID)

    def test_project_files_and_traversal_are_not_served(self):
        for path in ['/../launch-reader.py', '/%2e%2e/launch-reader.py', '/engine/.env', '/launch-reader.py']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_other_project_on_port_is_refused(self):
        other = ThreadingHTTPServer(('127.0.0.1', 0), OtherProjectHandler)
        port = other.server_address[1]
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertFalse(launcher.is_this_reader(port))
            result = subprocess.run(command(port), capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn('已占用', result.stderr.decode('utf-8', errors='strict'))
            self.assertNotIn('已经运行', result.stdout.decode('utf-8'))
        finally:
            other.shutdown()
            other.server_close()
            thread.join(timeout=2)

    def test_resolved_path_cannot_escape_site(self):
        handler = object.__new__(launcher.ReaderHandler)
        handler.directory = str(ROOT / 'site')
        outside = str(ROOT / 'engine' / '.env')
        with patch.object(launcher.SimpleHTTPRequestHandler, 'translate_path', return_value=outside):
            self.assertEqual(handler.translate_path('/escape-link'), str(ROOT / 'site' / '.unavailable'))


if __name__ == '__main__':
    unittest.main()
