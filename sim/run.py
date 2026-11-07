#!/usr/bin/env python3
"""Serve the sim locally and open it in a browser tab.

macOS / Linux:  python3 sim/run.py
Windows:        double-click "Start sim.bat", or run  py sim\run.py
"""
import functools
import http.server
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIRST_PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    # Python guesses file types from the OS. On Windows that means the registry,
    # which often says .js is text/plain, and browsers then refuse to run the
    # sim's modules (it sits on "Loading"). So the types are set here.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".bin": "application/octet-stream",
        ".svg": "image/svg+xml",
        ".png": "image/png",
    }

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


def windows_chrome():
    for root in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
        if root:
            exe = Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if exe.exists():
                return exe
    return None


def open_tab(url):
    if sys.platform == "darwin":
        if subprocess.run(["open", "-a", "Google Chrome", url]).returncode == 0:
            return
    elif sys.platform == "win32":
        chrome = windows_chrome()
        if chrome:
            subprocess.Popen([str(chrome), url])
            return
    webbrowser.open_new_tab(url)  # the default browser; Edge and Firefox work too


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
