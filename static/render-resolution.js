import { renderPixelRatio } from './render-loop.js';

const SCALES = { native: 1, '1.5x': 1.5, '2x': 2, performance: 0 };

export function resolutionMode(value) {
  return Object.hasOwn(SCALES, value) ? value : 'native';
}

export function renderResolution(width, height, deviceRatio, mode = 'native', adaptiveScale = 1,
  limits = { width: Infinity, height: Infinity }) {
  const density = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  mode = resolutionMode(mode);
  // Fixed modes follow physical display pixels, including browser zoom. Only
  // Performance trades sharpness for headroom using the previous adaptive cap.
  const requestedRatio = mode === 'performance'
    ? renderPixelRatio(width, height, density, adaptiveScale) : density * SCALES[mode];
  const ratio = Math.min(requestedRatio, limits.width / Math.max(1, width), limits.height / Math.max(1, height));
  return { ratio, requestedRatio, limited: ratio < requestedRatio };
}

// A density change need not resize the CSS viewport or run another animation
// frame (e.g. a paused window moved between monitors). Re-arm the exact-density
// query after every change so repeated moves and browser zoom keep working.
export class DisplayWatcher {
  constructor(container, changed, view = window, Observer = ResizeObserver) {
    this.view = view;
    this.changed = changed;
    this.densityChanged = () => { this.watchDensity(); this.changed(); };
    this.observer = new Observer(changed);
    this.observer.observe(container);
    view.addEventListener('resize', changed);
    view.addEventListener('focus', changed);
    view.document.addEventListener('visibilitychange', changed);
    this.watchDensity();
  }

  watchDensity() {
    this.query?.removeEventListener('change', this.densityChanged);
    this.query = this.view.matchMedia(`(resolution: ${this.view.devicePixelRatio || 1}dppx)`);
    this.query.addEventListener('change', this.densityChanged);
  }

  disconnect() {
    this.observer.disconnect();
    this.query.removeEventListener('change', this.densityChanged);
    this.view.removeEventListener('resize', this.changed);
    this.view.removeEventListener('focus', this.changed);
    this.view.document.removeEventListener('visibilitychange', this.changed);
  }
}
