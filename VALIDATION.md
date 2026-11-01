# Validation — 2026-10-30

Passed six Python unit tests and two JavaScript tests, plus JavaScript syntax
checks. Temporary test files were placed under `.cache/test-temp` because the
automation sandbox's default Windows temporary directory rejected writes.

Read-only checks against local files (the recordings are not included):

| File | Notes | Result |
| --- | ---: | --- |
| Yuji Toriyama - Potted Parrot.bass.song | 1,078 | Imported backing audio, ties, and EADG strings; automatic browser playback |
| Wonderland in the Sky.bass.song | 3,478 | Imported backing audio and BEADG strings; automatic browser playback and seek |
| _Temptations_Aint-Too-Proud-To-Beg_v1_p.psarc | 282 | Imported bass chart, decoded WEM, automatic browser playback and seek |
| 1979_p.psarc | 637 | Parsed bass chart and beat timestamps |
| 1986-Omega-Tribe_Kimi-wa-1000-percent_v1_p.psarc | 689 | Parsed bass chart and beat timestamps |
| 25or6to4_p.psarc | 1,064 | Parsed bass chart and beat timestamps |
| 2minutes_p.psarc | 1,861 | Parsed bass chart and beat timestamps |

Browser verification used the Windows in-app Chromium browser. Confirmed Playing
state and advancing media time after choosing both formats, successful seeking,
pause, loaded media without audio errors, and no browser console warnings/errors.
The fixed-camera 3D view was inspected visually. At 1280 × 720, the page height
is 720 pixels and playback controls fit on screen. Five-string playback was also
checked using a 14-minute ToneLib recording.

The Windows launcher was run and served the app successfully. The development
server needed to run outside the execution sandbox for the user's browser to
reach loopback. This is an automation-environment restriction, not an app setup
step for ordinary Windows use.

These are compatibility and functional checks, not a full visual/audio timing
accuracy assessment or a performance benchmark. Other ToneLib encodings,
advanced rhythmic structures, and non-Windows Rocksmith archives remain outside
the tested subset.

## Highway geometry refinement

The camera now views the highway from the right, with an offset vanishing point
and a slanted strike plane. Fret and string labels are included in camera fitting.
String zero (lowest pitch) is mapped to the top lane, without changing imported
string indices or note timestamps. A six-beat typical preview is clamped to
2.6–3.8 seconds; 111 BPM gives approximately 3.24 seconds. Scene fog hides the far
end, including the note labels. Geometry remains driven by the audio clock.

Five JavaScript tests pass after this change. New checks cover the 111 BPM
preview, bounded slow/fast/default timings, exact strike-plane alignment with
the new travel speed, and low-string-first ordering for four and five strings.
Browser checks covered four-string Rocksmith playback at normal audio speed,
pause and seek, and a five-string ToneLib song at 1280 × 720. No browser console
warnings/errors were observed. Perceptual synchronization was previously
confirmed by the user; the renderer's time-to-strike invariant remains tested.

## Measured reference calibration

The supplied original and #EA3FF7-marked images are 2021 × 1135 pixels. Comparing
them isolated 7,889 annotation pixels. A robust line fit measured the near road
corners at approximately (767, 1034) and (1462, 1074), and its far cap at
(1180, 380) and (1259, 380). The cap is approximately 33.4% down the reference.

Assuming a four-fret rectangular corridor, square pixels and centered optics
gives a vertical field of view of approximately 39.0 degrees. The fitted pose
and full measurements are in `docs/highway-reference.json`. The eight
JavaScript checks pass, including projection of runtime road corners onto those
measurements within 0.05 pixel. This validates the math and stored constants;
four-corner interpolation by itself does not validate the assumptions or prove
that Rocksmith uses this exact camera. Its motion behavior needs multiple frames.

The player now uses a fixed-width active corridor instead of fitting all song
frets into the camera. It pans without changing zoom, retains original string
indices, and displays open notes across the current corridor. The note birth
region extends 28% past the finite road. The GPU fades each fragment by depth,
including long sustain tails; labels use the matching opacity curve.

