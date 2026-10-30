"""Loopback-only server. No song data leaves this computer."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import tempfile
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from importers import ImportFailure, read_rocksmith, read_tonelib

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache/songs"
IMPORT_LOCK = threading.Lock()
CACHE_VERSION = b"tab-player-chart-v1\0"


def prepare(path: Path, original_name: str | None = None) -> dict:
    name = original_name or path.name
    suffix = Path(name).suffix.lower()
    if suffix not in (".song", ".psarc"):
        raise ImportFailure("Choose a ToneLib .song or Windows Rocksmith .psarc file.")
    digest = hashlib.sha256(CACHE_VERSION)
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    key = digest.hexdigest()
    CACHE.mkdir(parents=True, exist_ok=True)
    destination = CACHE / key
    with IMPORT_LOCK:
        manifest = destination / "chart.json"
        if manifest.exists():
            chart = json.loads(manifest.read_text(encoding="utf-8"))
            if (destination / chart["audio_file"]).exists():
                return chart
        with tempfile.TemporaryDirectory(prefix="preparing-", dir=CACHE) as working:
            staging = Path(working)
            chart = (read_tonelib if suffix == ".song" else read_rocksmith)(path, staging)
            chart.update(id=key, filename=name, audio_url=f"/songs/{key}/{chart['audio_file']}")
            (staging / "chart.json").write_text(json.dumps(chart, ensure_ascii=False), encoding="utf-8")
            destination.mkdir(exist_ok=True)
            for item in staging.iterdir():
                item.replace(destination / item.name)
        return chart


def byte_range(value: str | None, size: int) -> tuple[int, int, bool]:
    if value is None:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not size:
        raise ValueError("Invalid range")
    left, right = match.groups()
    if not left:
        if not right or int(right) <= 0:
            raise ValueError("Invalid suffix range")
        start, end = max(0, size - int(right)), size - 1
    else:
        start, end = int(left), min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise ValueError("Unsatisfiable range")
    return start, end, True


class Handler(BaseHTTPRequestHandler):
    server_version = "TabPlayer/0.1"

    def log_message(self, message, *args):
        if len(args) < 2 or str(args[1]) not in ("200", "206", "304"):
            super().log_message(message, *args)

    def json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.path != "/api/open":
            return self.json({"error": "Not found"}, 404)
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.json({"error": "Open songs from the local player window."}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024 * 1024 * 1024:
                raise ImportFailure("Choose a song file smaller than 1 GB.")
            name = parse_qs(parts.query).get("name", [""])[0]
            if Path(name).suffix.lower() not in (".song", ".psarc"):
                raise ImportFailure("Choose a ToneLib .song or Windows Rocksmith .psarc file.")
            incoming = ROOT / ".cache/incoming"
            incoming.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=incoming) as folder:
                source = Path(folder) / ("selected" + Path(name).suffix.lower())
                with source.open("wb") as file:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ImportFailure("The selected file could not be read completely.")
                        file.write(chunk)
                        remaining -= len(chunk)
                chart = prepare(source, name)
            self.json(chart)
        except ImportFailure as error:
            self.json({"error": str(error)}, 422)
        except Exception:
            traceback.print_exc()
            self.json({"error": "This file could not be opened by the prototype. Try another .song or _p.psarc file."}, 422)

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        path = urlsplit(self.path).path
        if path == "/api/health":
            return self.json({"app": "tab-player", "version": "0.1.0"})
        if path.startswith("/songs/"):
            match = re.fullmatch(r"/songs/([a-f0-9]{64})/(chart\.json|audio\.(?:wav|flac|ogg))", path)
            if not match:
                return self.send_error(404)
            file = CACHE / match[1] / match[2]
        elif path in ("/vendor/three.module.js", "/vendor/three.core.js"):
            file = ROOT / "node_modules/three/build" / path.rsplit("/", 1)[-1]
        else:
            static = {"/": "index.html", "/app.js": "app.js", "/highway.js": "highway.js",
                      "/timeline.js": "timeline.js", "/style.css": "style.css"}
            if path not in static:
                return self.send_error(404)
            file = ROOT / "static" / static[path]
        if not file.is_file():
            return self.send_error(404)
        size = file.stat().st_size
        try:
            start, end, partial = byte_range(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        content_type = {".js": "text/javascript", ".flac": "audio/flac", ".wav": "audio/wav"}.get(file.suffix)
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(str(file))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if path.startswith("/songs/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not head_only:
            try:
                with file.open("rb") as source:
                    source.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = source.read(min(128 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # A seek or a new song legitimately cancels an audio request.


class LocalServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR can allow two players to bind the same port.
    allow_reuse_address = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--file", type=Path, help="Preload a song for development or testing")
    args = parser.parse_args()
    chart = prepare(args.file) if args.file else None
    try:
        server = LocalServer(("127.0.0.1", args.port), Handler)
    except OSError:
        # A second double-click should return to the already running player.
        url = f"http://127.0.0.1:{args.port}/"
        try:
            with urlopen(url + "api/health", timeout=1) as response:
                existing = json.load(response).get("app") == "tab-player"
        except Exception:
            existing = False
        if existing and not args.no_browser:
            webbrowser.open(url + (f"?song={chart['id']}" if chart else ""))
            print(f"Tab Player is already running: {url}", flush=True)
            return
        raise
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}/"
    if chart:
        url += f"?song={chart['id']}"
    print(f"Tab Player: {url}", flush=True)
    print("Keep this window open while playing. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
