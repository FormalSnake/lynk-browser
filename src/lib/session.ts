import { createStore } from "@nativedesktop/react";

export interface SessionTab {
  id: string;
  url: string;
  title: string;
  /// Pinned tabs sort ahead of the rest and the sidebar groups them under
  /// their own heading. The array order mirrors that grouping, so cycling and
  /// the Tabs menu read in the same order the sidebar draws.
  pinned: boolean;
  /// Where the tab was when it was pinned, which Reset to Pinned Page goes
  /// back to. Absent on a tab that is not pinned.
  pinnedUrl?: string;
}

/// One browser window: its own ordered tabs and the one it is showing. Tab ids
/// are unique across windows, which is what lets a tab move between them and
/// keep everything the app keys by tab.
export interface SessionWindow {
  id: string;
  tabs: SessionTab[];
  activeId: string;
  width: number;
  height: number;
}

export interface SessionState {
  windows: SessionWindow[];
  nextTabId: number;
  nextWindowId: number;
  /// Page zoom keyed by host, the way every desktop browser scopes it.
  zoomByHost: Record<string, number>;
}

export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 800;

export const DEFAULT_SESSION: SessionState = {
  windows: [],
  nextTabId: 1,
  nextWindowId: 1,
  zoomByHost: {},
};

/// What version 1 wrote: one window's worth of state at the top level.
interface SessionV1 {
  tabs?: SessionTab[];
  activeId?: string;
  nextTabId?: number;
  windowWidth?: number;
  windowHeight?: number;
  zoomByHost?: Record<string, number>;
}

export const session = createStore<SessionState>({
  name: "session",
  version: 2,
  defaults: DEFAULT_SESSION,
  // NB_STORE_DIR keeps a drive run out of the real profile.
  dir: process.env.NB_STORE_DIR,
  migrate: (raw, fromVersion) => {
    const data = (raw ?? {}) as Partial<SessionState> & SessionV1;
    if (fromVersion >= 2) return { ...DEFAULT_SESSION, ...data } as SessionState;
    return {
      windows: [
        {
          id: "w1",
          tabs: data.tabs ?? [],
          activeId: data.activeId ?? "",
          width: data.windowWidth ?? WINDOW_WIDTH,
          height: data.windowHeight ?? WINDOW_HEIGHT,
        },
      ],
      nextTabId: data.nextTabId ?? 1,
      nextWindowId: 2,
      zoomByHost: data.zoomByHost ?? {},
    };
  },
});

export function blankTab(id: string): SessionTab {
  return { id, url: "", title: "", pinned: false };
}

/// A window's tabs as they are stored, cleaned up. A new tab is stored with an
/// empty URL, so a stored about:blank is never one the user opened: it is a
/// page-opened tab whose destination never arrived, and restoring it restores
/// a dead row. A session.json written before tabs could be pinned has no
/// `pinned` field, and every read of it assumes a boolean.
function normalizeTabs(tabs: SessionTab[]): SessionTab[] {
  const kept = tabs
    .filter((t) => t.url !== "about:blank")
    .map((t) => ({ ...t, pinned: typeof t.pinned === "boolean" ? t.pinned : false }));
  return [...kept.filter((t) => t.pinned), ...kept.filter((t) => !t.pinned)];
}

/// A restored session always has at least one window, and every window at
/// least one tab to show. A window whose every tab was dropped is dropped
/// with them rather than coming back as an empty new tab, unless it is the
/// only one.
export function normalize(state: SessionState): SessionState {
  let nextTabId = state.nextTabId;
  let nextWindowId = state.nextWindowId;
  const windows: SessionWindow[] = [];
  for (const w of state.windows ?? []) {
    const tabs = normalizeTabs(w.tabs ?? []);
    if (tabs.length === 0) continue;
    const activeId = tabs.some((t) => t.id === w.activeId) ? w.activeId : tabs[0]!.id;
    windows.push({
      id: w.id,
      tabs,
      activeId,
      width: w.width || WINDOW_WIDTH,
      height: w.height || WINDOW_HEIGHT,
    });
  }
  if (windows.length === 0) {
    const id = `t${nextTabId++}`;
    const first = state.windows?.[0];
    windows.push({
      id: first?.id ?? `w${nextWindowId++}`,
      tabs: [blankTab(id)],
      activeId: id,
      width: first?.width || WINDOW_WIDTH,
      height: first?.height || WINDOW_HEIGHT,
    });
  }
  return { ...state, windows, nextTabId, nextWindowId };
}

/// The window a tab lives in, or null for a tab that is gone.
export function windowOfTab(state: SessionState, tabId: string): SessionWindow | null {
  return state.windows.find((w) => w.tabs.some((t) => t.id === tabId)) ?? null;
}

/// Moves a tab to `index` in `toWindow`'s list, where it becomes the tab on
/// show. Within one window this is a reorder. The source window keeps showing
/// what it showed, or its neighbour when the moved tab was the one on show;
/// a window left with no tabs is left empty for the caller to close. A pinned
/// tab stays in the pinned block and an unpinned one outside it, whatever
/// index it was dropped at.
export function moveTabIn(state: SessionState, tabId: string, toWindow: string, index: number): SessionState {
  const from = windowOfTab(state, tabId);
  if (!from || !state.windows.some((w) => w.id === toWindow)) return state;
  const tab = from.tabs.find((t) => t.id === tabId)!;
  const at = from.tabs.indexOf(tab);
  const windows = state.windows.map((w) => {
    let tabs = w.tabs;
    let activeId = w.activeId;
    if (w.id === from.id) {
      tabs = tabs.filter((t) => t.id !== tabId);
      if (activeId === tabId && w.id !== toWindow) activeId = tabs[Math.min(at, tabs.length - 1)]?.id ?? "";
    }
    if (w.id === toWindow) {
      const boundary = tabs.filter((t) => t.pinned).length;
      const lo = tab.pinned ? 0 : boundary;
      const hi = tab.pinned ? boundary : tabs.length;
      const slot = Math.max(lo, Math.min(hi, index));
      tabs = [...tabs.slice(0, slot), tab, ...tabs.slice(slot)];
      activeId = tabId;
    }
    return tabs === w.tabs && activeId === w.activeId ? w : { ...w, tabs, activeId };
  });
  return { ...state, windows };
}

/// "Start with a fresh window": the pinned tabs of every window come back in
/// one window, in front of a new tab, which is the homepage when one is set.
/// Tab and window numbering carry over, so a fresh id never collides with one
/// still in the store.
export function freshStart(stored: SessionState, homepage: string): SessionState {
  const first = stored.windows[0];
  const pins = stored.windows.flatMap((w) => w.tabs.filter((t) => t.pinned && t.url !== "about:blank"));
  const id = `t${stored.nextTabId}`;
  return {
    ...stored,
    nextTabId: stored.nextTabId + 1,
    windows: [
      {
        id: first?.id ?? `w${stored.nextWindowId}`,
        tabs: [...pins, { ...blankTab(id), url: homepage }],
        activeId: id,
        width: first?.width || WINDOW_WIDTH,
        height: first?.height || WINDOW_HEIGHT,
      },
    ],
    nextWindowId: first ? stored.nextWindowId : stored.nextWindowId + 1,
  };
}
