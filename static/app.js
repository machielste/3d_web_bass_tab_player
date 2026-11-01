import { SongLibrary, api, waitJob } from './library.js';
import { formatTime } from './virtual-list.js';
import { RenderLoop } from './render-loop.js';
import { PlaybackClock } from './playback-clock.js';
import { FrameDiagnostics } from './frame-diagnostics.js';
import { resolutionMode } from './render-resolution.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
let highway, highwayPromise, library, chart = null, loading = false, request = 0, seeking = false, buffering = true;
let lastHudTime = -Infinity;
let lastResolution = null, resolutionText = '';
const motionClock = new PlaybackClock();
const renderStats = new URLSearchParams(location.search).get('perf') !== '0' ? {
  root: document.createElement('div'), element: document.createElement('pre'), trace: new FrameDiagnostics(), since: 0,
  rawClock: new URLSearchParams(location.search).get('clock') === 'raw'
} : null;
const renderLoop = new RenderLoop({
  draw: drawFrame,
  isPlaying: canAnimate,
  isVisible: () => highway && !document.hidden && !$('playback').hidden
});
audio.volume = Number($('volume').value);
try { $('render-resolution').value = resolutionMode(localStorage.getItem('render-resolution')); } catch { /* Use native if storage is unavailable. */ }

function message(text = '', error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = !text;
}

function playerUrl(id) {
  const params = new URLSearchParams({ song: id });
  params.set('perf', renderStats ? '1' : '0');
  if (renderStats?.rawClock) params.set('clock', 'raw');
  return `?${params}`;
}

function setView(player) {
  resetPlaybackTiming(player ? 'player-view' : 'library-view');
  $('library').hidden = player; $('playback').hidden = !player;
  document.body.classList.toggle('playing-view', player);
  $('player-more').open = false;
  $('show-library').classList.toggle('active', !player);
  $('show-player').classList.toggle('active', player);
  library?.setVisible(!player);
  if (!player) { audio.pause(); history.replaceState({}, '', renderStats ? '/?perf=1' : '/?perf=0'); }
  else {
    if (chart) {
      history.replaceState({}, '', playerUrl(chart.id));
      document.title = `${chart.title} — Tab Player`;
    }
    highway?.resize();
  }
  renderLoop.invalidate();
}

async function ensureHighway() {
  if (!highwayPromise) highwayPromise = import('./highway.js').then(({ Highway }) => {
    highway = new Highway($('stage'), () => renderLoop.invalidate());
    highway.setResolution($('render-resolution').value);
    if (renderStats) {
      installRenderStats();
    }
    highway.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); audio.pause(); message('The graphics connection was lost. Reload the page to continue.', true);
    });
    return highway;
  }).catch(error => { highwayPromise = null; throw error; });
  return highwayPromise;
}

function updateState() {
  const playing = chart && !audio.paused && !audio.ended;
  $('state').textContent = loading ? 'Opening…' : playing ? 'Playing' : audio.ended ? 'Finished' : chart ? 'Paused' : 'Ready';
  $('state').className = `state${loading ? ' loading' : playing ? ' playing' : ''}`;
  $('play-icon').textContent = playing ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('play').disabled = !chart || loading;
  $('seek').disabled = !chart || loading;
  $('restart').disabled = !chart || loading;
  $('open').disabled = loading;
  $('player-open').disabled = loading;
  $('show-player').hidden = !chart && !loading;
  lastHudTime = -Infinity;
  renderLoop.invalidate();
}

async function play() {
  try {
    if (audio.ended) audio.currentTime = 0;
    await audio.play();
    message();
  } catch (error) {
    message(error.name === 'NotAllowedError' ? 'Ready. Press Play to begin.' : 'Audio could not start. Try opening the song again.', error.name !== 'NotAllowedError');
  }
}

async function showSong(song, autoplay = true) {
  await ensureHighway();
  highway.setSong(song);
  chart = song;
  motionClock.reset();
  renderStats?.trace.reset();
  $('empty').hidden = true;
  $('title').textContent = chart.title;
  $('eyebrow').textContent = 'BASS';
  $('subtitle').textContent = chart.artist || '';
  $('song-source').textContent = `${chart.format} · ${chart.strings.length}-string bass`;
  $('legend').replaceChildren(...chart.strings.map((name, i) => {
    const element = document.createElement('span');
    const dot = document.createElement('i'); dot.style.setProperty('--string', highway.colors[i]);
    element.append(dot, document.createTextNode(name)); return element;
  }));
  document.title = `${chart.title} — Tab Player`;
  history.replaceState({}, '', playerUrl(chart.id));
  audio.src = chart.audio_url;
  audio.load();
  $('seek').value = '0';
  loading = false;
  updateState();
  if (autoplay) await play();
}

