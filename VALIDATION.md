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
