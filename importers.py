"""Small, read-only importers for ToneLib and Rocksmith 2014 bass charts.

Rocksmith's binary layouts were cross-checked against RS2IR Converter and
RocksmithToolkit. See THIRD_PARTY.md. Techniques are intentionally not rendered.
The normalized string index is always zero for the lowest sounding string.
"""

from __future__ import annotations

import bisect
import json
import math
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path

from Crypto.Cipher import AES


class ImportFailure(ValueError):
    """A file is unsupported or cannot be read safely."""


def string_names(pitches: list[int]) -> list[str]:
    names = ("C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B")
    return [names[p % 12] for p in pitches]


def read_tonelib(path: Path, destination: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        if archive.getinfo("the_song.dat").file_size > 32 * 1024 * 1024:
            raise ImportFailure("This ToneLib score is too large for the proof of concept.")
        root = ET.fromstring(archive.read("the_song.dat").rstrip(b"\0"))
        tracks = root.findall("Tracks/Track")
        candidates = [t for t in tracks if len(t.findall("Strings/String")) in (4, 5)]
        if not candidates:
            raise ImportFailure("This proof of concept needs a four- or five-string bass track.")
        track = next((t for t in candidates if "bass" in t.get("name", "").lower()), candidates[0])
        strings = sorted(track.findall("Strings/String"), key=lambda s: int(s.attrib["id"]), reverse=True)
        mapping = {int(s.attrib["id"]): i for i, s in enumerate(strings)}
        tuning = [int(s.attrib["tuning"]) for s in strings]
        bars = {bar.attrib["id"]: bar for bar in track.findall("Bars/Bar")}
        headers = root.findall("BarIndex/Bar")
        if not headers:
            raise ImportFailure("The ToneLib file has no bar timing.")
        notes, beats = [], []
        last_by_string = {}
        now, tempo, numerator, denominator = 0.0, 120.0, 4, 4
        for header in headers:
            # Repeat/alternate-ending expansion needs a dedicated timing reader.
            if any("repeat" in key.lower() or "alternate" in key.lower() for key in header.attrib):
                raise ImportFailure("ToneLib repeats are not supported by this first prototype.")
            if any("repeat" in item.tag.lower() or "alternate" in item.tag.lower() for item in header):
                raise ImportFailure("ToneLib repeats are not supported by this first prototype.")
            tempo = float(header.get("tempo", tempo))
            signature = header.find("time_sign")
            if signature is not None:
                numerator = int(signature.get("numerator", numerator))
                denominator = int(signature.get("duration", denominator))
            if not 0 < tempo <= 1000 or numerator <= 0 or denominator <= 0:
                raise ImportFailure("Invalid ToneLib tempo or time signature.")
            bar_duration = numerator * 4 / denominator * 60 / tempo
            for beat in range(numerator):
                beats.append({"time": now + beat * 4 / denominator * 60 / tempo, "bar": beat == 0})
            bar = bars.get(header.attrib["id"])
            elapsed = 0.0
            if bar is not None:
                extra_voice = bar.find("Beats")
                if extra_voice is not None and len(extra_voice):
                    raise ImportFailure("ToneLib scores with a second voice are not supported yet.")
                for beat in bar.findall("Beat"):
                    if any("tuplet" in key.lower() or "dot" in key.lower() for key in beat.attrib):
                        raise ImportFailure("ToneLib dotted notes and tuplets are not supported yet.")
                    if any("tuplet" in el.tag.lower() or "dot" in el.tag.lower() for el in beat):
                        raise ImportFailure("ToneLib dotted notes and tuplets are not supported yet.")
                    value = int(beat.attrib["duration"])
                    if value not in (1, 2, 4, 8, 16, 32, 64, 128):
                        raise ImportFailure(f"Unsupported ToneLib beat duration: {value}.")
                    length = 4 / value * 60 / tempo
                    for element in beat.findall("Note"):
                        string = mapping[int(element.attrib["string"])]
                        fret = int(element.attrib["fret"])
                        if element.get("tied") == "yes":
                            previous = last_by_string.get(string)
                            if previous is None or abs(previous["end"] - (now + elapsed)) > 0.002:
                                raise ImportFailure("A ToneLib tie has no preceding note.")
                            if fret not in (0, previous["fret"]):
                                raise ImportFailure("A ToneLib tie changes the preceding fret.")
                            previous["end"] = now + elapsed + length
                        else:
                            note = {"time": now + elapsed, "end": now + elapsed + length,
                                    "string": string, "fret": fret}
                            notes.append(note)
                            last_by_string[string] = note
                    elapsed += length
                if elapsed > bar_duration + 0.002:
                    raise ImportFailure("A ToneLib bar exceeds its time signature; this rhythm is unsupported.")
            now += bar_duration
        audio_entry = root.findtext("Backing_track1/audio/data_file")
        if not audio_entry:
            raise ImportFailure("The ToneLib song has no embedded backing audio.")
        with archive.open(audio_entry) as source:
            magic = source.read(12)
            suffix = ".flac" if magic.startswith(b"fLaC") else ".wav" if magic.startswith(b"RIFF") else ".ogg" if magic.startswith(b"OggS") else None
            if suffix is None:
                raise ImportFailure("This ToneLib backing audio format is not supported yet.")
            audio_name = "audio" + suffix
            with (destination / audio_name).open("wb") as audio:
                audio.write(magic)
                shutil.copyfileobj(source, audio)
    return finish_chart({"title": root.findtext("info/name") or path.stem,
                         "artist": root.findtext("info/artist") or "", "format": "ToneLib",
                         "arrangement": track.get("name", "Bass"), "strings": string_names(tuning),
                         "tuning": tuning, "notes": notes, "beats": beats,
                         "duration": now, "audio_file": audio_name})


class Psarc:
    """Read just the requested archive entries, without unpacking the whole DLC."""

    KEY = bytes.fromhex("C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C")

    def __init__(self, path: Path):
        self.path = path
        self.size = path.stat().st_size
        with path.open("rb") as file:
            header = file.read(32)
            if len(header) != 32 or header[:4] != b"PSAR":
                raise ImportFailure("This is not a Rocksmith PSARC archive.")
            _, _, codec, toc_size, entry_size, count, self.block_size, flags = struct.unpack(">4sI4sIIIII", header)
            if codec != b"zlib" or entry_size != 30 or not 0 < count < 100000 or not 0 < self.block_size <= 65536:
                raise ImportFailure("Unsupported PSARC archive layout.")
            if not 32 + count * 30 <= toc_size <= min(self.size, 32 * 1024 * 1024):
                raise ImportFailure("Invalid PSARC table of contents.")
            toc = file.read(toc_size - 32)
        if flags & 4:
            toc = AES.new(self.KEY, AES.MODE_CFB, iv=bytes(16), segment_size=128).decrypt(toc)
        self.entries = []
        for i in range(count):
            entry = toc[i * 30:(i + 1) * 30]
            self.entries.append((int.from_bytes(entry[16:20], "big"),
                                 int.from_bytes(entry[20:25], "big"),
                                 int.from_bytes(entry[25:30], "big")))
        table = toc[count * 30:]
        self.blocks = [int.from_bytes(table[i:i + 2], "big") for i in range(0, len(table) - 1, 2)]
        names = self.read_index(0).decode("utf-8").splitlines()
        if len(names) != count - 1:
            raise ImportFailure("Invalid PSARC filename table.")
        self.files = {name: index + 1 for index, name in enumerate(names)}

    def read_index(self, index: int) -> bytes:
        first, size, offset = self.entries[index]
        if size > 512 * 1024 * 1024 or offset > self.size:
            raise ImportFailure("The PSARC entry is invalid or too large.")
        result = bytearray()
        with self.path.open("rb") as file:
            file.seek(offset)
            for block in range(math.ceil(size / self.block_size)):
                if first + block >= len(self.blocks):
                    raise ImportFailure("The PSARC block table is truncated.")
                packed = self.blocks[first + block]
                expected = min(self.block_size, size - len(result))
                data = file.read(packed or expected)
                if packed:
                    try:
                        data = zlib.decompress(data)
                    except zlib.error:
                        if len(data) != expected:
                            raise ImportFailure("A PSARC data block could not be decoded.") from None
                result.extend(data)
        if len(result) != size:
            raise ImportFailure("The PSARC entry is truncated.")
        return bytes(result)

    def read(self, name: str) -> bytes:
        return self.read_index(self.files[name])


class Binary:
    def __init__(self, data: bytes):
        self.data, self.pos = data, 0

    def skip(self, size: int):
        if size < 0 or self.pos + size > len(self.data):
            raise ImportFailure("The Rocksmith chart is truncated or unsupported.")
        self.pos += size

    def take(self, fmt: str):
        length = struct.calcsize("<" + fmt)
        start = self.pos
        self.skip(length)
        values = struct.unpack_from("<" + fmt, self.data, start)
        return values[0] if len(values) == 1 else values

    def count(self):
        value = self.take("I")
        if value > 1000000:
            raise ImportFailure("Invalid Rocksmith chart section size.")
        return value

    def section(self, stride: int):
        self.skip(self.count() * stride)


def decrypt_sng(data: bytes) -> bytes:
    if len(data) < 28 or struct.unpack_from("<I", data)[0] != 0x4A:
        raise ImportFailure("Unsupported Rocksmith arrangement file.")
    if struct.unpack_from("<I", data, 4)[0] != 3:
        raise ImportFailure("This prototype supports Windows Rocksmith 2014 files (_p.psarc).")
    key = bytes.fromhex("CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30")
    plain = AES.new(key, AES.MODE_CTR, nonce=b"", initial_value=int.from_bytes(data[8:24], "big")).decrypt(data[24:])
    return zlib.decompress(plain[4:])


def parse_sng(data: bytes, string_count: int = 4) -> tuple[list, list]:
    reader = Binary(decrypt_sng(data))
    beats = []
    for _ in range(reader.count()):
        time, measure, beat = reader.take("fhh")
        reader.skip(8)
        beats.append({"time": time, "bar": beat == 0})
    difficulties = []
    for _ in range(reader.count()):
        reader.skip(4)
        difficulties.append(reader.take("I"))
        reader.skip(36)
    chords = []
    for _ in range(reader.count()):
        reader.skip(4)
        chords.append(reader.take("6B"))
        reader.skip(62)
    reader.section(2376)  # per-string chord techniques
    vocals = reader.count()
    reader.skip(vocals * 60)
    if vocals:
        for stride in (32, 144, 44):
            reader.section(stride)
    iterations = []
    for _ in range(reader.count()):
        phrase, start, end = reader.take("Iff")
        reader.skip(12)
        if phrase >= len(difficulties):
            raise ImportFailure("Invalid Rocksmith phrase reference.")
        iterations.append((start, end, difficulties[phrase]))
    reader.section(16)
    for _ in range(reader.count()):
        reader.skip(4)
        reader.section(4)
    for stride in (260, 260, 8, 8, 88):
        reader.section(stride)
    levels = {}
    for _ in range(reader.count()):
        difficulty = reader.take("I")
        for stride in (28, 12, 20, 20):
            reader.section(stride)
        notes = []
        for _ in range(reader.count()):
            mask = reader.take("I")
            reader.skip(8)
            time = reader.take("f")
            string, fret = reader.take("BB")
            reader.skip(2)
            chord = reader.take("I")
            reader.skip(22 + 9)
            sustain = reader.take("f")
            reader.skip(4)
            reader.section(12)  # bend points; displayed as an ordinary sustain
            positions = enumerate(chords[chord]) if mask & 2 and chord < len(chords) else [(string, fret)]
            for string, fret in positions:
                if string < string_count and fret != 255:
                    notes.append({"time": time, "end": time + max(0, sustain), "string": string, "fret": fret})
        for _ in range(3):
            reader.section(4)
        levels[difficulty] = notes
    if not levels:
        raise ImportFailure("The Rocksmith bass arrangement has no chart levels.")
    return full_difficulty_notes(levels, iterations), beats


def full_difficulty_notes(levels: dict[int, list], iterations: list[tuple]) -> list:
    # Select the maximum authored difficulty separately for each phrase. Lower
    # levels can contain different notes and must never be unioned into it.
    iterations.sort()
    starts = [i[0] for i in iterations]
    notes = []
    available = sorted(levels)
    for difficulty, candidates in levels.items():
        for note in candidates:
            index = bisect.bisect_right(starts, note["time"]) - 1
            desired = iterations[index][2] if index >= 0 else available[-1]
            selected = max((level for level in available if level <= desired), default=available[0])
            if difficulty == selected:
                notes.append(note)
    return notes


def rocksmith_bass(archive: Psarc) -> list[dict]:
    """Manifest-only discovery; never reads SNGs, artwork or audio."""
    candidates = []
    for name in archive.files:
        if name.startswith("manifests/") and name.endswith(".json"):
            document = json.loads(archive.read(name))
            for entry in document.get("Entries", {}).values():
                attrs = entry.get("Attributes", {})
                if attrs.get("ArrangementName", "").lower() == "bass":
                    candidates.append(attrs)
    return sorted(candidates, key=lambda a: (not a.get("ArrangementProperties", {}).get("represent", 0), a.get("FullName", "")))


def rocksmith_audio(archive: Psarc, attrs: dict, *, preview=False) -> str | None:
    field = "PreviewBankPath" if preview else "SongBank"
    bank_name = Path(attrs.get(field, "")).name
    banks = [n for n in archive.files if n.endswith(".bnk") and Path(n).name == bank_name] if bank_name else []
    for bank in banks:
        data = archive.read(bank)
        pos = 0
        while pos + 8 <= len(data):
            tag, length = struct.unpack_from("<4sI", data, pos)
            if tag == b"DIDX":
                for offset in range(pos + 8, min(pos + 8 + length, len(data)) - 11, 12):
                    audio_id = struct.unpack_from("<I", data, offset)[0]
                    wem = next((n for n in archive.files if Path(n).name == f"{audio_id}.wem"), None)
                    if wem:
                        return wem
            pos += 8 + length
    # An ambiguous pack must not silently play another song's audio.
    if preview or len({a.get("SongKey", a.get("SongName")) for a in rocksmith_bass(archive)}) > 1:
        return None
    wems = [n for n in archive.files if n.endswith(".wem")]
    return max(wems, key=lambda n: archive.entries[archive.files[n]][1]) if wems else None


def read_rocksmith(path: Path, destination: Path, arrangement: str | None = None) -> dict:
    archive = Psarc(path)
    candidates = rocksmith_bass(archive)
    attrs = next((a for a in candidates if a.get("SongAsset") == arrangement), None) if arrangement else next(iter(candidates), None)
    if attrs is None:
        raise ImportFailure("This Rocksmith file has no matching bass arrangement.")
    urn = attrs.get("SongAsset", "")
    asset = urn.rsplit(":", 1)[-1]
    sng_name = next((name for name in archive.files if name.startswith("songs/bin/generic/") and Path(name).stem == asset), None)
    if sng_name is None:
        raise ImportFailure("The Windows bass chart is missing. Please use a _p.psarc file.")
    notes, beats = parse_sng(archive.read(sng_name))
    offsets = attrs.get("Tuning", {})
    tuning = [pitch + int(offsets.get(f"string{i}", 0)) for i, pitch in enumerate((28, 33, 38, 43))]
    wem = rocksmith_audio(archive, attrs)
    if wem is None:
        raise ImportFailure("No matching backing audio was found in this Rocksmith file.")
    decoder = Path(__file__).parent / ".tools/vgmstream/vgmstream-cli.exe"
    if not decoder.exists():
        raise ImportFailure("The Rocksmith audio decoder is missing. Launch with Start Player.cmd to set it up.")
    source = destination / "source.wem"
    source.write_bytes(archive.read(wem))
    try:
        completed = subprocess.run([str(decoder), "-o", str(destination / "audio.wav"), str(source)],
                                   capture_output=True, timeout=180,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if completed.returncode or not (destination / "audio.wav").exists():
            raise ImportFailure("The Rocksmith backing audio could not be decoded.")
    finally:
        source.unlink(missing_ok=True)
    return finish_chart({"title": attrs.get("SongName") or path.stem,
                         "artist": attrs.get("ArtistName", ""), "format": "Rocksmith 2014",
                         "arrangement": "Bass", "strings": string_names(tuning), "tuning": tuning,
                         "notes": notes, "beats": beats, "duration": float(attrs.get("SongLength", 0)),
                         "audio_file": "audio.wav"})


def finish_chart(chart: dict) -> dict:
    notes = chart["notes"]
    if not notes:
        raise ImportFailure("The selected bass track contains no notes.")
    for note in notes:
        if not all(math.isfinite(note[key]) for key in ("time", "end")) or note["time"] < 0 or note["end"] < note["time"] or not 0 <= note["fret"] <= 36:
            raise ImportFailure("The file contains invalid or unsupported note positions.")
    notes.sort(key=lambda n: (n["time"], n["string"], n["fret"]))
    chart["duration"] = max(chart["duration"], max(n["end"] for n in notes))
    for note in notes:
        note["time"] = round(note["time"], 6)
        note["end"] = round(note["end"], 6)
    return chart
