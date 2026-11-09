#!/usr/bin/env python3
"""Serve the sim locally and open it in a new Chrome tab: python3 sim/run.py"""
import functools
import http.server
import json
import subprocess
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
USERS = HERE.parent / "logs" / "users"   # per-person data (git-ignored), shared with tools/ssvep_train.py
FIRST_PORT = 8000
MAX_PROFILE = 2_000_000                  # bytes


PER_PERSON = {
    "/profiles/": "gaze_profile.json",           # the eye tracker's saved face model and gaze mapping
    "/gazelearn/": "ttt_gaze_learning.json",     # tic-tac-toe camera tab: what it learned from confirmed choices
}


def profile_path(url):
    """/profiles/<name>.json -> logs/users/<name>/gaze_profile.json, /gazelearn/<name>.json -> .../ttt_gaze_learning.json."""
    for prefix, filename in PER_PERSON.items():
        if url.startswith(prefix) and url.endswith(".json"):
            name = "".join(c for c in url[len(prefix):-5].lower() if c.isalnum() or c in "-_")
            return USERS / name / filename if name else None
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # edits show up on refresh
        super().end_headers()

    def log_message(self, *args):
        pass

    def _reply(self, code, body, kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = profile_path(self.path.split("?")[0])
        if path is None:
            return super().do_GET()
        if not path.is_file():
            return self._reply(404, b'{"error": "no saved profile"}')
        return self._reply(200, path.read_bytes())

    def do_POST(self):
        path = profile_path(self.path.split("?")[0])
        n = int(self.headers.get("Content-Length") or 0)
        if path is None or not 0 < n <= MAX_PROFILE:
            return self._reply(400, b'{"error": "bad request"}')
        body = self.rfile.read(n)
        try:
            json.loads(body)
        except ValueError:
            return self._reply(400, b'{"error": "not JSON"}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return self._reply(200, json.dumps({"ok": True, "file": str(path.relative_to(HERE.parent))}).encode())



def bind():
    handler = functools.partial(Handler, directory=str(HERE))
    for port in range(FIRST_PORT, FIRST_PORT + 20):
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler), port
        except OSError:
            continue
    sys.exit(f"No free port between {FIRST_PORT} and {FIRST_PORT + 19}")


def open_tab(url):
    if sys.platform == "darwin":
        if subprocess.run(["open", "-a", "Google Chrome", url]).returncode == 0:
            return
    webbrowser.open_new_tab(url)


def main():
    server, port = bind()
    url = f"http://127.0.0.1:{port}/"
    print(f"Sim running at {url} (Ctrl+C to stop)", flush=True)
    if "--no-open" not in sys.argv:
        open_tab(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
