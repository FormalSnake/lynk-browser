import { expect, test } from "bun:test";
import type { Store } from "@nativedesktop/react";
import { createRoot, flush } from "solid-js";

import { trackStore } from "./live.ts";
import type { SessionState, SessionTab } from "./session.ts";

function source<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const cb of subs) cb(next);
      flush();
    },
    update(fn: (v: T) => T) {
      value = fn(value);
      for (const cb of subs) cb(value);
      flush();
    },
    subscribe(cb: (v: T) => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  } as unknown as Store<T>;
}

const tab = (id: string, extra: Partial<SessionTab> = {}): SessionTab => ({ id, url: `https://${id}.test/`, title: id, pinned: false, ...extra });

function session(): SessionState {
  return {
    windows: [
      { id: "w1", tabs: [tab("t1"), tab("t2", { pinned: true, pinnedUrl: "https://t2.test/" }), tab("t3")], activeId: "t1", width: 900, height: 700 },
      { id: "w2", tabs: [tab("t4")], activeId: "t4", width: 800, height: 600 },
    ],
    nextTabId: 5,
    nextWindowId: 3,
    zoomByHost: { "a.test": 1.25 },
  };
}

function tracked() {
  const src = source(session());
  const state = createRoot(() => trackStore(src));
  return { src, state };
}

test("a tab switch writes the window's active tab and keeps every row", () => {
  const { src, state } = tracked();
  const rows = [...state.windows[0]!.tabs];
  src.update((s) => ({ ...s, windows: s.windows.map((w) => (w.id === "w1" ? { ...w, activeId: "t3" } : w)) }));
  expect(state.windows[0]!.activeId).toBe("t3");
  expect(state.windows[0]!.tabs.every((t, i) => t === rows[i])).toBe(true);
  expect(JSON.parse(JSON.stringify(state))).toEqual(src.get());
});

test("a field that goes away is removed, and a changed row keeps its proxy", () => {
  const { src, state } = tracked();
  const pinned = state.windows[0]!.tabs[1]!;
  src.update((s) => ({
    ...s,
    windows: s.windows.map((w) => ({ ...w, tabs: w.tabs.map((t) => (t.id === "t2" ? { id: t.id, url: t.url, title: "Two", pinned: false } : t)) })),
  }));
  expect(state.windows[0]!.tabs[1]).toBe(pinned);
  expect(pinned.title).toBe("Two");
  expect("pinnedUrl" in pinned).toBe(false);
  expect(JSON.parse(JSON.stringify(state))).toEqual(src.get());
});

test("rows that move, come and go are matched by id", () => {
  const { src, state } = tracked();
  const [t1, , t3] = state.windows[0]!.tabs;
  src.update((s) => ({
    ...s,
    windows: s.windows.map((w) => (w.id === "w1" ? { ...w, tabs: [w.tabs[2]!, w.tabs[0]!, tab("t5")] } : w)),
    nextTabId: 6,
    zoomByHost: {},
  }));
  expect(state.windows[0]!.tabs[0]).toBe(t3);
  expect(state.windows[0]!.tabs[1]).toBe(t1);
  expect(JSON.parse(JSON.stringify(state))).toEqual(src.get());
});

test("a window that closes and one that opens leave the rest as they were", () => {
  const { src, state } = tracked();
  src.update((s) => ({ ...s, windows: [s.windows[1]!, { id: "w3", tabs: [tab("t6")], activeId: "t6", width: 1, height: 1 }] }));
  expect(JSON.parse(JSON.stringify(state))).toEqual(src.get());
  src.update((s) => ({ ...s, windows: s.windows.map((w) => ({ ...w, width: w.width + 1 })) }));
  expect(JSON.parse(JSON.stringify(state))).toEqual(src.get());
});
