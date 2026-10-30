# Tab Player — proof of concept

A local bass tab player with a real Three.js perspective highway. Open a song
with the standard Windows file picker; its backing audio starts automatically.

## Run

Double-click **Start Player.cmd**. It opens the player in your default browser.
Choose **Open song**, then select a ToneLib `.song` or Windows Rocksmith 2014
`_p.psarc` file. The bass arrangement is selected automatically.

The launcher requires [uv](https://docs.astral.sh/uv/) and Node.js/npm, already
available on the development machine. The first launch downloads dependencies
and the vgmstream audio decoder. Subsequent launches use the local copies.
Leave the launcher window open while playing; Ctrl+C stops the server.

Play/pause: the circular button or Space. Drag the timeline to seek. All playback
is at the original speed. If a browser blocks automatic audio, press Play once.
Use a recent Chromium browser with WebGL 2 support.

For development:

```powershell
uv sync
npm.cmd install --ignore-scripts
uv run python server.py --no-browser
```

Open the printed loopback URL. `--port 8766` selects a different port. For test
sessions, `--file "C:\path\to\song.song"` preloads a file without a picker.

## Scope

- Four- and five-string generated ToneLib bass projects with embedded FLAC, WAV,
  or Ogg backing audio. Bar-level tempos, time signatures and tied durations are
  retained. General ToneLib compatibility is not yet claimed: second voices,
  repeats, dotted notes, tuplets and audio alignment edits are outside this POC.
- Windows Rocksmith 2014 archives with a bass arrangement. The full authored
  difficulty is chosen per phrase. Notes and chords become ordinary note blocks;
  technique-specific visuals and per-string chord sustain detail are omitted.
- A perspective fitted to a user-traced Rocksmith reference, with a finite,
  four-fret blue corridor. Notes and their labels fade in beyond its end. The
  lowest string is at the top (EADG or BEADG). A typical six-beat road preview is
  bounded to 2.6–3.8 seconds, plus a short transparent emergence region. The
  orientation and field of view stay fixed. Faint absolute fret lanes continue
  on both sides, while the blue guide shows upcoming hand changes arriving with
  the music. The camera follows independently with a small dead zone. Notes,
  including open-string bars, keep their own positions through a shift. There
  is no dynamic zoom, and seeking restores the local hand position immediately.
  The current hand-position timeline is inferred from note groups.
  Travel speed is chosen once from the song's beat map. The audio stays at its
  original speed and notes reach the strike plane at their authored timestamps.
- No song library, accounts, or cloud service. Selected files are sent only to the
  loopback server on this computer. The app never modifies original song files.

Prepared charts and extracted/decoded audio are cached under `.cache/songs/`.
Rocksmith audio is cached as WAV, which can occupy substantial disk space. These
generated files, `.tools/`, `.venv/` and `node_modules/` are ignored by Git.

## Verify

```powershell
uv run python -m unittest discover -s tests -v
npm.cmd test
```

The automated checks cover timing, ties, string order, authored difficulty
selection, byte-range seeking, visible-note lookup after seeks, and hand-shift
continuity with independent camera following. Real-file
and browser checks are documented in `VALIDATION.md`.

## Offline perspective calibration

The image-analysis packages are optional and never imported during playback:

```powershell
uv run --group calibration python scripts/calibrate_highway.py original.png lines.png --color EA3FF7 --output docs/highway-reference.json
```

The script isolates new magenta strokes by comparing the marked and original
images, fits both rails and the end cap, and reconstructs a rectangular plane
with a perspective camera. The inferred four-fret width, square pixels and
centered principal point are assumptions; a single annotated frame does not
identify Rocksmith's exact internal camera. The runtime constants live in
`static/timeline.js`; a regression check projects their four road corners back
onto the measured reference coordinates. No reference screenshots are bundled.
