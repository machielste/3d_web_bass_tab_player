// One outstanding animation frame owns all rendering, including resize/seek.
// Paused and hidden views have no recurring callbacks. Resume samples audio time.
export class RenderLoop {
  constructor({ draw, isPlaying, isVisible, requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
    Object.assign(this, { draw, isPlaying, isVisible, requestFrame, cancelFrame });
    this.pending = null;
    this.frame = now => {
      this.pending = null;
      if (!this.isVisible()) return;
      this.draw(now);
      if (this.isPlaying()) this.invalidate();
    };
  }

  invalidate() {
    if (!this.isVisible()) {
      if (this.pending !== null) this.cancelFrame(this.pending);
      this.pending = null;
    } else if (this.pending === null) this.pending = this.requestFrame(this.frame);
  }
}

export function renderPixelRatio(width, height, deviceRatio, scale = 1) {
  // Explicit Performance mode only. Native and supersampled modes keep a fixed
  // display-relative resolution rather than inferring GPU load from frame gaps.
  return Math.min(deviceRatio, 1.75, Math.sqrt(2_000_000 / Math.max(1, width * height))) * scale;
}

export class RenderQuality {
  constructor() { this.scale = 1; this.reset(); }

  reset() { this.previous = null; this.elapsed = 0; this.frames = 0; this.slow = 0; this.stable = 0; }

  sample(now) {
    const interval = this.previous === null ? 0 : now - this.previous;
    this.previous = now;
    // Tab suspension and isolated stalls aren't evidence of sustained GPU load.
    if (interval <= 0 || interval > 250) { this.reset(); this.previous = now; return false; }
    this.elapsed += interval; this.frames++;
    if (interval > 22) this.slow++;
    if (this.elapsed < 1500) return false;
    const before = this.scale;
    if (this.slow / this.frames > .15) {
      this.scale = Math.max(.55, this.scale - .15); this.stable = 0;
    } else if (!this.slow) {
      this.stable += this.elapsed;
      if (this.stable >= 12000) { this.scale = Math.min(1, this.scale + .05); this.stable = 0; }
    } else this.stable = 0;
    this.elapsed = 0; this.frames = 0; this.slow = 0;
    return this.scale !== before;
  }
}
