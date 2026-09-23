// Per-tab facts both the app root and each browser window read. They are keyed
// by tab id and live at the root, so a tab moved to another window takes them
// with it.
import type { DownloadItem } from "./downloads.ts";
import { displayUrl, hostOf } from "./url.ts";

/// What the padlock says. `none` is not a verdict: it is the new-tab page and
/// anything else that never had a chance to be encrypted, and warning there
/// would spend the indicator's credibility on a non-event.
export type Security = "none" | "secure" | "mixed" | "insecure" | "invalid";

export const SECURITY_ICON: Record<Security, string> = {
  none: "web-browser-symbolic",
  secure: "channel-secure-symbolic",
  mixed: "dialog-warning-symbolic",
  insecure: "channel-insecure-symbolic",
  invalid: "dialog-warning-symbolic",
};

export const SECURITY_TOOLTIP: Record<Security, string> = {
  none: "No page loaded",
  secure: "This page uses a valid certificate",
  mixed: "Parts of this page are not encrypted",
  insecure: "This page is not encrypted",
  invalid: "This site's certificate could not be verified",
};

export interface Runtime {
  loading: boolean;
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { url: string; error: string } | null;
  security: Security;
  /// Bumped by "Try again": it is the webview's key, so a retry remounts the
  /// engine widget rather than asking a failed view to reload itself.
  attempt: number;
}

export const IDLE: Runtime = {
  loading: false,
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  error: null,
  security: "none",
  attempt: 0,
};

export interface FindState {
  open: boolean;
  query: string;
  /// GTK reports a real match count; WKFindResult only reports match/no-match,
  /// so `count` is null there and the bar shows found/not found instead. Both
  /// stay null until the engine answers, so the bar never claims a result it
  /// does not have yet.
  count: number | null;
  found: boolean | null;
}

export const NO_FIND: FindState = { open: false, query: "", count: null, found: null };

/// `securityChanged` reports TLS facts; the padlock has to say what they mean
/// for THIS address. A page that never had a chance to be encrypted (file://,
/// an extension page, about:) is not "insecure", it is simply not a site.
export function securityOf(url: string, data: unknown): Security {
  const state = (data ?? {}) as { secure?: boolean; insecureContent?: boolean; error?: string };
  if (state.error) return "invalid";
  if (state.insecureContent) return "mixed";
  if (state.secure) return "secure";
  return url.startsWith("http://") ? "insecure" : "none";
}

/// A search the engine has answered and answered with nothing. Both halves
/// matter: a query the engine has not reported on yet is not a failure, and
/// an empty query is not a search.
export function findFailed(find: FindState): boolean {
  if (!find.query) return false;
  return find.count === 0 || find.found === false;
}

export function findSummary(find: FindState): string {
  if (!find.query) return "";
  if (find.count !== null) return find.count === 1 ? "1 match" : `${find.count} matches`;
  if (find.found === null) return "";
  return find.found ? "Found" : "No matches";
}

/// One line under a download's name. A transfer in flight and one that failed
/// each say so; a finished one says where it came from, which is the only
/// thing about it still worth knowing.
export function downloadStatus(d: DownloadItem): string {
  if (d.state === "running") return "Downloading…";
  if (d.state === "failed") return "Download failed";
  const host = hostOf(d.url);
  return host ? `From ${host}` : "Saved";
}

/// Addresses a view has to be CREATED at. Chromium refuses a
/// renderer-initiated navigation from about:blank to any of these, so the
/// arming dance (create empty, set the URL one render later) leaves the tab on
/// about:blank instead, and a restored chrome:// tab comes back blank.
export function createAtUrl(url: string): boolean {
  return /^(chrome|chrome-extension|devtools|view-source):/.test(url);
}

/// What a tab calls itself wherever it is listed: the title its page reported,
/// the address until it reports one, and "New Tab" until there is an address.
export function tabLabel(t: { title: string; url: string }): string {
  return t.title || (t.url ? displayUrl(t.url) : "New Tab");
}

/// How a window is named where another window offers to send a tab to it:
/// after the tab it is showing, the way Chrome's Move Tab menu names one.
export function windowLabel(active: { title: string; url: string }, count: number): string {
  const label = tabLabel(active);
  if (count <= 1) return label;
  return count === 2 ? `${label} and 1 more tab` : `${label} and ${count - 1} more tabs`;
}
