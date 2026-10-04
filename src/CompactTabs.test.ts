import { describe, expect, test } from "bun:test";
import { ADDRESS_MIN_WIDTH, tabRunMetrics, type CompactTab } from "./CompactTabs.tsx";

const tabs = (loose: number, pinned = 0): CompactTab[] => [
  ...Array.from({ length: pinned }, (_, i) => ({ id: `p${i}`, url: `https://p${i}.test/`, title: "Pinned", pinned: true })),
  ...Array.from({ length: loose }, (_, i) => ({ id: `t${i}`, url: `https://t${i}.test/`, title: "A long title", pinned: false })),
];

describe("tabRunMetrics", () => {
  for (const [loose, pinned] of [[1, 0], [4, 0], [6, 2], [20, 0], [12, 6]] as const) {
    test(`${loose} tabs and ${pinned} pinned fit from 1440 down to 720`, () => {
      const run = tabs(loose, pinned);
      const active = run[run.length - 1]!.id;
      for (let width = 1440; width >= 720; width -= 40) {
        const m = tabRunMetrics(width, run, active, 1, "gtk", true);
        expect(m.shown.some((t) => t.id === active)).toBe(true);
        const used = m.shown.reduce((sum, t) => sum + (t.pinned ? 36 : t.id === active ? m.activeWidth : m.width) + 4, 0);
        // What the row has left for the field once the tabs and the rest of
        // the row (the 424 px of GTK furniture, less the layout button below 960 px, and one 44 px slot) are counted.
        expect(width - 424 + (width >= 960 ? 0 : 40) - 44 - used).toBeGreaterThanOrEqual(ADDRESS_MIN_WIDTH);
        expect(m.activeWidth).toBeGreaterThanOrEqual(width >= 800 ? 120 : 90);
      }
    });
  }

  // The main window's row has no field: the active tab is the address.
  for (const backend of ["gtk", "appkit"] as const) {
    const furniture = backend === "gtk" ? 424 : 380;
    for (const [loose, pinned, at] of [[1, 0, 0], [4, 0, 3], [6, 2, 7], [20, 0, 10], [12, 6, 0], [3, 3, 1]] as const) {
      test(`${backend}: the address tab among ${loose} tabs and ${pinned} pinned holds its floor down to 720`, () => {
        const run = tabs(loose, pinned);
        const active = run[at]!.id;
        for (let width = 1440; width >= 720; width -= 40) {
          const m = tabRunMetrics(width, run, active, 1, backend, false);
          expect(m.address).toBe(true);
          expect(m.shown.some((t) => t.id === active)).toBe(true);
          expect(m.activeWidth).toBeGreaterThanOrEqual(200);
          expect(m.activeWidth).toBeLessThanOrEqual(280);
          const used = m.shown.reduce((sum, t) => sum + (t.id === active ? m.activeWidth : t.pinned ? 36 : m.width) + 4, 0);
          expect(width - furniture + (width >= 960 ? 0 : 40) - 44 - used).toBeGreaterThanOrEqual(-4);
        }
      });
    }
  }
});
