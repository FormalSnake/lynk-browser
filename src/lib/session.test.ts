import { expect, test } from "bun:test";

import { DEFAULT_SESSION, freshStart, normalize, type SessionState } from "./session.ts";
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
