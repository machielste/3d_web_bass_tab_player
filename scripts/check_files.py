"""Read-only compatibility smoke check for local songs supplied on the CLI."""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from importers import Psarc, parse_sng, read_tonelib

working = Path(__file__).resolve().parents[1] / ".cache/checks"
working.mkdir(parents=True, exist_ok=True)
for argument in sys.argv[1:]:
    path = Path(argument)
    if path.suffix == ".song":
        with tempfile.TemporaryDirectory(dir=working) as destination:
            chart = read_tonelib(path, Path(destination))
            notes, beats = chart["notes"], chart["beats"]
            strings = chart["strings"]
    else:
        archive = Psarc(path)
        attrs = [entry["Attributes"]
                 for name in archive.files if name.startswith("manifests/") and name.endswith(".json")
                 for entry in json.loads(archive.read(name)).get("Entries", {}).values()
                 if entry.get("Attributes", {}).get("ArrangementName", "").lower() == "bass"][0]
        asset = attrs["SongAsset"].rsplit(":", 1)[-1]
        sng = next(name for name in archive.files
                   if name.startswith("songs/bin/generic/") and Path(name).stem == asset)
        notes, beats = parse_sng(archive.read(sng))
        strings = ["bass"]
    assert notes and beats
    assert all(note["end"] >= note["time"] >= 0 for note in notes)
    print(f"{path.name}: {len(notes)} notes, {len(beats)} beats, {strings}")
