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

export interface SettingsState {
  searchEngine: SearchEngineId;
  /// Empty means the new-tab page rather than a site.
  homepage: string;
  restoreOnLaunch: boolean;
}

export const DEFAULT_SETTINGS: SettingsState = {
  searchEngine: "duckduckgo",
  homepage: "",
  restoreOnLaunch: true,
};

export const settings = createStore<SettingsState>({
  name: "settings",
  version: 1,
  defaults: DEFAULT_SETTINGS,
  dir: process.env.NB_STORE_DIR,
});
