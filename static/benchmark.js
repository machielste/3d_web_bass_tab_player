import { Highway } from './highway.js';
import { RenderLoop } from './render-loop.js';

const stage = document.getElementById('stage');
let runFrame = null, cancelRun = null;
const loop = new RenderLoop({
  draw: now => runFrame ? runFrame(now) : highway.render(highway.lastTime ?? 300),
  isPlaying: () => Boolean(runFrame), isVisible: () => !document.hidden
});
const highway = new Highway(stage, () => loop.invalidate());
const notes = Array.from({ length: 12000 }, (_, i) => ({
  time: i / 20, end: i / 20 + (i % 9 === 0 ? 2 : .18), string: i % 5, fret: i % 13
}));
highway.setSong({ notes, beats: Array.from({ length: 1500 }, (_, i) => ({ time: i * .4, bar: i % 4 === 0 })), strings: ['B', 'E', 'A', 'D', 'G'] });
highway.render(300);

const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
document.getElementById('run').addEventListener('click', () => {
  const button = document.getElementById('run');
  button.disabled = true;
  document.getElementById('status').textContent = 'Running…';
  document.getElementById('results').textContent = '';
  highway.quality.scale = 1; highway.resize();
  const intervals = [], cpu = [], draws = [];
  let start = null, previous = null;
  function frame(now) {
    if (document.hidden) { finish('Cancelled: keep the benchmark tab visible.'); return; }
    if (start === null) start = now;
    const before = performance.now();
    highway.render(300 + (now - start) / 1000, now);
    const cost = performance.now() - before;
    // The first second warms shader programs, textures and instance buffers.
    if (now - start > 1000) {
      intervals.push(now - previous); cpu.push(cost); draws.push(highway.renderer.info.render.calls);
    }
    previous = now;
    if (now - start >= 11000) finish();
  }
  function finish(error) {
    runFrame = cancelRun = null;
    button.disabled = false;
    document.getElementById('status').textContent = error || 'Complete';
    if (error) return;
    document.getElementById('results').textContent = JSON.stringify({
      viewport: [stage.clientWidth, stage.clientHeight],
      drawingBuffer: [highway.renderer.domElement.width, highway.renderer.domElement.height],
      resolutionMode: highway.resolutionMode,
      resolutionScale: highway.quality?.scale ?? 1,
      frames: intervals.length,
      fps: +(1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)).toFixed(1),
      frameMs: { median: percentile(intervals, .5), p95: percentile(intervals, .95), max: Math.max(...intervals) },
      cpuSubmissionMs: { median: percentile(cpu, .5), p95: percentile(cpu, .95) },
      drawCalls: { median: percentile(draws, .5), max: Math.max(...draws) },
      framesOver25Ms: intervals.filter(value => value > 25).length,
      geometries: highway.renderer.info.memory.geometries,
      textures: highway.renderer.info.memory.textures
    }, null, 2);
  }
  runFrame = frame;
  cancelRun = () => finish('Cancelled: keep the benchmark tab visible.');
  loop.invalidate();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelRun?.();
  loop.invalidate();
});
