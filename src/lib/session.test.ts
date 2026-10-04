import { expect, test } from "bun:test";

import { DEFAULT_SESSION, freshStart, normalize, placeOpenedTab, type SessionState } from "./session.ts";
import { DEFAULT_SETTINGS, normalizeSettings, type SettingsState } from "./settings.ts";

const tab = (id: string, url: string, pinned = false) => ({ id, url, title: id, pinned });

test("a fresh start keeps every window's pins in one window, a new tab in front", () => {
  const stored: SessionState = {
    ...DEFAULT_SESSION,
    windows: [
      { id: "w1", tabs: [tab("t1", "https://a.test/", true), tab("t2", "https://b.test/")], activeId: "t2", width: 900, height: 700 },
      { id: "w2", tabs: [tab("t3", "https://c.test/", true), tab("t4", "https://d.test/")], activeId: "t4", width: 1280, height: 800 },
    ],
    nextTabId: 5,
    nextWindowId: 3,
  };
  const fresh = normalize(freshStart(stored, ""));
  expect(fresh.windows).toHaveLength(1);
  expect(fresh.windows[0]!.tabs.map((t) => t.id)).toEqual(["t1", "t3", "t5"]);
  expect(fresh.windows[0]!.activeId).toBe("t5");
  expect(fresh.windows[0]!.tabs[2]!.url).toBe("");
  expect(fresh.windows[0]!.width).toBe(900);
  expect(fresh.nextTabId).toBe(6);
});

test("a fresh start opens the homepage when one is set", () => {
  const fresh = normalize(freshStart(DEFAULT_SESSION, "https://home.test/"));
  expect(fresh.windows[0]!.tabs.map((t) => t.url)).toEqual(["https://home.test/"]);
});

test("reopen-on-launch off becomes a fresh window", () => {
  const old = { ...DEFAULT_SETTINGS, restoreOnLaunch: false } as unknown as SettingsState;
  delete (old as Partial<SettingsState>).freshWindow;
  const next = normalizeSettings(old);
  expect(next.freshWindow).toBe(true);
  expect("restoreOnLaunch" in next).toBe(false);
  expect(normalizeSettings({ ...DEFAULT_SETTINGS }).freshWindow).toBe(false);
});

test("a page's tab lands where Chrome puts it", () => {
  const tabs = [tab("p", "https://pin.test/", true), tab("a", "https://a.test/"), tab("b", "https://b.test/"), tab("c", "https://c.test/")];
  const none = new Map<string, string>();
  expect(placeOpenedTab(tabs, "a", none, "foregroundTab")).toEqual({ index: 2, foreground: true });
  expect(placeOpenedTab(tabs, "a", none, "popup")).toEqual({ index: 2, foreground: true });
  expect(placeOpenedTab(tabs, "a", none, undefined)).toEqual({ index: 2, foreground: true });
  expect(placeOpenedTab(tabs, "a", none, "backgroundTab")).toEqual({ index: 2, foreground: false });
  // Two earlier ctrl-clicks from a sit right after it: the third goes after them.
  const run = [tab("a", "https://a.test/"), tab("x", "https://x.test/"), tab("y", "https://y.test/"), tab("c", "https://c.test/")];
  const openers = new Map([["x", "a"], ["y", "a"]]);
  expect(placeOpenedTab(run, "a", openers, "backgroundTab")).toEqual({ index: 3, foreground: false });
  // A tab in front still goes right next to its opener.
  expect(placeOpenedTab(run, "a", openers, "foregroundTab")).toEqual({ index: 1, foreground: true });
  // From a pinned tab, the first place outside the pinned block.
  expect(placeOpenedTab(tabs, "p", none, "foregroundTab")).toEqual({ index: 1, foreground: true });
  // An opener that is gone: the end of the list.
  expect(placeOpenedTab(tabs, "gone", none, "backgroundTab")).toEqual({ index: 4, foreground: false });
});
