// What the command bar lists, in order, for one query. Pure: the window hands
// in its tabs, the history hits and the engine, and gets rows back, so the
// ranking can be tested without a host. docs/omnibox.md is the spec.
//
// ⌘T and ⌘L rank the typed address, open tabs, history and commands; ⌘K is
// the switcher, open tabs then commands. Every action is a command, so none
// needs a button. Nothing typed leaves the machine until Return.
import { KEYS, type KeyId } from "./keys.ts";
import { displayUrl, hostOf, isSearch, toUrl } from "./url.ts";

/// The row shape <commandpalette> takes.
export interface OmniRow {
  id: string;
  title: string;
  subtitle?: string;
  iconName?: string;
  iconData?: string;
  hint?: string;
  completion?: string;
}

/// ⌘L and ⌘T ask where to go; ⌘K asks which open page, or what to do.
export type OmniMode = "address" | "switcher";

/// Where Enter sends an address: ⌘T opens it in a new tab, ⌘L and ⌘K load it
/// in the tab that is showing.
export type OmniTarget = "current" | "new-tab";

export interface OmniTab {
  id: string;
  title: string;
  url: string;
}

export interface OmniVisit {
  url: string;
  title: string;
}

export interface OmniCommand {
  id: string;
  title: string;
  iconName: string;
  /// The declared shortcut it shares with the menu (lib/keys.ts), shown as
  /// the row's hint.
  keys?: KeyId;
  /// Also found by these words, which are not in the title.
  aka?: string;
}

/// Every action the window has, so the bar can stand in for each button.
export const COMMANDS: OmniCommand[] = [
  { id: "new-tab", title: "New Tab", iconName: "tab-new-symbolic", keys: "new-tab" },
  { id: "new-window", title: "New Window", iconName: "window-new-symbolic", keys: "new-window" },
  { id: "private", title: "New Private Window", iconName: "view-conceal-symbolic", keys: "private" },
  { id: "close-tab", title: "Close Tab", iconName: "window-close-symbolic", keys: "close-tab" },
  { id: "reopen-tab", title: "Reopen Closed Tab", iconName: "edit-undo-symbolic", keys: "reopen-tab" },
  { id: "next-tab", title: "Next Tab", iconName: "go-next-symbolic", keys: "next-tab" },
  { id: "prev-tab", title: "Previous Tab", iconName: "go-previous-symbolic", keys: "prev-tab" },
  { id: "pin-tab", title: "Pin Tab", iconName: "view-pin-symbolic" },
  { id: "duplicate-tab", title: "Duplicate Tab", iconName: "edit-copy-symbolic" },
  { id: "move-new-window", title: "Move Tab to New Window", iconName: "window-new-symbolic" },
  { id: "back", title: "Back", iconName: "go-previous-symbolic", keys: "back" },
  { id: "forward", title: "Forward", iconName: "go-next-symbolic", keys: "forward" },
  { id: "reload", title: "Reload", iconName: "view-refresh-symbolic", keys: "reload" },
  { id: "copy-address", title: "Copy Address", iconName: "edit-copy-symbolic", aka: "url link" },
  { id: "find", title: "Find in Page", iconName: "edit-find-symbolic", keys: "find" },
  { id: "zoom-in", title: "Zoom In", iconName: "zoom-in-symbolic", keys: "zoom-in" },
  { id: "zoom-out", title: "Zoom Out", iconName: "zoom-out-symbolic", keys: "zoom-out" },
  { id: "zoom-reset", title: "Actual Size", iconName: "zoom-original-symbolic", keys: "zoom-reset", aka: "reset zoom" },
  { id: "site-info", title: "Site Settings", iconName: "channel-secure-symbolic", aka: "permissions security" },
  { id: "downloads", title: "Downloads", iconName: "folder-download-symbolic" },
  { id: "extensions", title: "Extensions", iconName: "application-x-addon-symbolic" },
  { id: "extensions-page", title: "Manage Extensions", iconName: "application-x-addon-symbolic" },
  { id: "webstore", title: "Chrome Web Store", iconName: "web-browser-symbolic" },
  { id: "layout", title: "Switch Layout", iconName: "sidebar-show-symbolic", keys: "layout", aka: "sidebar compact" },
  { id: "settings", title: "Settings", iconName: "preferences-system-symbolic", keys: "settings", aka: "preferences" },
];

const MAC_KEYS: Record<string, string> = { primary: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const NAMED_KEYS: Record<string, string> = {
  comma: ",",
  plus: "+",
  minus: "-",
  tab: "Tab",
  bracketleft: "[",
  bracketright: "]",
};

/// "primary+shift+t" as the platform writes it: "⇧⌘T" on macOS, "Ctrl+Shift+T"
/// elsewhere.
export function shortcutLabel(keys: string, mac = process.platform === "darwin"): string {
  const parts = keys.split("+");
  const key = parts.pop() ?? "";
  const shown = NAMED_KEYS[key] ?? key.toUpperCase();
  if (mac) {
    // macOS orders modifiers ⌃⌥⇧⌘ whatever order they were declared in.
    const order = ["ctrl", "alt", "shift", "primary"];
    const mods = order.filter((m) => parts.includes(m)).map((m) => MAC_KEYS[m]);
    return `${mods.join("")}${shown}`;
  }
  const names: Record<string, string> = { primary: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };
  return [...parts.map((m) => names[m] ?? m), shown].join("+");
}

/// A host without its `www.`, which nobody types.
export function bareHost(url: string): string {
  return hostOf(url).replace(/^www\./, "");
}

/// What you would have typed to get somewhere: no scheme, no www.
export function placeKey(url: string): string {
  return displayUrl(url).replace(/^www\./, "");
}

/// Inline completion for what was typed: the first place whose bare host, or
/// failing that whose host and path, starts with the text. Returns the text to
/// complete to and the address Enter should load for it.
export function completionFor(query: string, candidates: string[]): { text: string; url: string } | null {
  const q = query.trim().toLowerCase();
  if (!q || /\s/.test(q) || q.includes("://")) return null;
  for (const url of candidates) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = bareHost(url);
    if (host.startsWith(q)) return { text: host, url: `${u.origin}/` };
    const full = placeKey(url);
    if (full.toLowerCase().startsWith(q)) return { text: full, url };
  }
  return null;
}

