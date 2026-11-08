#!/usr/bin/env python3
"""Serve the sim locally and open it in a new Chrome tab: python3 sim/run.py"""
import functools
import http.server
import subprocess
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
USERS = HERE.parent / "logs" / "users"  # recorded EEG (git-ignored), written by tools/ssvep_train.py
FIRST_PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # edits show up on refresh
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_GET(self):
        # /eeg/<user>.json -> that person's recorded SSVEP replay file
        if self.path.startswith("/eeg/") and self.path.endswith(".json"):
            user = "".join(c for c in self.path[5:-5] if c.isalnum() or c in "-_")
            path = USERS / user / "sim_replay.json"
            if not path.is_file():
                self.send_error(404, f"No EEG replay for '{user}'. Run tools/ssvep_train.py --user {user} and press Train.")
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


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
