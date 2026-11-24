"""Local HTTP server to run TUM Free Rooms on localhost."""

from __future__ import annotations

import argparse
import errno
import functools
import mimetypes
import socket
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent

CUSTOM_MIME_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class LocalHTTPServer(ThreadingHTTPServer):
    """Prevents duplicate port binding on Windows."""

    allow_reuse_address = False


class StaticPwaHandler(SimpleHTTPRequestHandler):
    """Static HTTP handler with proper PWA MIME types and no-store caching."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        **CUSTOM_MIME_TYPES,
    }

    def guess_type(self, path: str) -> str:
        ext = Path(path).suffix.lower()
        if ext in CUSTOM_MIME_TYPES:
            return CUSTOM_MIME_TYPES[ext]
        guessed = super().guess_type(path)
        if guessed.startswith("text/") and "charset=" not in guessed:
            return f"{guessed}; charset=utf-8"
        return guessed

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description="Start local HTTP server for TUM Free Rooms.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765)")
    parser.add_argument("--no-open", action="store_true", help="Do not open browser automatically")
    args = parser.parse_args()

    mimetypes.init()
    for ext, mime in CUSTOM_MIME_TYPES.items():
        mimetypes.add_type(mime, ext)

    handler = functools.partial(StaticPwaHandler, directory=str(ROOT_DIR))
    url = f"http://{args.host}:{args.port}/"

    try:
        with socket.create_connection((args.host, args.port), timeout=0.4):
            print(f"Server already running at {url} — opening browser.")
            if not args.no_open:
                webbrowser.open(url)
            return
    except OSError:
        pass

    try:
        server = LocalHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        if exc.errno in (errno.EADDRINUSE, 10048):
            print(f"Server already running at {url} — opening browser.")
            if not args.no_open:
                webbrowser.open(url)
            return
        raise

    print(f"TUM Free Rooms running at {url} (close this window or press Ctrl+C to stop)")

    if not args.no_open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
