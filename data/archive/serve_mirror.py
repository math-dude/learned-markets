#!/usr/bin/env python3
"""Serve a local Old Faithful mirror over HTTP with Range support (HEAD + GET, sendfile).

Point Jetstreamer at it with JETSTREAMER_HTTP_BASE_URL=http://127.0.0.1:8765/ (and the same for
JETSTREAMER_COMPACT_INDEX_BASE_URL). Only finished files are served; `.part` files return 404.

Usage: serve_mirror.py [root] [port]
"""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else "/data/oldfaithful")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _resolve(self):
        rel = self.path.split("?", 1)[0].lstrip("/")
        p = os.path.realpath(os.path.join(ROOT, rel))
        if not p.startswith(ROOT + os.sep) or p.endswith((".part", ".done")) or not os.path.isfile(p):
            return None
        return p

    def _err(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _start(self, head):
        p = self._resolve()
        if p is None:
            print(f"404 {self.command} {self.path}", file=sys.stderr, flush=True)
            self._err(404)
            return None
        size = os.path.getsize(p)
        start, end, code = 0, size - 1, 200
        rh = self.headers.get("Range")
        if rh:
            m = RANGE.match(rh.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self._err(416)
                return None
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            code = 206
        self.send_response(code)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        return p, start, end

    def do_HEAD(self):
        self._start(True)

    def do_GET(self):
        r = self._start(False)
        if r is None:
            return
        p, start, end = r
        with open(p, "rb") as f:
            off, left = start, end - start + 1
            try:
                while left > 0:
                    sent = os.sendfile(self.wfile.fileno(), f.fileno(), off, min(left, 16 << 20))
                    if sent == 0:
                        break
                    off += sent
                    left -= sent
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True


class S(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256


if __name__ == "__main__":
    print(f"serving {ROOT} on 127.0.0.1:{PORT}", flush=True)
    S(("127.0.0.1", PORT), H).serve_forever()
