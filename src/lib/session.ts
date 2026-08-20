import { createStore } from "@nativedesktop/react";

import { retargetExtensionUrl } from "../extensions/scheme.ts";

export interface SessionTab {
  id: string;
  url: string;
  title: string;
  /// Pinned tabs sort ahead of the rest and the sidebar groups them under
  /// their own heading. The array order mirrors that grouping, so cycling and
  /// the Tabs menu read in the same order the sidebar draws.
  pinned: boolean;
}

export interface SessionState {
  tabs: SessionTab[];
  activeId: string;
  nextTabId: number;
  windowWidth: number;
  windowHeight: number;
  /// Page zoom keyed by host, the way every desktop browser scopes it.
  zoomByHost: Record<string, number>;
}

export const DEFAULT_SESSION: SessionState = {
  tabs: [],
  activeId: "",
  nextTabId: 1,
  windowWidth: 1280,
  windowHeight: 800,
  zoomByHost: {},
};

export const session = createStore<SessionState>({
  name: "session",
  version: 1,
  defaults: DEFAULT_SESSION,
  // NB_STORE_DIR keeps a drive run out of the real profile.
  dir: process.env.NB_STORE_DIR,
});

/// A restored session always has at least one tab to show. It also runs as the
/// store's upgrade step: a session.json written before tabs could be pinned has
/// no `pinned` field, and every read of it assumes a boolean, and a tab left on
/// an extension page carries the scheme of the engine that wrote it.
export function normalize(state: SessionState): SessionState {
  const tabs = state.tabs.map((t) => ({
    ...t,
    pinned: typeof t.pinned === "boolean" ? t.pinned : false,
    url: retargetExtensionUrl(t.url),
  }));
  const pinnedFirst = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  if (pinnedFirst.length === 0) {
    const id = `t${state.nextTabId}`;
    return {
      ...state,
      tabs: [{ id, url: "", title: "", pinned: false }],
      activeId: id,
      nextTabId: state.nextTabId + 1,
    };
  }
  const active = pinnedFirst.some((t) => t.id === state.activeId) ? state.activeId : pinnedFirst[0]!.id;
  return { ...state, tabs: pinnedFirst, activeId: active };
}
