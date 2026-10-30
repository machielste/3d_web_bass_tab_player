// Keep DOM work independent of the catalog size. Shared with the range tests.
export const ROW_HEIGHT = 80;
export const PAGE_SIZE = 100;

export function visibleRange(scrollTop, height, total, overscan = 4) {
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT) - overscan);
  const end = Math.min(total, Math.ceil((Math.max(0, scrollTop) + height) / ROW_HEIGHT) + overscan);
  return { start: Math.min(start, total), end };
}

export function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
}