The locally installed `Chaka-Khan_Sleep-On-It_v1_p.psarc` was prepared and played
in the browser. Its bass chart contains 640 notes. Playback, seeking, road
shape, low-string-first order and the new fade shader were inspected without
browser console warnings or errors. Audio timing and recognition behavior were
not changed.

The five-string ToneLib example was also checked at 1280 × 720, including a seek
to one minute. B–E–A–D–G ordering, local fret framing and the fade shader rendered
without console warnings/errors. Fret labels outside the visible foreground are
hidden instead of being partially clipped.

## Hand-shift continuity

The guide previously translated sideways in lockstep with the camera, so it
remained pinned to the screen while the neck and notes moved beneath it. The
renderer now builds a hand-position timeline once per song and samples it along
the road's time axis. A shift reaches the strike plane with its note onset;
future sections can show the destination before the foreground changes.

Absolute fret lines continue faintly across the surrounding neck and stay
straight inside the blue highlight. Only the highlight's outer edges connect
between hand positions. The camera has a separate dead zone and smooth follow.
Beat markers and open-note bars use their own timestamps, rather than copying
the current camera position. Note sizes and the calibrated projection constants
are unchanged. Nearby fret labels were raised slightly to keep them readable
as they scroll across the foreground.

All eleven JavaScript checks pass. New checks cover a shift arriving at the
correct musical timestamp, fixed fret coordinates through camera movement,
open-bar anchoring, seek restoration and frame-rate-independent camera follow.
Browser playback was inspected across the quick shift and return near 2:37 in
Sleep On It, without console warnings/errors. This is a functional and visual
check; whether the motion feels comfortable still benefits from user feedback.

The five-string ToneLib chart was also played through a high-register passage
near 9:25, with fret 20–21 notes visible against the surrounding fret grid. Seeking
into that passage and back to Sleep On It worked without browser console errors.
The new geometry uses reusable position buffers; the guide is not rebuilt as
new meshes on each frame.

## Local song library

Seventeen Python checks and thirteen JavaScript checks pass. Library coverage
includes persistence across restarts, unchanged-file scan avoidance, overlapping
roots, unavailable drives, deleted files, invalidation after a file changes,
stable result snapshots, multi-song manifest discovery, song-specific soundbank
selection, cached playback without reimporting, cache eviction, preview queue
priority/cancellation, decoder pipe handling and virtual-list bounds.

The installed Rocksmith DLC folder produced 5,116 bass song entries; 258 files
had no supported bass arrangement. Adding the five-string Wonderland ToneLib
folder brought the catalog to 5,117 songs. The last reconciliation checked 5,186
files in 2.313 seconds and reparsed zero unchanged files. That work runs in the
background; the saved catalog can be queried before it completes. First-time
indexing takes longer and was observed while browsing and searching.

On this computer, twenty local HTTP samples per operation measured:

| Operation | Median | 95th percentile |
| --- | ---: | ---: |
| First catalog page and result snapshot | 28.20 ms | 32.07 ms |
| Search for `love` | 19.47 ms | 28.73 ms |
| Last page of an existing result snapshot | 16.46 ms | 23.42 ms |

Five cached Sleep On It preparation requests, including HTTP and job polling,
took 16–41 ms, with a 25.53 ms median. This measures preparation, not browser
audio startup or total application launch time. `scripts/benchmark_library.py`
can repeat the catalog measurements with the player running.

The browser was used to add folders, search/filter, navigate to the end of the
full collection, refresh without losing the current position, play previews,
open songs and return to the library. At the end of the 5,116-song list only
15 rows were mounted. Rocksmith's 28-second embedded Sleep On It preview and a
30-second ToneLib excerpt played on a separate transport while the highway's
audio remained paused. Full playback of both charts was verified, including
five-string B–E–A–D–G ordering. The user confirmed that the native Windows folder
picker appeared on their desktop; it was not exposed in the automation inventory.

