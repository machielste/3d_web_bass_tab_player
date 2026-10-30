// Camera fit from the user's traced road, with square pixels and centered optics.
// See docs/highway-reference.json and scripts/calibrate_highway.py.
export const HIGHWAY_REFERENCE = {
  fov: 39.03423806192449,
  depth: 75.08235679594954,
  matrix: [
    .9906581681624848, -.007314834941442818, -.13617226972746396, 0,
    -.01558090649974457, .9859496694575773, -.16631441503712077, 0,
    .13547556682146036, .16688242114217086, .9766251216859674, 0,
    2.6713083069841654, 4.297972320403452, 8.6056236808161, 1
  ]
};

// Query only notes intersecting the visible time window, including long sustains
// which began before a seek. Prefix maximum ends avoid rescanning the whole song.
export class NoteIndex {
  constructor(notes) {
    this.notes = notes;
    let maximum = -Infinity;
    this.ends = notes.map(note => (maximum = Math.max(maximum, note.end)));
  }
  visible(time, lookahead = 7) {
    let lo = 0, hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ends[mid] < time - 0.1) lo = mid + 1; else hi = mid;
    }
    const result = [];
    for (let i = lo; i < this.notes.length && this.notes[i].time <= time + lookahead; i++) {
      if (this.notes[i].end >= time - 0.1) result.push(this.notes[i]);
    }
    return result;
  }
}

export function noteDepth(noteTime, audioTime, spacing = 8) {
  return (audioTime - noteTime) * spacing;
}

export function highwayTiming(beats) {
  // Choose one travel speed for the song, rather than warping the scene when
  // tempo changes. Six typical beats give useful preparation without a crowd
  // of tiny notes on the horizon. Bound unusually slow/fast charts for reading.
  const intervals = [];
  for (let i = 1; i < beats.length; i++) {
    const interval = beats[i].time - beats[i - 1].time;
    if (Number.isFinite(interval) && interval >= 0.125 && interval <= 2) intervals.push(interval);
  }
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const beat = intervals.length
    ? (intervals[middle] + intervals[Math.floor((intervals.length - 1) / 2)]) / 2
    : 3.2 / 6;
  const previewSeconds = Math.max(2.6, Math.min(3.8, beat * 6));
  const depth = HIGHWAY_REFERENCE.depth;
  const spawnDepth = depth * 1.28;
  return { previewSeconds, spacing: depth / previewSeconds, depth, spawnDepth,
    spawnSeconds: previewSeconds * 1.28, fadeStartDepth: depth * .82 };
}

export function stringLaneY(index, count, gap = 0.54) {
  // Source string zero stays the lowest pitch. Only its visual position flips.
  return (count - 1 - index) * gap;
}

export function noteOpacity(depth, roadDepth) {
  const near = roadDepth * 0.82, far = roadDepth * 1.28;
  const t = Math.max(0, Math.min(1, (depth - near) / (far - near)));
  return 1 - t * t * (3 - 2 * t);
}

export class HandPositionTrack {
  constructor(notes) {
    const groups = [];
    for (const note of notes) {
      if (note.fret === 0) continue;
      const previous = groups.at(-1);
      if (previous && Math.abs(previous.time - note.time) < .001) previous.frets.push(note.fret);
      else groups.push({ time: note.time, frets: [note.fret] });
    }
    this.anchors = [];
    let start = 1.5;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      let low = Math.min(...group.frets), high = Math.max(...group.frets);
      if (high - low > 3) low = high = group.frets[0];
      // Pool a short playable phrase to avoid shifting back and forth for each
      // adjacent note. A future out-of-range note starts its own later shift.
      for (let j = i + 1; j < groups.length && groups[j].time <= group.time + .65; j++) {
        const nextLow = Math.min(low, ...groups[j].frets);
        const nextHigh = Math.max(high, ...groups[j].frets);
        if (nextHigh - nextLow > 3) break;
        low = nextLow; high = nextHigh;
      }
      const target = Math.max(-.5, Math.min(low - .5, Math.max(high - 3.5, start)));
      if (!this.anchors.length) this.anchors.push({ time: 0, start: target, transitionStart: 0 });
      else if (target !== start) {
        const previous = this.anchors.at(-1);
        this.anchors.push({ time: group.time, start: target,
          transitionStart: Math.max(previous.time, group.time - .4) });
      }
      start = target;
    }
    if (!this.anchors.length) this.anchors.push({ time: 0, start: 1.5, transitionStart: 0 });
  }

  startAt(time) {
    let lo = 0, hi = this.anchors.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (this.anchors[middle].time <= time) lo = middle + 1; else hi = middle;
    }
    const current = this.anchors[Math.max(0, lo - 1)], next = this.anchors[lo];
    if (!next || time <= next.transitionStart) return current.start;
    const t = Math.max(0, Math.min(1, (time - next.transitionStart) / (next.time - next.transitionStart)));
    return current.start + (next.start - current.start) * t * t * (3 - 2 * t);
  }
}

export class CameraFollow {
  constructor() { this.start = 1.5; this.goal = 1.5; this.lastTime = null; }
  update(time, target) {
    const jump = this.lastTime === null || Math.abs(time - this.lastTime) > .5;
    if (jump) this.start = this.goal = target;
    else {
      // Let the hand box move within the view before following it. The guide
      // is a world-space destination, not an overlay fixed to the camera.
      if (target > this.goal + .8) this.goal = target - .4;
      else if (target < this.goal - .8) this.goal = target + .4;
      const elapsed = Math.max(0, time - this.lastTime);
      this.start += (this.goal - this.start) * (1 - Math.exp(-elapsed * 10));
    }
    this.lastTime = time;
    return this.start;
  }
}

export function noteWorldX(note, handTrack) {
  // Open-string bars belong to the hand box at their own onset, rather than
  // teleporting to wherever the camera happens to be on a later frame.
  return note.fret === 0 ? handTrack.startAt(note.time) + 2 : note.fret;
}
