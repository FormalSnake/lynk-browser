/// Chromium pages whose job belongs to the browser's own UI, the way Arc
/// replaced them: every route to one (typed, a link, an extension's
/// chrome.tabs.create, a restored tab) lands on the app's native surface
/// instead. docs/native-pages.md has the reasoning for each, and for the ones
/// that stay Chromium's.
export type NativePage = "downloads" | "history" | "bookmarks" | "newtab" | "tabSearch";

const HOSTS: Record<string, NativePage> = {
  downloads: "downloads",
  history: "history",
  "history-clusters": "history",
  bookmarks: "bookmarks",
  newtab: "newtab",
  "new-tab-page": "newtab",
  "new-tab-page-third-party": "newtab",
  "tab-search.top-chrome": "tabSearch",
  "tab-search": "tabSearch",
};

export function nativePage(url: string): NativePage | null {
  const u = url.trim().toLowerCase();
  // Chromium rewrites these about: forms to chrome://, and the local NTP is
  // the new tab page under another name.
  if (u === "about:newtab" || u.startsWith("chrome-search://local-ntp")) return "newtab";
  if (u === "about:downloads") return "downloads";
  if (u === "about:history") return "history";
  if (u === "about:bookmarks") return "bookmarks";
  const m = /^chrome:\/\/([a-z0-9.-]+)/.exec(u);
  return m ? (HOSTS[m[1]!] ?? null) : null;
}