library = new SongLibrary(async song => {
  const id = ++request;
  audio.pause(); loading = true; setView(true); updateState();
  message(`Opening ${song.title}…`);
  try {
    const { job } = await api('play', { id: song.id });
    const result = await waitJob(job, () => id === request);
    if (!result || id !== request) return;
    await showSong(result);
  } catch (error) {
    if (id === request) message(error.message || 'Could not open this song.', true);
  } finally { if (id === request) { loading = false; updateState(); } }
});

function showLibrary() {
  ++request; loading = false; message(); setView(false); updateState();
  document.title = 'Song Library — Tab Player';
}
for (const id of ['show-library', 'player-library']) $(id).addEventListener('click', showLibrary);
$('show-player').addEventListener('click', () => setView(true));

for (const id of ['open', 'player-open']) $(id).addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  const id = ++request;
  audio.pause(); loading = true; setView(true); updateState();
  message(`Opening ${file.name}…`);
  try {
    const response = await fetch(`/api/open?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
    });
    const document = await response.json();
    if (id !== request) return;
    if (!response.ok) throw new Error(document.error || 'This song could not be opened.');
    await showSong(document);
  } catch (error) {
    if (id === request) message(error.message || 'Could not open the selected file.', true);
  } finally {
    if (id === request) { loading = false; updateState(); $('file').value = ''; }
  }
});
$('play').addEventListener('click', () => audio.paused ? play() : audio.pause());
$('restart').addEventListener('click', () => {
  audio.currentTime = 0;
  resetPlaybackTiming('restart');
  $('seek').value = '0'; $('elapsed').textContent = formatTime(0);
  renderLoop.invalidate(); updateState();
});
$('volume').addEventListener('input', () => {
  audio.volume = Number($('volume').value); library.audio.volume = audio.volume * .6;
  $('volume-level').textContent = `${Math.round(audio.volume * 100)}%`;
});
$('render-resolution').addEventListener('change', () => {
  const mode = resolutionMode($('render-resolution').value);
  try { localStorage.setItem('render-resolution', mode); } catch { /* The current session still works. */ }
  renderStats?.trace.mark(`resolution-${mode}`, performance.now(), audio.currentTime, false);
  if (renderStats) renderStats.since = -Infinity;
  highway?.setResolution(mode);
});
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    message('Fullscreen could not start. You can also use your browser’s fullscreen command.', true);
  }
}
$('fullscreen').hidden = !document.fullscreenEnabled;
$('fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-label').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  highway?.resize();
});
for (const event of ['focus', 'blur']) window.addEventListener(event, () => {
  renderStats?.trace.mark(event, performance.now(), audio.currentTime, false);
});
$('seek').addEventListener('input', () => {
  seeking = true;
  audio.currentTime = Number($('seek').value);
  resetPlaybackTiming('seek-input');
  $('elapsed').textContent = formatTime(audio.currentTime);
  renderLoop.invalidate();
});
$('seek').addEventListener('change', () => { seeking = false; });
for (const event of ['play', 'pause', 'ended', 'loadedmetadata']) audio.addEventListener(event, updateState);
for (const event of ['loadstart', 'waiting', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'emptied', 'loadedmetadata']) {
  audio.addEventListener(event, () => {
    if (['loadstart', 'waiting', 'emptied'].includes(event)) buffering = true;
    if (event === 'playing') buffering = false;
    resetPlaybackTiming(event);
  });
}
audio.addEventListener('loadedmetadata', () => {
  $('duration').textContent = formatTime(audio.duration);
  $('seek').max = String(audio.duration);
});
audio.addEventListener('error', () => message('The backing audio could not be played. Try another song.', true));
document.addEventListener('keydown', event => {
  if ($('playback').hidden || document.querySelector('dialog[open]') ||
      event.target.closest('input, select, textarea, [contenteditable]')) return;
  if (event.code === 'Space' && chart && !loading && !event.target.closest('button, a, summary')) {
    event.preventDefault();
    if (!event.repeat) audio.paused ? play() : audio.pause();
  } else if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat && document.fullscreenEnabled) {
    event.preventDefault(); toggleFullscreen();
  }
});
document.addEventListener('visibilitychange', () => {
  resetPlaybackTiming(document.hidden ? 'hidden' : 'visible');
  if (document.hidden) library.stopPreview();
});

try {
  updateState();
  const key = new URL(location.href).searchParams.get('song');
  if (key && /^[a-f0-9]{64}$/.test(key)) {
    setView(true);
    const response = await fetch(`/songs/${key}/chart.json`);
    if (!response.ok) throw new Error('The preloaded song is no longer available.');
    await showSong(await response.json(), false);
  }
} catch (error) {
  message(error.message || 'The 3D player needs a browser with WebGL 2 support.', true);
  updateState();
}

function canAnimate() { return !audio.paused && !audio.ended && !audio.seeking && !loading && !buffering; }

function resetPlaybackTiming(event) {
  motionClock.reset();
  renderStats?.trace.mark(event, performance.now(), audio.currentTime);
  if (renderStats) renderStats.since = -Infinity;
  lastHudTime = -Infinity;
  renderLoop.invalidate();
}

function installRenderStats() {
  const stats = renderStats;
  stats.trace.observeBrowser();
  stats.root.className = 'render-stats';
  stats.root.setAttribute('aria-label', 'Rendering performance');
  const controls = document.createElement('div'); controls.className = 'render-stats-controls';
  const label = document.createElement('label'), toggle = document.createElement('input');
  toggle.type = 'checkbox'; toggle.checked = stats.rawClock;
  label.append(toggle, document.createTextNode('Raw audio clock'));
  toggle.addEventListener('change', () => {
    stats.rawClock = toggle.checked;
    history.replaceState({}, '', playerUrl(chart.id));
    resetPlaybackTiming(stats.rawClock ? 'raw-clock' : 'smooth-clock');
  });
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save timing report';
  save.addEventListener('click', () => {
    const report = stats.trace.report(performance.now(), {
      userAgent: navigator.userAgent, clock: stats.rawClock ? 'raw' : 'smooth', song: chart?.title,
      visibility: document.visibilityState, focused: document.hasFocus(), devicePixelRatio,
      viewport: [highway.width, highway.height],
      drawingBuffer: [highway.renderer.domElement.width, highway.renderer.domElement.height],
      rendering: { mode: highway.resolutionMode, ...highway.resolution, deviceRatio: highway.deviceRatio }
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'tab-player-timing.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  controls.append(label, save);
  const reference = document.createElement('div'); reference.className = 'render-reference';
  reference.title = 'CSS timing reference: compare this moving dot with highway motion.';
  reference.setAttribute('aria-label', 'CSS timing reference');
  reference.append(document.createElement('i'));
  stats.root.append(stats.element, controls, reference);
  $('stage').append(stats.root);
}

function drawFrame(now) {
  const before = performance.now();
  const mediaTime = audio.currentTime;
  const running = canAnimate();
  const smoothTime = motionClock.sample(mediaTime, now, before, running, audio.playbackRate,
    Number.isFinite(audio.duration) ? audio.duration : Infinity);
  const visualTime = renderStats?.rawClock ? mediaTime : smoothTime;
  highway.render(visualTime, running ? now : null);
  const cpuMs = performance.now() - before;
  if (highway.resolution !== lastResolution) {
    lastResolution = highway.resolution;
    const canvas = highway.renderer.domElement;
    resolutionText = `${canvas.width} × ${canvas.height} · ${Math.round(highway.renderer.getPixelRatio() / highway.deviceRatio * 100)}%${highway.resolution?.limited ? ' · GPU limit' : ''}`;
    $('render-resolution-size').textContent = resolutionText;
  }
  if (renderStats) {
    const stats = renderStats;
    if (running) stats.trace.record(now, before, mediaTime, visualTime, cpuMs, highway.renderer.info.render.calls, audio.playbackRate);
    else stats.trace.previous = null;
    if (now - stats.since >= 1000 || !running) {
      const summary = stats.trace.summary(before);
      stats.element.textContent = [
        `${summary.callbackHz.toFixed(0)} callbacks/s · raw motion ${summary.rawMotionHz.toFixed(0)}/s · ${stats.rawClock ? 'RAW' : 'SMOOTH'} clock`,
        `Frame p95 ${summary.frameMs.p95.toFixed(1)} · p99 ${summary.frameMs.p99.toFixed(1)} · max ${summary.frameMs.max.toFixed(1)} ms`,
        `${summary.lateFrames} late (>${summary.lateThresholdMs.toFixed(1)} ms) · ${summary.repeatedMedia} repeated media samples`,
        `Clock step error p95 ${summary.mediaStepErrorMs.p95.toFixed(2)} ms · dispatch lag p95 ${summary.callbackLagMs.p95.toFixed(1)} ms`,
        `Visual step error p95 ${summary.visualStepErrorMs.p95.toFixed(2)} ms · media offset ${((visualTime - mediaTime) * 1000).toFixed(1)} ms`,
        `CPU p95 ${summary.cpuMs.p95.toFixed(2)} ms · ${highway.renderer.info.render.calls} draw calls`,
        `Main thread: ${summary.longTasks} long tasks · ${summary.longFrames} long frames (2 s)`,
        `${resolutionText} · ${highway.resolutionMode}`
      ].join('\n');
      stats.since = now;
    }
  }
  if (now - lastHudTime >= 100) {
    lastHudTime = now;
    if (!seeking) $('seek').value = String(audio.currentTime);
    const elapsed = formatTime(audio.currentTime);
    if ($('elapsed').textContent !== elapsed) $('elapsed').textContent = elapsed;
  }
}