Desktop layout was checked at 1280 × 800, and the narrow layout at 430 × 900.
The narrow layout had no horizontal overflow and retained accessible playback
and tuning controls. Temporary viewport overrides were reset. The final browser
check reported no console errors or warnings. No quantitative frame-rate or
end-to-end cold-start claim is made.

Current limits: folder changes are reconciled every five minutes or manually,
rather than through an OS watcher. The first playback of an uncached song still
requires full chart/audio preparation. General ToneLib compatibility retains
the earlier importer limits; its catalog duration comes from score timing.
Album art is read from Rocksmith archives when available. Generated previews,
art and full-song audio have soft cache budgets, protecting recently used assets.

## Full-height play screen

The play screen now uses a 208-pixel sidebar for navigation, song title, tuning,
transport and volume. The library retains its existing layout. The player header,
footer and decorative copy no longer take height from the highway. Source details
and the single-file picker are under More. Restart preserves the playing/paused
state; fullscreen is available through its button or F. The renderer, camera,
note geometry and audio-driven timing are unchanged.

The integrated screen was checked at 1280 × 720 (1072 × 720 highway) and
1920 × 1080 (1712 × 1080 highway). In a 430 × 900 portrait window the controls
move below the highway, with no horizontal overflow and accessible playback,
volume and fullscreen controls. Temporary viewport overrides were reset.

Browser checks covered Rocksmith and five-string ToneLib playback, seeking,
restart, volume, Space playback, fullscreen entry/exit by button and F, opening
Sleep On It through More → Open song, and returning to the library and player.
The sidebar correctly displayed EADG and BEADG. No browser console errors or
warnings were observed. Seventeen Python checks and thirteen JavaScript checks
pass; JavaScript syntax and Git whitespace checks also pass.

## Browser rendering performance — 2026-10-31

Seventeen Python checks and twenty-three JavaScript checks pass. Added coverage
for coalescing resize/seek/playback requests, idle and hidden-view scheduling,
resume timestamps, a bounded drawing buffer, adaptive-resolution hysteresis,
reusable label buffers and fades, peak visible-note capacity including sustains,
and logarithmic beat lookup after long seeks. Camera calibration and audio-time
alignment checks still pass.

The Windows in-app Chromium browser ran a synthetic five-string chart with
12,000 notes, twenty onsets per second, and overlapping sustains. Each run warms
for one second and samples for ten seconds at a 1225 × 720 CSS/pixel viewport.
The baseline and first optimized run used the same workload and dimensions:

| Measurement | Baseline | Batched renderer |
| --- | ---: | ---: |
| Median draw calls per frame | 97 | 9 |
| Maximum draw calls per frame | 99 | 9 |
| Textures resident | 19 | 1 |
| Median CPU submission | 0.30 ms | 0.20 ms |
| 95th-percentile CPU submission | 0.80 ms | 0.50 ms |
| 95th-percentile frame interval | 2.90 ms | 2.90 ms |
| Frames longer than 25 ms | 8 | 12 |

This browser delivered callbacks above normal display refresh rates. These are
local workload measurements, not a display-FPS guarantee or proof that the
user's intermittent stutter is eliminated. GPU execution time was not measured;
the long-frame counts did not improve in this pair of short runs. The measured
gain is fewer draw calls and less CPU submission work. Browser/OS scheduling,
GPU contention, and power policies remain possible causes of interruptions.
One final optimized repeat recorded 0.10 ms median / 0.20 ms p95 CPU submission,
nine draw calls, and no frames over 25 ms. This variability is another reason
not to treat a single short run as an intermittent-stutter diagnosis.

Browser checks covered four-string Sleep On It playback and its shift near
2:37; five-string Wonderland playback and seeking near 9:25; pause, fullscreen
entry/exit, library/player switching, and portrait resizing at 430 × 900. A
3840 × 2160 viewport gave a 3632 × 2160 stage with an 1833 × 1090 drawing buffer
(1,997,970 pixels), keeping the projection and CSS size while limiting GPU work.
The default viewport was restored. A fresh tab reported no console warnings or
errors after playback, seeking, fullscreen and view switching.

