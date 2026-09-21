import { createStore } from "@nativedesktop/react";

import type { PermissionDecision, SitePermissions } from "./permissions.ts";

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
  /// What each site may do, by origin and then by permission type. Only the
  /// Allow and Block buttons write here: a prompt dismissed without an answer
  /// is a deny for that request alone, the way Chrome treats it.
  sitePermissions: SitePermissions;
  /// Extension ids with a toolbar button of their own, in the order they were
  /// pinned. An id that is no longer installed stays here: reinstalling the
  /// extension is meant to bring its button back.
  pinnedExtensions: string[];
}

export const DEFAULT_SETTINGS: SettingsState = {
  searchEngine: "duckduckgo",
  homepage: "",
  restoreOnLaunch: true,
  layout: "sidebar",
  pinnedExtensions: [],
  sitePermissions: {},
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
    pinnedExtensions: Array.isArray(state.pinnedExtensions)
      ? [...new Set(state.pinnedExtensions.filter((id) => typeof id === "string" && id !== ""))]
      : [],
    sitePermissions: normalizeSitePermissions(state.sitePermissions),
  };
}

/// Two levels of a plain JSON object, so both levels are checked: a settings
/// file hand-edited into the wrong shape must not decide what a site may do.
function normalizeSitePermissions(saved: unknown): SitePermissions {
  if (!saved || typeof saved !== "object") return {};
  const out: SitePermissions = {};
  for (const [origin, types] of Object.entries(saved as Record<string, unknown>)) {
    if (!types || typeof types !== "object") continue;
    const kept: Record<string, PermissionDecision> = {};
    for (const [type, decision] of Object.entries(types as Record<string, unknown>)) {
      if (decision === "allow" || decision === "block") kept[type] = decision;
    }
    if (Object.keys(kept).length > 0) out[origin] = kept;
  }
  return out;
}
