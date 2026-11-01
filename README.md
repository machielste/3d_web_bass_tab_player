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

The app opens to the song library. Choose **Song folders → Browse…**, select a
folder and click **Add folder**. You can also paste a folder path. Add as many
folders as you need; subfolders are included and overlapping paths are deduplicated.
Songs appear during the first background scan. Later launches open the saved
catalog immediately and check for new or changed files in the background.

Search by song, artist, album or tuning (for example `EADG`). Search matches word
prefixes. Sort by title or artist, or filter by source format. Click a row or
use ↑/↓ to select it. The selected song previews after a short delay; the
checkbox turns automatic previews off. Press Enter, double-click a row, or use
**Play song** to open its chart. **Library** returns to browsing and pauses the
song. **Open song** still opens a single file using the Windows file picker.

The play screen gives the highway the full window height, with song information,
tuning and controls in a narrow left sidebar. In narrow portrait windows the
controls move below the highway. **More → Open song…** opens another file.
Play/pause: the circular button or Space. Drag the timeline to seek; the curved
arrow restarts the song. **Fullscreen** or F toggles fullscreen, and Escape exits.
All playback is at the original speed. If a browser blocks automatic audio,
press Play once. Use a recent Chromium browser with WebGL 2 support.

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
- A persistent, local SQLite song library. The index reads metadata without
  decoding backing audio or loading note charts. One preferred bass arrangement
  per song is listed, including multiple songs inside a Rocksmith pack. Alternate
  arrangements and duplicate song versions in different files are not merged.
  ToneLib library durations currently come from the score timing.
- A virtual list with 100-row API pages, at most eight cached pages in the
  browser, and album art loaded on demand. Stable result snapshots keep the list
  from shuffling as a scan adds songs. Background refresh preserves the top
  visible song and selection. Search uses SQLite FTS; scans use one worker and
  unchanged files are identified by path, size, modification time and index version.
- Rocksmith previews use the embedded preview bank when present; otherwise a
  short excerpt of the backing track is decoded. ToneLib previews extract the
  embedded compressed backing audio and decode only the excerpt. A separate
  preview player never advances the highway. Full-song preparation takes priority
  over queued previews; obsolete preview selections are skipped.
- No accounts or cloud service. Indexed songs open directly from their saved
  local paths. Manually selected files are sent only to the loopback server on
  this computer. Original song files are never modified.

Folder choices and the catalog live in `.data/library.sqlite3`. **Rescan now**
checks for changes; automatic checks also run at startup and every five minutes.
Unavailable folders retain their songs with playback disabled. Removing a folder
only removes it from the library. Unsupported files are isolated and listed in
the folder dialog. General ToneLib parsing limits above still apply at playback.

Prepared charts and extracted/decoded audio are cached under `.cache/songs/`.
Rocksmith audio is cached as WAV. Warm indexed playback uses the saved chart key
without re-uploading or hashing the archive. The first play of an uncached song
still needs preparation. Artwork and up-to-30-second WAV previews are cached
under `.cache/library/`. Soft budgets are 64 MiB for art, 256 MiB for previews,
and 4 GiB for full-song audio; assets used in the last ten minutes are protected.
Cleanup runs when new assets are created, at most once per 30 seconds. All local
state, generated files, `.tools/`, `.venv/` and `node_modules/` are ignored by Git.

## Verify

```powershell
uv run python -m unittest discover -s tests -v
npm.cmd test
uv run python scripts/benchmark_library.py
```

The automated checks cover timing, ties, string order, authored difficulty
selection, byte-range seeking, hand-shift continuity, catalog persistence,
incremental scans, overlapping/unavailable folders, stable paging, cache reuse,
preview priority/cancellation and virtual-list bounds. The benchmark measures
local catalog API latency with the server running. Real-file
and browser checks are documented in `VALIDATION.md`.

The performance overlay is enabled by default while the intermittent stutter is
being investigated, so **Save timing report** is always ready during playback.
Use `?perf=0` (or `&perf=0` on a song URL) to disable it for a session; this choice
is preserved while switching between songs and the library.
The overlay counts animation callbacks, not frames
actually presented by the display. It shows p95/p99/maximum frame intervals,
late frames relative to the observed refresh cadence, repeated media times,
clock-step jitter, CPU submission, and drawing-buffer size. A high callback
rate can coexist with long gaps or repeated note positions. Diagnostics stay
local. Open `/benchmark.html` for a repeatable dense
five-string workload. Run it with the tab visible, then repeat while resizing
or using another browser window. Compare frame intervals and CPU time as well
as FPS; CPU submission does not measure GPU execution.

The renderer batches labels into an atlas, allocates visible-note capacity at
song load, and redraws paused scenes only when needed. Resize requests share the
playback animation callback. The canvas is limited to two million pixels and
1.75 device pixels per CSS pixel. Sustained missed frames reduce its resolution;
stable playback restores it gradually. This trades some sharpness for GPU
headroom without changing camera geometry or audio timing. Browser scheduling,
GPU contention and power-saving policies can still interrupt frame delivery.

Highway motion interpolates the media clock along the animation-frame timeline
and gently reconciles small timing errors. It resets on seeks, pause, buffering,
song changes and visibility changes, and bounds the visual estimate to within
40 ms of the observed media time at normal speed. Audio playback is unchanged.
This removes clock-step jitter; it cannot replace frames the browser does not
deliver or present.

While diagnosing a stuttering song, toggle **Raw audio clock** in the overlay
to compare the old timing with smoothed timing during the same playback. The
moving dot is an independent CSS timing reference. **Save timing report** saves
the most recent 4,096 frame samples, transport/focus events, and available
long-task/long-animation-frame script attribution as local JSON. Nothing is
uploaded. Save the report while the problem is occurring. Browser performance
entries and callback counts do not directly measure physical presentation.

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
