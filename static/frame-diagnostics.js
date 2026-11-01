const FIELDS = ['frame', 'callback', 'media', 'visual', 'cpuMs', 'calls', 'frameMs', 'callbackMs', 'mediaStepMs', 'visualStepMs', 'clockErrorMs', 'callbackLagMs', 'visualErrorMs'];
const percentile = (values, fraction) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * fraction))] : 0;
const distribution = values => {
  values.sort((a, b) => a - b);
  return { median: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: values.at(-1) ?? 0 };
};

// Bounded local trace, enabled by default during investigation (?perf=0 disables).
// Separate callback scheduling from
// the media timeline: many callbacks can still draw the same musical position.
export class FrameDiagnostics {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.samples = new Float64Array(capacity * FIELDS.length);
    this.observers = [];
    this.observedTypes = [];
    this.reset();
  }

  reset() { this.length = 0; this.cursor = 0; this.previous = null; this.events = []; this.longTasks = []; this.longFrames = []; }

  observeBrowser(Observer = globalThis.PerformanceObserver) {
    if (!Observer || this.observers.length) return;
    for (const type of ['longtask', 'long-animation-frame']) {
      if (!Observer.supportedEntryTypes?.includes(type)) continue;
      const observer = new Observer(list => {
        const target = type === 'longtask' ? this.longTasks : this.longFrames;
        for (const entry of list.getEntries()) {
          target.push({
            startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration,
            renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: entry.scripts?.map(script => ({
              sourceURL: script.sourceURL, sourceFunctionName: script.sourceFunctionName, invoker: script.invoker,
              startTime: script.startTime, duration: script.duration, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration
            }))
          });
        }
        if (target.length > 64) target.splice(0, target.length - 64);
      });
      observer.observe({ type });
      this.observers.push(observer); this.observedTypes.push(type);
    }
  }

  mark(name, now, media, discontinuity = true) {
    if (discontinuity) this.previous = null;
    this.events.push({ name, callback: now, media });
    if (this.events.length > 64) this.events.shift();
  }

  record(frame, callback, media, visual, cpuMs, calls, rate = 1) {
    const previous = this.previous;
    const offset = this.cursor * FIELDS.length;
    const values = this.samples;
    values[offset] = frame; values[offset + 1] = callback;
    values[offset + 2] = media; values[offset + 3] = visual;
    values[offset + 4] = cpuMs; values[offset + 5] = calls;
    values[offset + 6] = previous === null ? 0 : frame - values[previous];
    values[offset + 7] = previous === null ? 0 : callback - values[previous + 1];
    values[offset + 8] = previous === null ? 0 : (media - values[previous + 2]) * 1000;
    values[offset + 9] = previous === null ? 0 : (visual - values[previous + 3]) * 1000;
    values[offset + 10] = previous === null ? 0 : values[offset + 8] - values[offset + 7] * rate;
    values[offset + 11] = callback - frame;
    values[offset + 12] = previous === null ? 0 : values[offset + 9] - values[offset + 6] * rate;
    this.previous = offset;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.length = Math.min(this.length + 1, this.capacity);
  }

  rows() {
    const rows = [];
    for (let i = 0; i < this.length; i++) {
      const index = (this.cursor - this.length + i + this.capacity) % this.capacity;
      rows.push(Array.from(this.samples.subarray(index * FIELDS.length, (index + 1) * FIELDS.length)));
    }
    return rows;
  }

  summary(now, windowMs = 2000) {
    const intervals = [], callbacks = [], lag = [], mediaError = [], visualError = [], cpu = [];
    let elapsed = 0, repeatedMedia = 0, motion = 0;
    for (let i = 0; i < this.length; i++) {
      const index = (this.cursor - this.length + i + this.capacity) % this.capacity;
      const offset = index * FIELDS.length, values = this.samples;
      if (values[offset + 1] < now - windowMs || values[offset + 6] <= 0) continue;
      intervals.push(values[offset + 6]); callbacks.push(values[offset + 7]);
      lag.push(values[offset + 11]); mediaError.push(Math.abs(values[offset + 10]));
      visualError.push(Math.abs(values[offset + 12])); cpu.push(values[offset + 4]);
      elapsed += values[offset + 6];
      if (Math.abs(values[offset + 8]) <= .001) repeatedMedia++;
      if (values[offset + 8] > .001) motion++;
    }
    const frameMs = distribution(intervals);
    const lateThresholdMs = Math.max(frameMs.median * 1.5, frameMs.median + .75);
    return {
      samples: intervals.length,
      callbackHz: elapsed ? intervals.length * 1000 / elapsed : 0,
      rawMotionHz: elapsed ? motion * 1000 / elapsed : 0,
      repeatedMedia,
      lateThresholdMs, lateFrames: intervals.filter(value => value > lateThresholdMs).length,
      frameMs,
      callbackMs: distribution(callbacks), callbackLagMs: distribution(lag),
      mediaStepErrorMs: distribution(mediaError), visualStepErrorMs: distribution(visualError), cpuMs: distribution(cpu),
      longTasks: this.longTasks.filter(entry => entry.startTime + entry.duration >= now - windowMs).length,
      longFrames: this.longFrames.filter(entry => entry.startTime + entry.duration >= now - windowMs).length
    };
  }

  report(now, context = {}) {
    return {
      version: 1, ...context, summary: this.summary(now), fields: FIELDS, samples: this.rows(), events: [...this.events],
      observedTypes: [...this.observedTypes], longTasks: [...this.longTasks], longFrames: [...this.longFrames]
    };
  }
}
