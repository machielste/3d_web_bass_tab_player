import { SongLibrary, api, waitJob } from './library.js';
import { formatTime } from './virtual-list.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
let highway, highwayPromise, library, chart = null, loading = false, request = 0, seeking = false;
audio.volume = Number($('volume').value);

function message(text = '', error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function setView(player) {
  $('library').hidden = player; $('playback').hidden = !player;
  $('show-library').classList.toggle('active', !player);
  $('show-player').classList.toggle('active', player);
  library?.setVisible(!player);
  if (!player) { audio.pause(); history.replaceState({}, '', '/'); }
  else {
    if (chart) history.replaceState({}, '', `?song=${chart.id}`);
    highway?.resize();
  }
}

async function ensureHighway() {
  if (!highwayPromise) highwayPromise = import('./highway.js').then(({ Highway }) => {
    highway = new Highway($('stage'));
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
  $('open').disabled = loading;
  $('show-player').hidden = !chart && !loading;
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
  $('empty').hidden = true;
  $('title').textContent = chart.title;
  $('eyebrow').textContent = `${chart.format} / ${chart.arrangement}`.toUpperCase();
  $('subtitle').textContent = [chart.artist, `${chart.strings.length}-string ${chart.strings.join(' · ')}`].filter(Boolean).join('  /  ');
  $('legend').replaceChildren(...chart.strings.map((name, i) => {
    const element = document.createElement('span');
    const dot = document.createElement('i'); dot.style.setProperty('--string', highway.colors[i]);
    element.append(dot, document.createTextNode(name)); return element;
  }));
  document.title = `${chart.title} — Tab Player`;
  history.replaceState({}, '', `?song=${chart.id}`);
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

$('show-library').addEventListener('click', () => {
  ++request; loading = false; message(); setView(false); updateState();
  document.title = 'Song Library — Tab Player';
});
$('show-player').addEventListener('click', () => setView(true));

$('open').addEventListener('click', () => $('file').click());
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
$('volume').addEventListener('input', () => { audio.volume = Number($('volume').value); library.audio.volume = audio.volume * .6; });
$('seek').addEventListener('input', () => {
  seeking = true;
  audio.currentTime = Number($('seek').value);
  $('elapsed').textContent = formatTime(audio.currentTime);
  highway?.render(audio.currentTime);
});
$('seek').addEventListener('change', () => { seeking = false; });
for (const event of ['play', 'pause', 'ended', 'loadedmetadata']) audio.addEventListener(event, updateState);
for (const event of ['pause', 'ended', 'seeked']) audio.addEventListener(event, () => { if (!$('playback').hidden) highway?.render(audio.currentTime); });
audio.addEventListener('loadedmetadata', () => {
  $('duration').textContent = formatTime(audio.duration);
  $('seek').max = String(audio.duration);
});
audio.addEventListener('error', () => message('The backing audio could not be played. Try another song.', true));
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !$('playback').hidden && !['INPUT', 'BUTTON', 'SELECT'].includes(document.activeElement.tagName) && chart && !loading) {
    event.preventDefault(); audio.paused ? play() : audio.pause();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('playback').hidden) highway?.render(audio.currentTime);
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

let lastHudTime = 0;
function frame(now) {
  if (!document.hidden && !$('playback').hidden) {
    if (!audio.paused) highway?.render(audio.currentTime);
    if (now - lastHudTime > 100) {
      lastHudTime = now;
      if (!seeking) $('seek').value = String(audio.currentTime);
      $('elapsed').textContent = formatTime(audio.currentTime);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
