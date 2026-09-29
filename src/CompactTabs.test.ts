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
        const m = tabRunMetrics(width, run, active, 1);
        expect(m.shown.some((t) => t.id === active)).toBe(true);
        const used = m.shown.reduce((sum, t) => sum + (t.pinned ? 36 : t.id === active ? m.activeWidth : m.width) + 4, 0);
        // What the row has left for the field once the tabs and the rest of
        // the row (the 380 px of furniture and one 44 px slot) are counted.
        expect(width - 380 - 44 - used).toBeGreaterThanOrEqual(ADDRESS_MIN_WIDTH);
        expect(m.activeWidth).toBeGreaterThanOrEqual(width >= 800 ? 120 : 100);
      }
    });
  }
});
