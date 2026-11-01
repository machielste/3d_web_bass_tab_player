"""Exercise the extracted portable build in isolation before publishing its ZIP."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import wave
import zipfile
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener


def make_fixture(path: Path):
    audio = BytesIO()
    with wave.open(audio, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(bytes(16000))
    score = """<Score><info><name>Portable fixture</name></info>
      <BarIndex><Bar id="1" tempo="120"><time_sign numerator="4" duration="4"/></Bar></BarIndex>
      <Tracks><Track name="Bass"><Strings>
      <String id="1" tuning="43"/><String id="2" tuning="38"/>
      <String id="3" tuning="33"/><String id="4" tuning="28"/>
      </Strings><Bars><Bar id="1"><Beat duration="4"><Note fret="5" string="4"/></Beat>
      </Bar></Bars></Track></Tracks><Backing_track1><audio><data_file>audio.wav</data_file>
      </audio></Backing_track1></Score>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("the_song.dat", score)
        archive.writestr("audio.wav", audio.getvalue())


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


@contextmanager
def player(executable: Path, working: Path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    environment = os.environ.copy()
    windows = Path(environment.get("SystemRoot", r"C:\Windows"))
    environment["PATH"] = os.pathsep.join(str(p) for p in (
        windows / "System32", windows, windows / "System32/WindowsPowerShell/v1.0"))
    for name in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        environment.pop(name, None)
    opener = build_opener(ProxyHandler({}))

    def request(path, data=None, headers=None):
        payload = json.dumps(data).encode() if isinstance(data, dict) else data
        request_headers = {"Content-Type": "application/json"} if isinstance(data, dict) else {}
        request_headers.update(headers or {})
        with opener.open(Request(f"http://127.0.0.1:{port}{path}", data=payload, headers=request_headers), timeout=10) as response:
            body = response.read()
            return json.loads(body) if response.headers.get_content_type() == "application/json" else body

    with (working / "server.log").open("w+b") as log:
        process = subprocess.Popen([str(executable), "--no-browser", "--port", str(port)],
                                   cwd=working, env=environment, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError("Portable server exited:\n" + log.read().decode(errors="replace"))
                try:
                    require(request("/api/health")["app"] == "tab-player", "Unexpected server on the smoke-test port.")
                    break
                except URLError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Portable server did not become ready within 30 seconds.")
                    time.sleep(.1)
            yield request
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)


def wait_for(check, description):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise RuntimeError(f"Portable check timed out: {description}")


def check_portable(archive: Path, destination: Path, static_names: list[str]):
    destination.mkdir(parents=True)
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            parts = Path(name).parts
            require(not ({".data", ".cache", ".venv", ".git"} & set(parts)), f"Personal/development state in ZIP: {name}")
            require(Path(name).suffix.lower() not in (".song", ".psarc"), f"Song archive in ZIP: {name}")
        package.extractall(destination / "Folder with spaces")
    bundle = destination / "Folder with spaces/TabPlayer"
    working = destination / "Unrelated working directory"
    working.mkdir()
    songs = destination / "Test songs"
    songs.mkdir()
    fixture = songs / "portable.song"
    make_fixture(fixture)
    executable = bundle / "TabPlayer.exe"

    with player(executable, working) as request:
        status = request("/api/library/status")
        require(status["total"] == 0 and not status["roots"], "The packaged library must start empty.")
        for name in static_names:
            require(request("/" if name == "index.html" else "/" + name), f"Empty browser asset: {name}")
        for name in ("three.module.js", "three.core.js", "lines/LineSegments2.js", "lines/LineSegmentsGeometry.js", "lines/LineMaterial.js"):
            require(request("/vendor/" + name), f"Missing Three.js asset: {name}")
        chart = request("/api/open?name=portable.song", fixture.read_bytes(), {"Content-Type": "application/octet-stream"})
        require(chart["strings"] == ["E", "A", "D", "G"] and chart["notes"], "Portable song import failed.")
        require(request(chart["audio_url"], headers={"Range": "bytes=0-3"}) == b"RIFF", "Portable audio byte-range serving failed.")
        request("/api/library/folders/add", {"path": str(songs)})
        wait_for(lambda: request("/api/library/status")["total"] == 1, "library scan")
        song = request("/api/library/songs?q=Port")["items"][0]

        def job_result(kind):
            key = request("/api/library/" + kind, {"id": song["id"], "client": "portable-check", "selection": 1})["job"]

            def ready():
                job = request("/api/library/jobs/" + key)
                require(job["state"] != "error", f"Portable {kind} failed: {job.get('error')}")
                return job["result"] if job["state"] == "ready" else None

            return wait_for(ready, kind)

        preview = job_result("preview")
        require(request(preview["audio_url"], headers={"Range": "bytes=0-3"}) == b"RIFF", "Bundled decoder preview failed.")
        require(job_result("play")["id"] == chart["id"], "Library playback did not reuse the prepared chart.")

    require((bundle / ".data/library.sqlite3").is_file(), "Library was not saved beside TabPlayer.exe.")
    require((bundle / ".cache/songs" / chart["id"] / "chart.json").is_file(), "Song cache was not saved beside TabPlayer.exe.")
    require(not (bundle / "_internal/.data").exists(), "Library was written into bundled resources.")
    require(not (bundle / "_internal/.cache").exists(), "Cache was written into bundled resources.")
    require(not (working / ".data").exists(), "Library depends on the working directory.")
    with player(executable, working) as request:
        status = request("/api/library/status")
        require(status["total"] == 1 and len(status["roots"]) == 1, "Portable library did not persist across restart.")
        require(request(f"/songs/{chart['id']}/chart.json")["id"] == chart["id"], "Portable chart cache did not persist.")
    print("Portable checks passed: launch, browser assets, import, audio, scan/search, decoder preview and restart.", flush=True)
