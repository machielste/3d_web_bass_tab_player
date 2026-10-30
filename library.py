"""Persistent, metadata-only catalog and bounded, on-demand media work."""
from __future__ import annotations

import hashlib
import io
import json
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
import wave
import xml.etree.ElementTree as ET
import zipfile
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageOps

from importers import ImportFailure, Psarc, rocksmith_audio, rocksmith_bass, string_names

INDEX_VERSION = 1
EXCLUDED = {".git", ".cache", ".data", ".tools", ".venv", "node_modules", "$recycle.bin", "system volume information"}
CACHE_SWEEP_LOCK = threading.Lock()
CACHE_SWEEPS = {}


def identity(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def read_metadata(path: Path) -> list[dict]:
    if path.suffix.lower() == ".psarc":
        archive = Psarc(path)
        # One preferred bass arrangement per song, including multi-song packs.
        songs = {}
        for attrs in rocksmith_bass(archive):
            key = attrs.get("SongKey") or attrs.get("SongName") or attrs.get("SongAsset")
            if key in songs:
                continue
            tuning = [p + int(attrs.get("Tuning", {}).get(f"string{i}", 0)) for i, p in enumerate((28, 33, 38, 43))]
            art = attrs.get("AlbumArt", "").rsplit(":", 1)[-1]
            covers = [n for n in archive.files if n.startswith("gfxassets/album_art/") and Path(n).stem in (art + "_256", art + "_128", art + "_64", art)] if art else []
            cover = next((n for n in covers if n.endswith("_256.dds")), next(iter(covers), None))
            songs[key] = dict(selector=attrs.get("SongAsset", ""), title=attrs.get("SongName") or path.stem,
                              artist=attrs.get("ArtistName", ""), album=attrs.get("AlbumName", ""),
                              duration=float(attrs.get("SongLength", 0)), tuning=string_names(tuning),
                              format="Rocksmith 2014", cover=cover,
                              attrs={k: attrs[k] for k in ("SongBank", "PreviewBankPath") if k in attrs})
        return list(songs.values())
    with zipfile.ZipFile(path) as archive:
        if archive.getinfo("the_song.dat").file_size > 32 * 1024 * 1024:
            raise ImportFailure("ToneLib score exceeds the metadata limit.")
        root = ET.fromstring(archive.read("the_song.dat").rstrip(b"\0"))
        tracks = [t for t in root.findall("Tracks/Track") if len(t.findall("Strings/String")) in (4, 5)]
        if not tracks:
            return []
        track = next((t for t in tracks if "bass" in t.get("name", "").lower()), tracks[0])
        tuning = [int(s.attrib["tuning"]) for s in sorted(track.findall("Strings/String"), key=lambda s: int(s.attrib["id"]), reverse=True)]
        duration, tempo, numerator, denominator = 0, 120, 4, 4
        for bar in root.findall("BarIndex/Bar"):
            tempo = float(bar.get("tempo", tempo))
            signature = bar.find("time_sign")
            if signature is not None:
                numerator, denominator = int(signature.get("numerator", numerator)), int(signature.get("duration", denominator))
            if not 0 < tempo <= 1000 or numerator <= 0 or denominator <= 0:
                raise ImportFailure("Invalid ToneLib timing metadata.")
            duration += numerator * 4 / denominator * 60 / tempo
        entry = root.findtext("Backing_track1/audio/data_file")
        if not entry or entry not in archive.namelist():
            raise ImportFailure("No embedded backing audio.")
        return [dict(selector="", title=root.findtext("info/name") or path.stem,
                     artist=root.findtext("info/artist") or "", album=root.findtext("info/album") or "",
                     duration=duration, tuning=string_names(tuning), format="ToneLib", cover=None, audio_entry=entry)]


class Library:
    def __init__(self, database: Path, media: Path):
        database.parent.mkdir(parents=True, exist_ok=True)
        media.mkdir(parents=True, exist_ok=True)
        self.database, self.media = database, media
        self.wake, self.closed, self.interactive = threading.Event(), threading.Event(), threading.Event()
        self.state_lock = threading.Lock()
        self.progress = dict(scanning=False, checked=0, indexed=0, current="", error="", elapsed=0)
        self.snapshots = OrderedDict()
        self.snapshot_lock, self.art_lock = threading.Lock(), threading.Semaphore(2)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
              CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
              INSERT OR IGNORE INTO settings VALUES ('revision', 0);
              CREATE TABLE IF NOT EXISTS roots (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, available INTEGER DEFAULT 1, error TEXT DEFAULT '');
              CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER, mtime INTEGER, version INTEGER, error TEXT DEFAULT '');
              CREATE TABLE IF NOT EXISTS root_files (root INTEGER REFERENCES roots(id) ON DELETE CASCADE,
                file TEXT REFERENCES files(id), seen TEXT, present INTEGER DEFAULT 1, PRIMARY KEY(root,file));
              CREATE INDEX IF NOT EXISTS root_files_file ON root_files(file);
              CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, file TEXT REFERENCES files(id),
                title TEXT, artist TEXT, album TEXT, duration REAL, tuning TEXT, format TEXT,
                title_sort TEXT, artist_sort TEXT, metadata TEXT, prepared TEXT);
              CREATE INDEX IF NOT EXISTS songs_title ON songs(title_sort,id);
              CREATE INDEX IF NOT EXISTS songs_artist ON songs(artist_sort,title_sort,id);
              CREATE INDEX IF NOT EXISTS songs_file ON songs(file);
              CREATE VIRTUAL TABLE IF NOT EXISTS song_search USING fts5(id UNINDEXED, words, prefix='2 3 4');
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def start(self):
        self.thread = threading.Thread(target=self._run, name="library-index", daemon=True)
        self.thread.start()
        self.wake.set()

    def close(self):
        self.closed.set()
        self.wake.set()

    def add_root(self, value: str):
        path = Path(value).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise ImportFailure("Choose an existing folder on this computer.")
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO roots(path) VALUES (?)", (canonical(path),))
            self._revision(db)
        self.wake.set()

    def remove_root(self, root: int):
        with self.connect() as db:
            db.execute("DELETE FROM roots WHERE id=?", (root,))
            self._revision(db)
        self.wake.set()

    @staticmethod
    def _revision(db):
        db.execute("UPDATE settings SET value=value+1 WHERE key='revision'")

    def status(self):
        with self.connect() as db:
            roots = [dict(r) for r in db.execute("SELECT * FROM roots ORDER BY id")]
            count = db.execute("SELECT count(*) FROM songs s WHERE EXISTS (SELECT 1 FROM root_files rf WHERE rf.file=s.file)").fetchone()[0]
            skipped = db.execute("SELECT count(*) FROM files f WHERE f.error!='' AND EXISTS (SELECT 1 FROM root_files WHERE file=f.id)").fetchone()[0]
            revision = db.execute("SELECT value FROM settings WHERE key='revision'").fetchone()[0]
        with self.state_lock:
            return dict(self.progress, roots=roots, total=count, skipped=skipped, revision=revision)

    def errors(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT path,error FROM files f WHERE error!='' AND EXISTS(SELECT 1 FROM root_files WHERE file=f.id) LIMIT 30")]

    def _run(self):
        while not self.closed.is_set():
            self.wake.wait(300)  # Reconcile periodically; no watcher dependency.
            self.wake.clear()
            if self.closed.is_set():
                break
            self.scan()

    def scan(self):
        started = time.monotonic()
        with self.state_lock:
            self.progress.update(scanning=True, checked=0, indexed=0, current="", error="")
        try:
            with self.connect() as db:
                roots = list(db.execute("SELECT id,path FROM roots"))
            processed = set()
            for root in roots:
                self._scan_root(root, processed)
        except Exception as error:
            with self.state_lock:
                self.progress["error"] = str(error)
        finally:
            with self.state_lock:
                self.progress.update(scanning=False, current="", elapsed=round(time.monotonic() - started, 3))

    def _scan_root(self, root, processed):
        token = uuid.uuid4().hex
        walk_errors = []
        path = Path(root["path"])
        if not path.is_dir():
            with self.connect() as db:
                db.execute("UPDATE roots SET available=0,error='Folder is unavailable' WHERE id=?", (root["id"],))
                db.execute("UPDATE root_files SET present=0 WHERE root=?", (root["id"],))
                self._revision(db)
            return
        with self.connect() as db:
            known = {r["path"]: dict(r) for r in db.execute("SELECT * FROM files")}
        memberships = []
        for folder, dirs, names in os.walk(path, onerror=walk_errors.append, followlinks=False):
            dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED and not (Path(folder) / d).is_symlink()]
            for name in names:
                if self.closed.is_set():
                    return
                if Path(name).suffix.lower() not in (".song", ".psarc"):
                    continue
                while self.interactive.is_set() and not self.closed.wait(.05):
                    pass
                source = Path(folder) / name
                if source.is_symlink():
                    continue
                try:
                    stamp = source.stat()
                    # os.walk starts at an already canonical root. Avoid an
                    # extra filesystem resolution of every unchanged archive.
                    full = os.path.normcase(str(source))
                    file_id = identity(full)
                    memberships.append((root["id"], file_id, token))
                    if full not in processed:
                        previous = known.get(full)
                        if previous is None or (previous["size"], previous["mtime"], previous["version"]) != (stamp.st_size, stamp.st_mtime_ns, INDEX_VERSION):
                            self._index(source, full, file_id, stamp)
                        processed.add(full)
                        with self.state_lock:
                            self.progress["checked"] += 1
                            self.progress["current"] = name
                    if len(memberships) >= 32:
                        self._memberships(memberships)
                        memberships.clear()
                except OSError as error:
                    walk_errors.append(error)
        self._memberships(memberships)
        with self.connect() as db:
            # Never declare files removed after a partial/inaccessible traversal.
            if not walk_errors:
                db.execute("DELETE FROM root_files WHERE root=? AND seen!=?", (root["id"], token))
            db.execute("UPDATE roots SET available=1,error=? WHERE id=?", (str(walk_errors[0]) if walk_errors else "", root["id"]))
            self._revision(db)

    def _memberships(self, entries):
        with self.connect() as db:
            # A root can be removed while its scan is still in progress.
            for root, file, seen in entries:
                if db.execute("SELECT 1 FROM roots WHERE id=?", (root,)).fetchone():
                    db.execute("INSERT INTO root_files(root,file,seen,present) VALUES (?,?,?,1) ON CONFLICT(root,file) DO UPDATE SET seen=excluded.seen,present=1", (root, file, seen))

    def _index(self, source, full, file_id, stamp):
        error = ""
        try:
            records = read_metadata(source)
            if not records:
                error = "No supported bass arrangement"
        except Exception as failure:
            records, error = [], str(failure)[:300] or "Could not read metadata"
        with self.connect() as db:
            db.execute("INSERT INTO files(id,path,size,mtime,version,error) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,version=excluded.version,error=excluded.error",
                       (file_id, full, stamp.st_size, stamp.st_mtime_ns, INDEX_VERSION, error))
            old_ids = [r[0] for r in db.execute("SELECT id FROM songs WHERE file=?", (file_id,))]
            for song_id in old_ids:
                db.execute("DELETE FROM song_search WHERE id=?", (song_id,))
            db.execute("DELETE FROM songs WHERE file=?", (file_id,))
            for record in records:
                song_id = identity(file_id + record["selector"])
                db.execute("INSERT INTO songs(id,file,title,artist,album,duration,tuning,format,title_sort,artist_sort,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (song_id, file_id, record["title"], record["artist"], record["album"], record["duration"], json.dumps(record["tuning"]), record["format"], record["title"].casefold(), record["artist"].casefold(), json.dumps(record)))
                words = " ".join([record["title"], record["artist"], record["album"], "".join(record["tuning"])])
                db.execute("INSERT INTO song_search(id,words) VALUES (?,?)", (song_id, words))
            self._revision(db)
        with self.state_lock:
            self.progress["indexed"] += 1

    def page(self, *, query="", sort="title", format="", snapshot="", offset=0, limit=100, anchor="", selected=""):
        offset, limit = max(0, offset), min(100, max(1, limit))
        with self.snapshot_lock:
            ids = self.snapshots.get(snapshot)
            if ids is not None:
                self.snapshots.move_to_end(snapshot)
        if ids is None:
            if snapshot:
                raise ImportFailure("This library view expired. Refresh the list.")
            order = "s.artist_sort,s.title_sort,s.id" if sort == "artist" else "s.title_sort,s.id"
            where, args = ["EXISTS(SELECT 1 FROM root_files WHERE file=s.file)"], []
            terms = re.findall(r"\w+", query[:200], flags=re.UNICODE)
            if terms:
                where.append("s.id IN (SELECT id FROM song_search WHERE song_search MATCH ?)")
                args.append(" AND ".join('"' + term + '"*' for term in terms))
            if format in ("Rocksmith 2014", "ToneLib"):
                where.append("s.format=?")
                args.append(format)
            with self.connect() as db:
                ids = [r[0] for r in db.execute(f"SELECT s.id FROM songs s WHERE {' AND '.join(where)} ORDER BY {order}", args)]
            snapshot = uuid.uuid4().hex
            with self.snapshot_lock:
                self.snapshots[snapshot] = ids
                while len(self.snapshots) > 12:
                    self.snapshots.popitem(last=False)
        wanted = ids[offset:offset + limit]
        requested = wanted + ([selected] if selected in ids and selected not in wanted else [])
        rows = {}
        if requested:
            with self.connect() as db:
                for row in db.execute(f"SELECT s.id,s.title,s.artist,s.album,s.duration,s.tuning,s.format,json_extract(s.metadata,'$.cover') AS cover,f.path,f.size,f.mtime,EXISTS(SELECT 1 FROM root_files WHERE file=s.file AND present=1) AS available FROM songs s JOIN files f ON s.file=f.id WHERE s.id IN ({','.join('?' for _ in requested)})", requested):
                    item = dict(row)
                    has_cover = item.pop("cover")
                    key = identity(item["id"] + str(item["size"]) + str(item["mtime"]) + "media-v1")
                    item.update(tuning=json.loads(item["tuning"]), art_url=f"/library/art/{item['id']}/{key}.jpg" if has_cover else None)
                    for field in ("prepared", "file", "size", "mtime", "title_sort", "artist_sort"):
                        item.pop(field, None)
                    rows[item["id"]] = item
        return dict(snapshot=snapshot, total=len(ids), offset=offset,
                    anchor_index=ids.index(anchor) if anchor in ids else -1,
                    selected_index=ids.index(selected) if selected in ids else -1,
                    selected_item=rows.get(selected),
                    items=[rows.get(i, dict(id=i, title="Unavailable song", artist="", tuning=[], duration=0, available=False)) for i in wanted])

    def source(self, song_id):
        with self.connect() as db:
            row = db.execute("SELECT s.*,f.path,f.size,f.mtime FROM songs s JOIN files f ON s.file=f.id WHERE s.id=? AND EXISTS(SELECT 1 FROM root_files WHERE file=s.file AND present=1)", (song_id,)).fetchone()
        if row is None:
            raise ImportFailure("This song is unavailable. Check its folder and rescan.")
        song = dict(row)
        try:
            stat = Path(song["path"]).stat()
        except OSError:
            raise ImportFailure("This song's folder or file is unavailable.") from None
        if (stat.st_size, stat.st_mtime_ns) != (song["size"], song["mtime"]):
            self.wake.set()
            raise ImportFailure("This file changed. The library is updating; try again in a moment.")
        song["metadata"] = json.loads(song["metadata"])
        song["media_key"] = identity(song["id"] + str(song["size"]) + str(song["mtime"]) + "media-v1")
        return song

    def prepared(self, song, key):
        with self.connect() as db:
            db.execute("UPDATE songs SET prepared=? WHERE id=? AND file IN (SELECT id FROM files WHERE size=? AND mtime=?)", (key, song["id"], song["size"], song["mtime"]))

    def artwork_for(self, song_id, key):
        output = self.media / (key + ".jpg")
        with self.art_lock:
            if output.exists():
                os.utime(output, None)
                return output
            song = self.source(song_id)
            if song["media_key"] != key:
                raise ImportFailure("Artwork changed. Refresh the library.")
            entry = song["metadata"].get("cover")
            if not entry:
                raise ImportFailure("No album artwork")
            data = Psarc(Path(song["path"])).read(entry)
            with Image.open(io.BytesIO(data)) as image:
                image = ImageOps.fit(image.convert("RGB"), (256, 256), method=Image.Resampling.LANCZOS)
                temp = output.with_suffix(".tmp")
                image.save(temp, format="JPEG", quality=85)
                temp.replace(output)
            trim_cache(self.media, "*.jpg", 64 * 1024 * 1024)
        return output


def trim_cache(folder, pattern, budget):
    with CACHE_SWEEP_LOCK:
        sweep_key = (str(folder), pattern)
        if time.monotonic() - CACHE_SWEEPS.get(sweep_key, -1000) < 30:
            return
        CACHE_SWEEPS[sweep_key] = time.monotonic()
        files = []
        for file in folder.glob(pattern):
            try:
                files.append((file, file.stat()))
            except OSError:
                pass
        files.sort(key=lambda item: item[1].st_mtime)
        total = sum(stat.st_size for _, stat in files)
        for file, stat in files:
            if total <= budget or time.time() - stat.st_mtime < 600:
                break  # Keep recently used/playing assets; the budget is soft.
            try:
                file.unlink()
                total -= stat.st_size
            except OSError:
                pass


class ForwardReader:
    """Forward seeks for WAV chunk padding on an unseekable decoder pipe."""
    def __init__(self, source):
        self.source, self.position = source, 0

    def read(self, size=-1):
        data = self.source.read(size)
        self.position += len(data)
        return data

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        target = offset + self.position if whence == 1 else offset
        if whence not in (0, 1) or target < self.position:
            raise OSError("The preview pipe cannot seek backwards")
        while self.position < target:
            if not self.read(min(65536, target - self.position)):
                raise EOFError("The preview audio ended unexpectedly")
        return self.position


def make_preview(song, media: Path, decoder: Path):
    output = media / (song["media_key"] + ".wav")
    if output.exists():
        os.utime(output, None)
        return dict(audio_url=f"/library/media/{output.name}")
    metadata, path = song["metadata"], Path(song["path"])
    with tempfile.TemporaryDirectory(dir=media, prefix="preview-") as temp:
        temp = Path(temp)
        start = min(30, metadata["duration"] * .2)
        if path.suffix.lower() == ".psarc":
            archive = Psarc(path)
            entry = rocksmith_audio(archive, metadata["attrs"], preview=True)
            if entry:
                start = 0
            else:
                entry = rocksmith_audio(archive, metadata["attrs"])
            if not entry:
                raise ImportFailure("No matching preview audio was found.")
            source = temp / "source.wem"
            source.write_bytes(archive.read(entry))
        else:
            with zipfile.ZipFile(path) as archive, archive.open(metadata["audio_entry"]) as backing:
                magic = backing.read(12)
                suffix = ".flac" if magic.startswith(b"fLaC") else ".wav" if magic.startswith(b"RIFF") else ".ogg" if magic.startswith(b"OggS") else None
                if not suffix:
                    raise ImportFailure("The preview audio format is unsupported.")
                source = temp / ("source" + suffix)
                with source.open("wb") as target:
                    target.write(magic)
                    shutil.copyfileobj(backing, target)
        if not decoder.exists():
            raise ImportFailure("Launch with Start Player.cmd to install the preview decoder.")
        # Decode only the excerpt, rather than a full song-sized WAV. The process
        # is killed once enough PCM has been read, even for long ToneLib tracks.
        process = subprocess.Popen([str(decoder), "-i", "-p", str(source)], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        timer = threading.Timer(45, process.kill)
        timer.start()
        try:
            with wave.open(ForwardReader(process.stdout), "rb") as incoming:
                rate, width, channels = incoming.getframerate(), incoming.getsampwidth(), incoming.getnchannels()
                skip = int(start * rate)
                while skip:
                    frames = min(skip, rate)
                    data = incoming.readframes(frames)
                    if not data:
                        break
                    skip -= len(data) // (width * channels)
                with wave.open(str(temp / "clip.wav"), "wb") as clip:
                    clip.setparams((channels, width, rate, 0, "NONE", "not compressed"))
                    for _ in range(30):
                        data = incoming.readframes(rate)
                        if not data:
                            break
                        clip.writeframesraw(data)
            if (temp / "clip.wav").stat().st_size <= 44:
                raise ImportFailure("The preview contains no audio.")
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            process.stdout.close()
        (temp / "clip.wav").replace(output)
    trim_cache(media, "*.wav", 256 * 1024 * 1024)
    return dict(audio_url=f"/library/media/{output.name}")


class MediaJobs:
    """One decoder at a time. Play jumps queued previews; stale previews skip."""
    def __init__(self, library: Library, prepare, chart_cache: Path, decoder: Path):
        self.library, self.prepare, self.chart_cache, self.decoder = library, prepare, chart_cache, decoder
        self.queue, self.lock = queue.PriorityQueue(), threading.Lock()
        self.jobs, self.latest, self.serial = OrderedDict(), OrderedDict(), 0
        threading.Thread(target=self._run, name="library-media", daemon=True).start()

    def submit(self, kind, song_id, client="", selection=0):
        song = self.library.source(song_id)
        with self.lock:
            if kind == "preview":
                previous = self.latest.get(client, -1)
                self.latest[client] = max(previous, selection)
                self.latest.move_to_end(client)
                while len(self.latest) > 64:
                    self.latest.popitem(last=False)
            key = uuid.uuid4().hex
            self.serial += 1
            self.jobs[key] = dict(state="queued", kind=kind)
            self.queue.put((0 if kind == "play" else 1, self.serial, key, song, client, selection))
            for old in list(self.jobs):
                if len(self.jobs) <= 128:
                    break
                if self.jobs[old]["state"] in ("ready", "error", "cancelled") and old != key:
                    del self.jobs[old]
        return dict(job=key)

    def cancel_preview(self, client, selection):
        with self.lock:
            self.latest[client] = max(self.latest.get(client, -1), selection)

    def get(self, key):
        with self.lock:
            return dict(self.jobs.get(key, dict(state="error", error="This request expired. Try again.")))

    def _run(self):
        while True:
            _, _, key, song, client, selection = self.queue.get()
            with self.lock:
                job = self.jobs[key]
                if job["kind"] == "preview" and self.latest.get(client) != selection:
                    job["state"] = "cancelled"
                    continue
                job["state"] = "working"
            self.library.interactive.set()
            try:
                if job["kind"] == "preview":
                    result = make_preview(song, self.library.media, self.decoder)
                else:
                    result = None
                    if song["prepared"]:
                        manifest = self.chart_cache / song["prepared"] / "chart.json"
                        if manifest.is_file():
                            candidate = json.loads(manifest.read_text(encoding="utf-8"))
                            if (manifest.parent / candidate["audio_file"]).is_file():
                                os.utime(manifest.parent / candidate["audio_file"], None)
                                result = candidate
                    if result is None:
                        result = self.prepare(Path(song["path"]), arrangement=song["metadata"]["selector"] or None)
                        self.library.prepared(song, result["id"])
                with self.lock:
                    job.update(state="ready", result=result)
            except Exception as error:
                with self.lock:
                    job.update(state="error", error=str(error) or "This song could not be opened.")
            finally:
                self.library.interactive.clear()