`/benchmark.html` repeats the dense workload and reports frame intervals, CPU
submission time, draw calls, resolution and resource counts. Add `&perf=1` to
a song URL, or start at `/?perf=1`, for a local live diagnostic overlay during
ordinary playback. Diagnostics are disabled by default. Resolution drops only
after sustained missed frames, recovers gradually after stable playback, and
does not infer sustained load from an isolated long suspension. No browser or
OS settings were changed.

## Frame pacing investigation — 2026-10-31

The follow-up report describes occasional visually poor song starts while audio
remains smooth and the counter still reads roughly 280 FPS. The old counter
measured animation callbacks, not display presentation, and its fixed 25 ms
threshold missed smaller gaps on a high-refresh display.

Replaced that overlay with two-second frame-interval distributions (p95, p99,
maximum), a cadence-relative late-frame threshold, callback versus media-update
rates, repeated media times, media/display clock-step errors, callback dispatch
lag, CPU submission, and optional browser long-task/long-animation-frame
attribution. Focus and transport events are retained. The local export holds
at most 4,096 samples and 64 entries per event/attribution history. The CSS
reference dot and live Raw audio clock toggle allow comparisons during a bad
playback state without reopening the song.

One saved test-browser trace measured 275.99 callbacks/s while recording
22.1 ms p99 and 103.4 ms maximum frame gaps. CPU submission was 0.50 ms p95,
and the media time advanced on every sampled callback. Four browser long tasks
and four long animation frames overlapped the summary window; the recorded
long-frame entries had no attributed page scripts. This supports investigating
frame delivery separately from renderer CPU work. It does not establish a
browser priority bug: automation/isolated-world work can affect these tests and
is not necessarily attributed, and physical display presentation is not exposed
by these measurements.

The highway now uses an audio-anchored display-time clock instead of directly
using each media-time sample as its position. Normal drift corrections are
limited to 2% of visual speed; a 40 ms bound at normal playback speed and resets
on seeks, transport changes and suspension prevent runaway extrapolation.
The backing audio and authored timestamps are unchanged. In that saved trace,
media-step error was 0.147 ms p95 and visual-step error was 0.003 ms p95; this
reduces timing wobble but cannot restore undelivered frames. The original
one-in-five startup failure is not conclusively reproduced or resolved.

Thirty-four JavaScript and seventeen Python checks pass. Added tests cover a
250 Hz callback stream with only 25 Hz media updates, gaps below 25 ms at 360 Hz,
20 ms quantization, uneven callback dispatch, bounded clock drift and history,
pause/seek/source/rate changes, long suspensions and browser attribution. These
synthetic timing cases validate the new behavior, not the cause of the reported
intermittent browser issue. Real-song browser checks cover live raw/smooth
switching, backward seeking, pause/resume, selecting a new song through the
library, and local report export.

The library switch from Sleep On It to five-string Wonderland also exposed
media-clock repetition independent of frame gaps. The latter showed 360
callbacks/s but approximately 320 distinct media-time updates/s, with 80
repeated media samples over two seconds, no late frames, and 0.20 ms p95 CPU
submission. Media-step error was 3.16 ms p95 while the smoothed visual-step
error was 0.06 ms p95. A later window still showed approximately 323 updates/s
and 73 repeats. This is a concrete clock-stepping case that interpolation
addresses; it does not prove that it causes all of the reported random starts.

## Default timing capture — 2026-11-01

The performance overlay and bounded timing trace are now enabled by default,
including song URLs without a `perf` parameter. Save timing report remains
available throughout playback. Explicit `perf=0` disables the overlay and trace;
that override is preserved across song and library navigation. This supersedes
the earlier opt-in behavior documented above.

## Display clarity and supersampling — 2026-11-01

The earlier two-million-pixel cap meant a 4K stage was deliberately rendered
below native resolution and stretched to fill the window. It could also lose
more resolution after sustained late callbacks, even when those callbacks did
not demonstrate GPU saturation. Native resolution is now the default. The
previous cap and adaptive behavior apply only to Performance mode, selected
explicitly from the playback sidebar. Fixed 100%, 150% and 200% modes follow
the display's current device-pixel ratio and never react to frame timing.

