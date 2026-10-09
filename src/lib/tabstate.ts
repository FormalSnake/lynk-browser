// Per-tab facts both the app root and each browser window read. They are keyed
// by tab id and live at the root, so a tab moved to another window takes them
// with it.
import type { PopupBlocked } from "@nativedesktop/react";
import { displayUrl } from "./url.ts";

/// What the padlock says. `none` is not a verdict: it is the new-tab page and
/// anything else that never had a chance to be encrypted, and warning there
/// would spend the indicator's credibility on a non-event.
export type Security = "none" | "secure" | "mixed" | "insecure" | "invalid";

/// `none` is the plain site-information mark rather than the globe, which is
/// also the favicon a site without one gets: compact draws the two side by
/// side in the tab on show.
export const SECURITY_ICON: Record<Security, string> = {
  none: "help-about-symbolic",
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
  /// The page's renderer died (crash, out of memory, killed): the sad tab is
  /// up in its place until a reload or a navigation.
  crashed: { error: string } | null;
  security: Security;
  /// Bumped by "Try again": it is the webview's key, so a retry remounts the
  /// engine widget rather than asking a failed view to reload itself.
  attempt: number;
  /// Bumped whenever zoom changes from a chord or a menu step, which is what
  /// shows the zoom popover for a moment.
  zoomNotice: number;
  /// Reading mode is up over the page.
  reading: boolean;
  /// Requests the blocker stopped on the page now showing.
  blocked: number;
  /// The pop-ups the engine blocked on the page now showing, oldest first.
  popups: PopupBlocked[];
}

export const IDLE: Runtime = {
  loading: false,
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  error: null,
  crashed: null,
  security: "none",
  attempt: 0,
  zoomNotice: 0,
  reading: false,
  blocked: 0,
  popups: [],
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

/// What hovering a tab says, the same in both layouts and on a pinned tile:
/// its title, and under it the whole address, which a row or chip only ever
/// shows cut down.
export function tabHover(t: { title: string; url: string }): string {
  if (!t.url) return "New Tab";
  return t.title ? `${t.title}\n${t.url}` : t.url;
}

/// How a window is named where another window offers to send a tab to it:
/// after the tab it is showing, the way Chrome's Move Tab menu names one.
export function windowLabel(active: { title: string; url: string }, count: number): string {
  const label = tabLabel(active);
  if (count <= 1) return label;
  return count === 2 ? `${label} and 1 more tab` : `${label} and ${count - 1} more tabs`;
}
