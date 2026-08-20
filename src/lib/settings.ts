import { createStore } from "@nativedesktop/react";

export type SearchEngineId = "duckduckgo" | "google" | "bing";

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /// Everything before the URL-encoded query. `toUrl` recognises a search by
  /// testing the built address against this prefix.
  prefix: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "duckduckgo", name: "DuckDuckGo", prefix: "https://duckduckgo.com/?q=" },
  { id: "google", name: "Google", prefix: "https://www.google.com/search?q=" },
  { id: "bing", name: "Bing", prefix: "https://www.bing.com/search?q=" },
];

export function engineOf(id: SearchEngineId): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!;
}

/// `sidebar` is the vertical tab column; `compact` drops it and moves the tab
/// affordances into the one toolbar row, for reading a single page.
export type Layout = "sidebar" | "compact";

export const LAYOUTS: { id: Layout; name: string }[] = [
  { id: "sidebar", name: "Sidebar" },
  { id: "compact", name: "Compact" },
];

export interface SettingsState {
  searchEngine: SearchEngineId;
  /// Empty means the new-tab page rather than a site.
  homepage: string;
  restoreOnLaunch: boolean;
  layout: Layout;
}

export const DEFAULT_SETTINGS: SettingsState = {
  searchEngine: "duckduckgo",
  homepage: "",
  restoreOnLaunch: true,
  layout: "sidebar",
};

export const settings = createStore<SettingsState>({
  name: "settings",
  version: 1,
  defaults: DEFAULT_SETTINGS,
  dir: process.env.NB_STORE_DIR,
});

/// The store hands back exactly what is on disk, so a settings.json written
/// before a preference existed is missing that key. Every read assumes the
/// full shape, so the gaps are filled once at load.
export function normalizeSettings(state: SettingsState): SettingsState {
  return {
    ...DEFAULT_SETTINGS,
    ...state,
    layout: LAYOUTS.some((l) => l.id === state.layout) ? state.layout : DEFAULT_SETTINGS.layout,
  };
}