A resolution media query is re-armed after each density change. Together with
container/window resizing, focus and visibility listeners, it invalidates a
paused canvas when the display changes. The existing single animation callback
coalesces redraw requests. No monitor-enumeration permission or idle polling is
required. Supersampling is bounded by the GPU's reported buffer/texture/viewport
dimensions; a constrained request is identified in the UI and exported report.

Thirty-nine JavaScript and seventeen Python checks pass. New checks cover 4K
native resolution, high and fractional density, fixed quality after adaptive
scaling, supersampling, GPU limits, repeated density changes without a resize,
and display-listener cleanup. Browser checks on Sleep On It confirmed a
3632 × 2160 native canvas at a 3840 × 2160 viewport, 7264 × 4320 at 200%, and
1833 × 1090 in Performance mode. Resizing and mode changes updated while paused.
At 1440 × 900, 150% produced 1848 × 1350. Playback, seeking, fullscreen,
430 × 900 portrait layout, saved settings across reload, and JSON export with
resolution metadata were verified. No browser warnings or errors were recorded.
The browser viewport override cannot reproduce a physical move between the
user's monitor and TV; repeated density changes are covered by automated tests,
and physical multi-monitor confirmation remains a manual check.

## Portable Windows build — 2026-11-01

Built the current working tree with PyInstaller 6.22.3 on Windows x64 using
Python 3.12.14. Both the terminal build and the root `Build Portable.cmd`
launcher succeeded; the launcher was invoked from an unrelated directory.
The resulting `dist/TabPlayer-0.1.0-windows-x64.zip` is approximately 24.6 MiB.

Every build checks the extracted ZIP in a path containing spaces, with a
different working directory and a child-process PATH containing only Windows
system tools. Checks covered the initially empty catalog, all browser assets
and both Three.js modules, upload/import of a generated ToneLib song, WAV
byte-range serving, folder scan, SQLite FTS search, preview decoding through
the bundled vgmstream executable, prepared-chart reuse, and catalog/cache
persistence after terminating and restarting the executable. The archive was
checked for song archives and personal/development state before extraction;
smoke-test fixtures and generated state are never added to the shared ZIP.
The existing seventeen Python and thirty-nine JavaScript tests also pass.

The packaged browser UI and native folder picker were not manually exercised
in this packaging pass. The smoke test covers HTTP assets and audio data;
it does not assess browser rendering or audible playback on another computer.

## Screen-space line meshes — 2026-11-01

Replaced native WebGL line primitives on the front board, background fret lanes
and moving blue highway rails with Three.js LineSegments2 triangle meshes.
Their screen-space widths are 1.25, 1 and 1.5 CSS pixels respectively. The scene
keeps its existing line colours, opacity, fog, perspective and hand-position
timeline. Moving rails retain their shared Float32Array/interleaved GPU buffer;
only its contents are updated during playback. The three required Three.js
addons are served locally and included in the portable build. Both HTML entry
points resolve their bare `three` import to the existing local module.

Forty-two JavaScript and seventeen Python tests pass. New checks cover apparent
width across native/150%/200% sampling, high display densities and viewport
changes; in-place updates of both rail endpoints; and line colour/depth settings.
The rebuilt portable ZIP passed its isolated launch, asset, import, decoder,
audio and persistence checks, including requests for all three line addons.

Browser checks used the real four-string Sleep On It chart and the dense
five-string benchmark. At a 2560 × 1440 viewport, the player reported drawing
buffers of 2352 × 1440 (native), 3528 × 2160 (150%) and 4704 × 2880 (200%).
Paused comparisons at 1:00 retained apparent line widths at native and 200%;
playback, seeking and a return to the default viewport also worked. No browser
warnings or shader errors were recorded. The dense native benchmark reported
9 draw calls, 7 geometries, one texture, 0.20 ms p95 CPU submission, 2.9 ms p95
callback intervals and no intervals over 25 ms during the measured ten seconds.
These are callback/submission measurements, not GPU time or display scanout.
