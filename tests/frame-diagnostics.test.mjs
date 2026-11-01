import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDiagnostics } from '../static/frame-diagnostics.js';

test('high callback FPS does not hide repeated media positions and low motion update rate', () => {
  const trace = new FrameDiagnostics();
  for (let i = 0; i <= 500; i++) {
    const frame = i * 4;
    trace.record(frame, frame + 2, Math.floor(frame / 40) * .04, frame / 1000, .1, 9);
  }
  const summary = trace.summary(2002);
  assert.equal(summary.callbackHz, 250);
  assert.equal(summary.rawMotionHz, 25);
  assert.equal(summary.repeatedMedia, 450);
  assert.equal(summary.lateFrames, 0);
  assert.ok(summary.mediaStepErrorMs.p95 > 30);
  assert.ok(summary.visualStepErrorMs.p95 < 1e-10);
});

test('short dropped-frame gaps on a high-refresh display are flagged below the old 25 ms threshold', () => {
  const trace = new FrameDiagnostics();
  let frame = 0;
  for (let i = 0; i < 100; i++) {
    frame += i % 10 === 0 ? 16 : 1000 / 360;
    trace.record(frame, frame, frame / 1000, frame / 1000, .1, 9);
  }
  const summary = trace.summary(frame);
  assert.ok(summary.frameMs.max < 25);
  assert.equal(summary.lateFrames, 9);
  assert.equal(summary.frameMs.p95, 16);
  assert.ok(summary.callbackHz > 200);
});

test('diagnostic history is bounded, ordered across wraps, and excludes intentional transport gaps', () => {
  const trace = new FrameDiagnostics(4);
  for (let i = 0; i < 10; i++) trace.record(i * 10, i * 10, i / 100, i / 100, .2, 9);
  assert.deepEqual(trace.rows().map(row => row[0]), [60, 70, 80, 90]);
  assert.equal(trace.samples.length, 4 * trace.report(100).fields.length);
  trace.mark('seeked', 10000, 20);
  trace.record(10010, 10010, 20, 20, .1, 9);
  assert.equal(trace.rows().at(-1)[6], 0);
  assert.equal(trace.summary(10010).samples, 0);
  for (let i = 0; i < 100; i++) trace.mark('pause', i, 20);
  assert.equal(trace.events.length, 64);
  trace.reset();
  assert.deepEqual(trace.rows(), []);
});

test('browser work attribution is feature-detected and bounded for local timing reports', () => {
  const instances = [];
  class Observer {
    static supportedEntryTypes = ['longtask', 'long-animation-frame'];
    constructor(callback) { this.callback = callback; instances.push(this); }
    observe(options) { this.type = options.type; }
  }
  const trace = new FrameDiagnostics();
  trace.observeBrowser(Observer);
  trace.observeBrowser(Observer);
  assert.equal(instances.length, 2);
  for (const instance of instances) {
    instance.callback({ getEntries: () => Array.from({ length: 100 }, (_, i) => ({
      startTime: i * 100, duration: 75, scripts: [{ sourceFunctionName: 'drawFrame', duration: 60 }]
    })) });
  }
  const report = trace.report(10000);
  assert.equal(report.longTasks.length, 64);
  assert.equal(report.longFrames.length, 64);
  assert.equal(report.longFrames[0].scripts[0].sourceFunctionName, 'drawFrame');
  assert.equal(report.summary.longTasks, 20);
  trace.reset();
  assert.deepEqual(trace.report(10000).longTasks, []);
});

test('focus events are recorded without hiding the scheduling gap that follows', () => {
  const trace = new FrameDiagnostics();
  trace.record(0, 0, 0, 0, .1, 9);
  trace.mark('blur', 2, .002, false);
  trace.record(100, 100, .1, .1, .1, 9);
  assert.equal(trace.summary(100).frameMs.max, 100);
  assert.equal(trace.events[0].name, 'blur');
});
