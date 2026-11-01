import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraFollow, HandPositionTrack, NoteIndex, firstBeatAt, highwayTiming, noteDepth, noteOpacity, noteWorldX, stringLaneY } from '../static/timeline.js';

test('seeking into a sustain keeps its note visible', () => {
  const long = { time: 0, end: 20 };
  const short = { time: 2, end: 3 };
  const next = { time: 12, end: 13 };
  const index = new NoteIndex([long, short, next]);
  assert.deepEqual(index.visible(10, 5), [long, next]);
  assert.deepEqual(index.visible(1, 0.5), [long]);
  assert.deepEqual(index.visible(30), []);
});

test('note positions are derived from the audio clock after seeks', () => {
  assert.equal(noteDepth(12, 10), -16);
  assert.equal(noteDepth(12, 12), 0);
  assert.equal(noteDepth(12, 5), -56);
});

test('visible note storage is reused and peak capacity includes overlapping sustains after seeks', () => {
  const notes = Array.from({ length: 2000 }, (_, i) => ({ time: i / 4, end: i / 4 + (i % 10 === 0 ? 60 : .25) }));
  const index = new NoteIndex(notes), result = [];
  let peak = 0;
  for (const note of notes) {
    const time = note.time - 4;
    const expected = notes.filter(note => note.time <= time + 4 && note.end >= time - .1);
    assert.equal(index.visible(time, 4, result), result);
    assert.deepEqual(result, expected);
    peak = Math.max(peak, expected.length);
  }
  assert.equal(index.maximumVisible(4), peak);
  index.visible(1000, 4, result);
  assert.deepEqual(result, []);
  assert.equal(new NoteIndex([]).maximumVisible(4), 0);
});

test('beat lookup handles seeks and exact boundaries without scanning elapsed beats', () => {
  let reads = 0;
  const beats = new Proxy(Array.from({ length: 100000 }, (_, i) => ({ time: i / 2 })), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return target[key]; }
  });
  assert.equal(firstBeatAt(beats, 49000.1), 98001);
  assert.ok(reads < 20);
  assert.equal(firstBeatAt(beats, 49000), 98000);
  assert.equal(firstBeatAt(beats, 0), 0);
  assert.equal(firstBeatAt(beats, -10), 0);
  assert.equal(firstBeatAt(beats, 100000), beats.length);
  assert.equal(firstBeatAt([], 0), 0);
});

test('six beats at 111 BPM give a shorter preview and a faster approach', () => {
  const beats = Array.from({length: 32}, (_, i) => ({time: i * 60 / 111}));
  const timing = highwayTiming(beats);
  assert.ok(Math.abs(timing.previewSeconds - 360 / 111) < 1e-10);
  assert.ok(timing.spacing > 8);
  assert.ok(Math.abs(noteDepth(12 + timing.previewSeconds, 12, timing.spacing) + timing.depth) < 1e-10);
  assert.equal(noteDepth(12, 12, timing.spacing), 0);
});

test('preview remains bounded for very slow, very fast, or missing beat maps', () => {
  const slow = Array.from({length: 20}, (_, i) => ({time: i * 2}));
  const fast = Array.from({length: 20}, (_, i) => ({time: i * .25}));
  assert.equal(highwayTiming(slow).previewSeconds, 3.8);
  assert.equal(highwayTiming(fast).previewSeconds, 2.6);
  assert.equal(highwayTiming([]).previewSeconds, 3.2);
});

test('lowest string is at the top for both EADG and BEADG', () => {
  for (const count of [4, 5]) {
    const lanes = Array.from({length: count}, (_, i) => stringLaneY(i, count));
    assert.equal(lanes.at(-1), 0);
    for (let i = 1; i < count; i++) assert.ok(lanes[i - 1] > lanes[i]);
  }
});

test('notes emerge transparently behind the finite road and become opaque before playing', () => {
  const timing = highwayTiming([]);
  assert.ok(timing.spawnSeconds > timing.previewSeconds);
  assert.equal(noteOpacity(timing.spawnDepth, timing.depth), 0);
  assert.ok(noteOpacity(timing.depth * 1.1, timing.depth) > 0);
  assert.ok(noteOpacity(timing.depth * 1.1, timing.depth) < .5);
  assert.equal(noteOpacity(0, timing.depth), 1);
  const samples = [1.28, 1.15, 1, .9, .82, .5, 0].map(ratio => noteOpacity(timing.depth * ratio, timing.depth));
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1]);
});

const shiftPhrase = [
  {time:0, end:.5, fret:2}, {time:1, end:1.5, fret:5},
  {time:2, end:2.5, fret:0},
  {time:4, end:4.1, fret:9}, {time:4.2, end:4.3, fret:10},
  {time:4.4, end:4.5, fret:12}
];

test('a hand-position change travels with its musical timestamp instead of moving the whole road', () => {
  const track = new HandPositionTrack(shiftPhrase);
  assert.equal(track.startAt(0), 1.5);
  assert.equal(track.startAt(2.5), 1.5);
  assert.equal(track.startAt(3.5), 1.5);
  assert.ok(Math.abs(track.startAt(3.8) - 5) < 1e-10);
  assert.equal(track.startAt(4), 8.5);
  // A future road segment can already show the destination while the strike
  // plane still occupies the old frets. Seeking samples the same fixed track.
  const timing = highwayTiming([]);
  assert.equal(track.startAt(2 + timing.depth / timing.spacing), 8.5);
  assert.equal(track.startAt(2), 1.5);
  assert.equal(track.startAt(4.4), 8.5);
  assert.equal(track.startAt(0), 1.5);
});

test('notes keep their own absolute fret position through camera and hand shifts', () => {
  const track = new HandPositionTrack(shiftPhrase);
  assert.equal(noteWorldX(shiftPhrase[1], track), 5);
  assert.equal(noteWorldX(shiftPhrase[3], track), 9);
  const openBar = noteWorldX(shiftPhrase[2], track);
  assert.equal(openBar, 3.5);
  assert.equal(track.startAt(5), 8.5);
  assert.equal(noteWorldX(shiftPhrase[2], track), openBar);
  assert.equal(new HandPositionTrack([{time:0,end:1,fret:0}]).startAt(10), 1.5);
});

test('the camera allows small hand-box motion, follows larger shifts separately and restores on seek', () => {
  const camera = new CameraFollow();
  assert.equal(camera.update(0, 1.5), 1.5);
  assert.equal(camera.update(.1, 2), 1.5);
  const position = camera.update(.2, 8.5);
  assert.ok(position > 1.5 && position < 8.5);
  assert.equal(camera.update(10, 8.5), 8.5);
  assert.equal(camera.update(0, 1.5), 1.5);
});

test('camera following has the same result at different frame rates', () => {
  const follow = frames => {
    const camera = new CameraFollow();
    camera.update(0, 1.5);
    for (let i = 1; i <= frames; i++) camera.update(i / frames, 8.5);
    return camera.start;
  };
  assert.ok(Math.abs(follow(30) - follow(120)) < 1e-10);
});
