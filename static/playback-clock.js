// Media time stays authoritative. Between observations, advance on the display
// timeline so media-clock quantization and callback dispatch jitter don't become
// repeated frames followed by jumps. Normal corrections change speed by at most
// 2%; seeks, transport changes and suspensions explicitly reset the anchor.
// media/duration are seconds; frame/sampledAt use the performance time origin, ms.
export class PlaybackClock {
  constructor() { this.reset(); }

  reset() { this.frame = null; this.media = null; this.time = null; this.rate = null; }

  sample(media, frame, sampledAt, playing, rate = 1, duration = Infinity) {
    const elapsed = this.frame === null ? 0 : (frame - this.frame) / 1000;
    const observed = Math.max(0, media - Math.max(0, sampledAt - frame) / 1000 * rate);
    const predicted = this.time === null ? observed : this.time + Math.max(0, elapsed) * rate;
    let time;
    if (!playing) time = media;
    else if (this.frame === null || elapsed < 0 || elapsed > .25 || rate !== this.rate || Math.abs(observed - predicted) > .12) time = observed;
    else {
      const correction = media === this.media ? 0 : (observed - predicted) * (1 - Math.exp(-elapsed / .5));
      const limit = elapsed * rate * .02;
      time = Math.max(this.time, predicted + Math.max(-limit, Math.min(limit, correction)));
    }
    this.frame = playing ? frame : null;
    this.media = media; this.rate = rate;
    // Missing/stalled media must never let an independent clock run away.
    const tolerance = .04 * rate;
    this.time = Math.max(0, Math.min(duration, Math.max(media - tolerance, Math.min(media + tolerance, time))));
    return this.time;
  }
}
