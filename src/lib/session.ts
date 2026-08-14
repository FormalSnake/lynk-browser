import { createStore } from "@nativedesktop/react";

export interface SessionTab {
  id: string;
  url: string;
  title: string;
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

/// A restored session always has at least one tab to show.
export function normalize(state: SessionState): SessionState {
  if (state.tabs.length === 0) {
    const id = `t${state.nextTabId}`;
    return { ...state, tabs: [{ id, url: "", title: "" }], activeId: id, nextTabId: state.nextTabId + 1 };
  }
  const active = state.tabs.some((t) => t.id === state.activeId) ? state.activeId : state.tabs[0]!.id;
  return { ...state, activeId: active };
}
