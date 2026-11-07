#!/usr/bin/env python3
"""Serve the sim locally and open it in a new Chrome tab: python3 sim/run.py"""
import functools
import http.server
import subprocess
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIRST_PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # edits show up on refresh
        super().end_headers()

    def log_message(self, *args):
        pass


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
