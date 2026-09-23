/// Page zoom steps. Chromium's own preset levels, so a step from the menu, the
/// zoom popover and a chord inside the page (which the engine serves itself)
/// all land on the same values.
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export const ZOOM_MIN = ZOOM_STEPS[0]!;
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/// The next preset above or below `current`. A factor between two presets
/// (restored from an older session) steps to the nearest one in that direction.
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_MIN;
}

export function clampZoom(factor: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100));
}

export function isDefaultZoom(factor: number): boolean {
  return Math.abs(factor - 1) < 0.005;
}

export function zoomPercent(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/// How long the popover stays up after a chord or a menu step, the same
/// time Chrome gives its zoom bubble.
export const ZOOM_NOTICE_MS = 1500;