export interface OmniInput {
  mode: OmniMode;
  query: string;
  /// Where Enter sends an address, which names the Open hint.
  target: OmniTarget;
  /// Open tabs other than the one showing, most recently shown first.
  tabs: OmniTab[];
  /// History matches, best first. Completion picks from these and nothing
  /// else: only places you have been.
  history: OmniVisit[];
  engineName: string;
  /// Extension-only commands are dropped when the engine cannot host them.
  chromium: boolean;
  /// Whether the showing tab is pinned, which names the pin command.
  pinned?: boolean;
  favicon: (url: string) => string | undefined;
  mac?: boolean;
}

const TABS_SHOWN = 4;
const SWITCHER_TABS = 8;

export function omniRows(input: OmniInput): OmniRow[] {
  return input.mode === "switcher" ? switcherRows(input) : addressRows(input);
}

/// ⌘T and ⌘L: what Enter does with the typed text (the completed address
/// first when there is one), open tabs, history, then commands.
function addressRows(input: OmniInput): OmniRow[] {
  const query = input.query.trim();
  const lowered = query.toLowerCase();
  const rows: OmniRow[] = [];
  const seen = new Set<string>();
  const openHint = input.target === "new-tab" ? "Open in New Tab" : "Open";

  if (query) {
    const done = completionFor(
      query,
      input.history.map((v) => v.url),
    );
    if (done) {
      rows.push({
        id: `go:${done.url}`,
        title: done.text,
        iconData: input.favicon(done.url),
        iconName: "web-browser-symbolic",
        hint: openHint,
        completion: done.text,
      });
      seen.add(done.url);
    }
    const target = toUrl(query);
    if (target && !seen.has(target)) {
      const searching = isSearch(target);
      rows.push(
        searching
          ? { id: "url", title: query, subtitle: `${input.engineName} Search`, iconName: "system-search-symbolic", hint: "Search" }
          : { id: "url", title: displayUrl(target) || query, iconName: "web-browser-symbolic", hint: openHint },
      );
    }
  }

  // An open tab is offered as a switch, never also as a history row that
  // would open it a second time.
  for (const t of input.tabs) seen.add(t.url);
  rows.push(...tabRows(input.tabs, lowered, TABS_SHOWN, input.favicon));

  for (const v of input.history) {
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    const shown = displayUrl(v.url);
    rows.push({
      id: `hist:${v.url}`,
      title: v.title || shown,
      // A page with no title of its own shows its address once, not twice.
      subtitle: v.title && v.title !== shown ? shown : undefined,
      iconData: input.favicon(v.url),
      iconName: "document-open-recent-symbolic",
      hint: openHint,
    });
  }

  rows.push(...commandRows(input, lowered));
  return rows;
}

/// ⌘K: the open tabs, most recently shown first, then every command. The
/// first row is the page you were just on, so ⌘K then Return goes back to it.
function switcherRows(input: OmniInput): OmniRow[] {
  const lowered = input.query.trim().toLowerCase();
  return [...tabRows(input.tabs, lowered, SWITCHER_TABS, input.favicon), ...commandRows(input, lowered)];
}

function tabRows(tabs: OmniTab[], lowered: string, cap: number, favicon: (url: string) => string | undefined): OmniRow[] {
  const rows: OmniRow[] = [];
  for (const t of tabs) {
    if (rows.length >= cap) break;
    const label = t.title || displayUrl(t.url) || "New Tab";
    if (lowered && !`${label} ${t.url}`.toLowerCase().includes(lowered)) continue;
    const shownUrl = displayUrl(t.url);
    rows.push({
      id: `tab:${t.id}`,
      title: label,
      subtitle: shownUrl && shownUrl !== label ? shownUrl : undefined,
      iconData: t.url ? favicon(t.url) : undefined,
      iconName: "web-browser-symbolic",
      hint: "Switch to Tab",
    });
  }
  return rows;
}

function commandRows(input: OmniInput, lowered: string): OmniRow[] {
  const rows: OmniRow[] = [];
  for (const c of COMMANDS) {
    if (!input.chromium && (c.id === "extensions" || c.id === "extensions-page" || c.id === "webstore")) continue;
    const title = c.id === "pin-tab" && input.pinned ? "Unpin Tab" : c.title;
    if (lowered && !`${title} ${c.aka ?? ""}`.toLowerCase().includes(lowered)) continue;
    rows.push({
      id: `cmd:${c.id}`,
      title,
      iconName: c.iconName,
      hint: c.keys ? shortcutLabel(KEYS[c.keys], input.mac) : undefined,
    });
  }
  return rows;
}
