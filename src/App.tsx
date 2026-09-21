import {
  Spacing,
  executeJavaScript,
  installExtension,
  listExtensionActions,
  listExtensions,
  onExtensionActions,
  onExtensionsList,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  openPath,
  revealPath,
  sendCommand,
  setContextMenuItems,
  showToast,
  useRef,
  useState,
  useStoreValue,
} from "@nativedesktop/react";
import type {
  ContextMenuItem,
  ContextMenuItemClick,
  ExtensionAction,
  InstalledExtension,
  NdNodeRef,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";
// <Activity mode="hidden"> is React's own keep-mounted-but-hidden primitive; it
// drives the renderer's hideInstance/unhideInstance hooks, which the host turns
// into gtk_widget_set_visible. That is what lets every tab keep a LIVE webview:
// switching tabs hides a widget instead of unmounting a subtree, so the page,
// its scroll position and its JS state all survive. @nativedesktop/react does
// not re-export it, hence the direct react import.
import { Activity } from "react";

import type { DownloadItem } from "./lib/downloads.ts";
import { downloadDir, runDownload } from "./lib/downloads.ts";
import {
  clampPopup,
  extensionRows,
  pinnedRows,
  togglePinned,
  POPUP_DEFAULT_HEIGHT,
  POPUP_DEFAULT_WIDTH,
  POPUP_MIN,
  type ExtensionRow,
} from "./lib/extensions.ts";
import { faviconFor, fetchFavicon, rememberFavicon } from "./lib/favicons.ts";
import { recentVisits, recordTitle, recordVisit, searchHistory, type Visit } from "./lib/history.ts";
import { FIND_BAR_WIDTH } from "./lib/metrics.ts";
import {
  decisionsFor,
  forgetOrigin,
  permissionName,
  permissionSentence,
  rememberDecision,
  originOf,
  rememberedDecision,
  splitTypes,
  type PermissionDecision,
  type PermissionPrompt,
} from "./lib/permissions.ts";
import { session } from "./lib/session.ts";
import { LAYOUTS, SEARCH_ENGINES, engineOf, settings, type Layout } from "./lib/settings.ts";
import { displayUrl, fileNameFromUrl, hostOf, isSearch, toUrl } from "./lib/url.ts";
import { PrivateWindow } from "./PrivateWindow.tsx";

/// Every action a tab row can carry. A row names the ones it wants through
/// `actionIds`, which is what keeps Pin and Unpin off the same row.
const TAB_ACTIONS: SourceTreeAction[] = [
  { id: "pin", iconName: "view-pin-symbolic", tooltip: "Pin Tab" },
  { id: "unpin", iconName: "view-pin-symbolic", tooltip: "Unpin Tab" },
  { id: "close", iconName: "window-close-symbolic", tooltip: "Close Tab" },
];

/// Most recent downloads the toolbar popover lists. Older ones are still on
/// disk; the panel is a receipt for what just happened, not a file manager.
const DOWNLOADS_SHOWN = 6;

const TEST_HOOKS = process.env.NB_TEST_HOOKS === "1";

/// The palette's own shape. @nativedesktop/react exports the widget but not
/// this type, so it is declared structurally here.
interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  iconName?: string;
}

const COMMANDS: { id: string; title: string; hint: string; iconName: string }[] = [
  { id: "new-tab", title: "New Tab", hint: "Ctrl+T", iconName: "tab-new-symbolic" },
  { id: "close-tab", title: "Close Tab", hint: "Ctrl+W", iconName: "window-close-symbolic" },
  { id: "reopen-tab", title: "Reopen Closed Tab", hint: "Ctrl+Shift+T", iconName: "edit-undo-symbolic" },
  { id: "reload", title: "Reload", hint: "Ctrl+R", iconName: "view-refresh-symbolic" },
  { id: "find", title: "Find in Page", hint: "Ctrl+F", iconName: "edit-find-symbolic" },
  { id: "downloads", title: "Downloads", hint: "Toolbar", iconName: "folder-download-symbolic" },
  { id: "layout", title: "Switch Layout", hint: "Sidebar or compact", iconName: "sidebar-show-symbolic" },
  { id: "private", title: "New Private Window", hint: "Ctrl+Shift+P", iconName: "view-conceal-symbolic" },
  { id: "settings", title: "Settings", hint: "Ctrl+Comma", iconName: "preferences-system-symbolic" },
  { id: "zoom-in", title: "Zoom In", hint: "Ctrl++", iconName: "zoom-in-symbolic" },
  { id: "zoom-out", title: "Zoom Out", hint: "Ctrl+-", iconName: "zoom-out-symbolic" },
  { id: "zoom-reset", title: "Reset Zoom", hint: "Ctrl+0", iconName: "zoom-original-symbolic" },
  { id: "extensions", title: "Extensions", hint: "chrome://extensions", iconName: "application-x-addon-symbolic" },
  { id: "webstore", title: "Chrome Web Store", hint: "chromewebstore.google.com", iconName: "web-browser-symbolic" },
];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/// Compact tab pills. Every pill expands to an equal share of the row, so
/// these are the floors below which a share cannot shrink: the active tab
/// keeps enough width to read an address in, the rest keep enough for a
/// favicon and a word. The close slot is reserved on every pill whether or not
/// the pointer is on it.
/// The extensions panel. Wide enough for a name beside its pin toggle, and
/// fixed so the panel does not resize as extensions come and go.
const EXTENSIONS_PANEL_WIDTH = 300;

/// The site-info panel, sized for a permission sentence rather than for the
/// shortest thing it ever holds.
const SITE_PANEL_WIDTH = 320;

const PILL_ACTIVE_WIDTH = 260;
const PILL_MIN_WIDTH = 96;
const CLOSE_SLOT_WIDTH = 24;

/// What the padlock says. `none` is not a verdict: it is the new-tab page and
/// anything else that never had a chance to be encrypted, and warning there
/// would spend the indicator's credibility on a non-event.
type Security = "none" | "secure" | "mixed" | "insecure" | "invalid";

const SECURITY_ICON: Record<Security, string> = {
  none: "web-browser-symbolic",
  secure: "channel-secure-symbolic",
  mixed: "dialog-warning-symbolic",
  insecure: "channel-insecure-symbolic",
  invalid: "dialog-warning-symbolic",
};

const SECURITY_TOOLTIP: Record<Security, string> = {
  none: "No page loaded",
  secure: "This page uses a valid certificate",
  mixed: "Parts of this page are not encrypted",
  insecure: "This page is not encrypted",
  invalid: "This site's certificate could not be verified",
};

interface Runtime {
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

const IDLE: Runtime = {
  loading: false,
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  error: null,
  security: "none",
  attempt: 0,
};

interface FindState {
  open: boolean;
  query: string;
  /// GTK reports a real match count; WKFindResult only reports match/no-match,
  /// so `count` is null there and the bar shows found/not found instead. Both
  /// stay null until the engine answers, so the bar never claims a result it
  /// does not have yet.
  count: number | null;
  found: boolean | null;
}

const NO_FIND: FindState = { open: false, query: "", count: null, found: null };

/// `securityChanged` reports TLS facts; the padlock has to say what they mean
/// for THIS address. A page that never had a chance to be encrypted (file://,
/// an extension page, about:) is not "insecure", it is simply not a site.
function securityOf(url: string, data: unknown): Security {
  const state = (data ?? {}) as { secure?: boolean; insecureContent?: boolean; error?: string };
  if (state.error) return "invalid";
  if (state.insecureContent) return "mixed";
  if (state.secure) return "secure";
  return url.startsWith("http://") ? "insecure" : "none";
}

/// A search the engine has answered and answered with nothing. Both halves
/// matter: a query the engine has not reported on yet is not a failure, and
/// an empty query is not a search.
function findFailed(find: FindState): boolean {
  if (!find.query) return false;
  return find.count === 0 || find.found === false;
}

/// One line under a download's name. A transfer in flight and one that failed
/// each say so; a finished one says where it came from, which is the only
/// thing about it still worth knowing.
function downloadStatus(d: DownloadItem): string {
  if (d.state === "running") return "Downloading…";
  if (d.state === "failed") return "Download failed";
  const host = hostOf(d.url);
  return host ? `From ${host}` : "Saved";
}

/// What a tab calls itself wherever it is listed: the title its page reported,
/// the address until it reports one, and "New Tab" until there is an address.
function tabLabel(t: { title: string; url: string }): string {
  return t.title || (t.url ? displayUrl(t.url) : "New Tab");
}

function findSummary(find: FindState): string {
  if (!find.query) return "";
  if (find.count !== null) return find.count === 1 ? "1 match" : `${find.count} matches`;
  if (find.found === null) return "";
  return find.found ? "Found" : "No matches";
}

export interface AppProps {
  initialHistory: Visit[];
  initialWidth: number;
  initialHeight: number;
}

export function App({ initialHistory, initialWidth, initialHeight }: AppProps): React.ReactNode {
  const state = useStoreValue(session);
  const { tabs, activeId } = state;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  // A tab's webview is created with no URL and navigates one render later: a
  // background tab mounted straight into a hidden Activity never attaches its
  // ref, so it "arms" visibly for one frame first (see the arming comment
  // below).
  const [armedTabs, setArmedTabs] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Two halves of one field. `paletteSeed` is the controlled `query` prop and
  // only ever changes when the app deliberately seeds or clears it; echoing
  // keystrokes back into it makes GTK's set_text race the entry and blank it.
  // `paletteQuery` is what the user actually typed, and only feeds ranking.
  const [paletteSeed, setPaletteSeed] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  /// The palette widget's key. `query` is applied only when the value the host
  /// is given changes, and the entry keeps whatever was typed into it after a
  /// close, so re-seeding a string equal to the last one leaves that text in
  /// the field. Bumping the key rebuilds the widget, which is the only way an
  /// unchanged seed can still mean an empty field.
  const [paletteEpoch, setPaletteEpoch] = useState(0);
  const [historyHits, setHistoryHits] = useState<Visit[]>([]);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [history, setHistory] = useState<Visit[]>(initialHistory);
  const [find, setFind] = useState<FindState>(NO_FIND);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /// Compact draws the active tab as an editable address field while this is
  /// set: the pill IS the address bar, so there is no second field to put the
  /// caret in.
  const [editingAddress, setEditingAddress] = useState(false);
  /// The pill the pointer is on, so its close button can appear. One id rather
  /// than a set, because the pointer is in one place.
  const [hoveredTab, setHoveredTab] = useState("");
  /// Permission requests waiting for an answer, oldest first. A request is
  /// per tab and per id: concurrent ones queue, and a background tab's waits
  /// until that tab is active.
  const [prompts, setPrompts] = useState<PermissionPrompt[]>([]);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  /// The queue the handlers act on; `prompts` is its rendered copy.
  const pending = useRef<PermissionPrompt[]>([]);
  /// The two halves of an extension row, each from its own framework call.
  const [registry, setRegistry] = useState<InstalledExtension[]>([]);
  const [extActions, setExtActions] = useState<ExtensionAction[]>([]);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  /// The action whose popup is open, "" for none.
  const [popupId, setPopupId] = useState("");
  const [popupSize, setPopupSize] = useState({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
  const [privateOpen, setPrivateOpen] = useState(false);
  /// Bumped when a favicon lands. The cache lives outside React, so this is
  /// what tells the sidebar to re-read it.
  const [iconEpoch, setIconEpoch] = useState(0);
  const prefs = useStoreValue(settings);

  const closed = useRef<{ url: string; title: string }[]>([]);
  /// Tabs opened during this session, as opposed to restored from the store.
  /// A new background tab loads at once, the way target=_blank behaves in every
  /// browser; a restored one waits until it is looked at.
  const opened = useRef(new Set<string>());
  /// Last URL the engine actually committed per tab, so a download can put the
  /// tab back where it was.
  const committed = useRef(new Map<string, string>());
  const views = useRef(new Map<string, NdNodeRef<"webview"> | null>());
  /// Last context-menu tree sent to each tab's view, so an unchanged one is
  /// never re-sent.
  const sentMenus = useRef(new Map<string, string>());
  const toast = useRef<NdNodeRef<"toastoverlay">>(null);
  /// The find field the app has already put the caret in. An inline ref
  /// callback runs on every render, and focusing on each one would fight the
  /// user for the caret.
  const findFocused = useRef(0);
  /// The compact address field the app has already put the caret in, guarded
  /// the same way and for the same reason as the find field above.
  const addressFocused = useRef(0);
  /// The hidden `chrome://extensions` view. Chromium exposes its extension
  /// registry to that page and nowhere else, so every list and every install
  /// goes through this one rather than through a tab the user can navigate.
  const extRegistry = useRef<NdNodeRef<"webview">>(null);
  const registryArmed = useRef(0);
  /// The open popup's view, and the id of the one whose window.close the app
  /// has already hooked.
  const popupView = useRef<NdNodeRef<"webview"> | null>(null);
  const popupHooked = useRef(0);
  /// Download ids only have to be unique within a run, and a short one keeps
  /// the panel's row testIDs readable.
  const downloadSeq = useRef(0);

  const rt = (id: string): Runtime => runtime[id] ?? IDLE;
  const patch = (id: string, part: Partial<Runtime>): void =>
    setRuntime((r) => ({ ...r, [id]: { ...(r[id] ?? IDLE), ...part } }));
  const view = (id: string): NdNodeRef<"webview"> | null => views.current.get(id) ?? null;

  // A tab navigating or a new search engine both change what a right-click
  // should show, and both land as a render. The push is skipped when the tree
  // is unchanged.
  syncContextMenus();

  function refreshHistory(): void {
    void recentVisits().then(setHistory);
  }

  /// Returns the new tab's id: chrome.tabs.create has to answer with a tab.
  function openTab(url: string, background = false): string {
    let created = "";
    session.update((s) => {
      const id = `t${s.nextTabId}`;
      created = id;
      return {
        ...s,
        tabs: [...s.tabs, { id, url, title: "", pinned: false }],
        activeId: background ? s.activeId : id,
        nextTabId: s.nextTabId + 1,
      };
    });
    opened.current.add(created);
    return created;
  }

  function closeTab(id: string): void {
    setEditingAddress(false);
    denyPromptsFor(id);
    const gone = tabs.find((t) => t.id === id);
    if (gone) closed.current.push({ url: gone.url, title: gone.title });
    views.current.delete(id);
    session.update((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return s;
      const rest = s.tabs.filter((t) => t.id !== id);
      if (rest.length === 0) {
        const fresh = `t${s.nextTabId}`;
        return {
          ...s,
          tabs: [{ id: fresh, url: "", title: "", pinned: false }],
          activeId: fresh,
          nextTabId: s.nextTabId + 1,
        };
      }
      const nextActive = s.activeId === id ? rest[Math.min(index, rest.length - 1)]!.id : s.activeId;
      return { ...s, tabs: rest, activeId: nextActive };
    });
  }

  /// Pinning moves the tab to the end of the pinned block and unpinning moves
  /// it to the head of the rest, which is the same index either way. Keeping
  /// the array in sidebar order is what lets Ctrl+Tab and the Tabs menu walk
  /// the tabs in the order they are drawn.
  function setPinned(id: string, pinned: boolean): void {
    session.update((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.pinned === pinned) return s;
      const rest = s.tabs.filter((t) => t.id !== id);
      const boundary = rest.filter((t) => t.pinned).length;
      return { ...s, tabs: [...rest.slice(0, boundary), { ...tab, pinned }, ...rest.slice(boundary)] };
    });
  }

  function reopenTab(): void {
    const last = closed.current.pop();
    if (last) openTab(last.url);
  }

  function selectTab(id: string): void {
    setEditingAddress(false);
    setSiteInfoOpen(false);
    session.update((s) => (s.activeId === id ? s : { ...s, activeId: id }));
    applyZoom(id, tabs.find((t) => t.id === id)?.url ?? "");
  }

  function cycleTab(step: number): void {
    if (tabs.length < 2) return;
    const at = tabs.findIndex((t) => t.id === active.id);
    const next = tabs[(at + step + tabs.length) % tabs.length]!;
    selectTab(next.id);
  }

  function setTabUrl(id: string, url: string): void {
    session.update((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)) }));
  }

  function navigate(id: string, raw: string): void {
    const target = toUrl(raw);
    if (!target) return;
    patch(id, { error: null });
    // Entering the address you are already on reloads, like every browser. The
    // url prop alone cannot express that: it is unchanged, so nothing commits.
    if (tabs.find((t) => t.id === id)?.url === target) {
      const node = view(id);
      if (node) sendCommand(node, "reload");
      return;
    }
    setTabUrl(id, target);
  }

  function onNavigated(id: string, url: string): void {
    // A page that navigated away is not waiting for its own answer any more,
    // and the id would otherwise stay in the queue for ever.
    denyPromptsFor(id);
    committed.current.set(id, url);
    setTabUrl(id, url);
    applyZoom(id, url);
    void recordVisit(url, "").then(refreshHistory);
  }

  function onTitled(id: string, title: string): void {
    const url = tabs.find((t) => t.id === id)?.url ?? "";
    session.update((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }));
    void recordTitle(url, title).then(refreshHistory);
  }

  function zoomFor(url: string): number {
    return session.get().zoomByHost[hostOf(url)] ?? 1;
  }

  function applyZoom(id: string, url: string): void {
    const node = view(id);
    if (node) sendCommand(node, "setZoom", zoomFor(url));
  }

  function setZoom(next: number): void {
    const host = hostOf(active.url);
    if (!host) return;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
    session.update((s) => ({ ...s, zoomByHost: { ...s.zoomByHost, [host]: clamped } }));
    const node = view(active.id);
    if (node) sendCommand(node, "setZoom", clamped);
  }

  function command(name: "goBack" | "goForward" | "reload" | "stop"): void {
    const node = view(active.id);
    if (node) sendCommand(node, name);
  }

  /// The sidebar pane is the only thing the two layouts disagree about, and it
  /// is a SIBLING of the content pane rather than its ancestor: dropping it
  /// leaves every tab's `<webview>` at the same place in the tree, so the live
  /// pages survive the switch instead of remounting.
  function setLayout(next: Layout): void {
    setEditingAddress(false);
    settings.update((s) => (s.layout === next ? s : { ...s, layout: next }));
  }

  // ---------------------------------------------------------------- find ---

  /// Every find command targets the ACTIVE tab's view: the bar belongs to the
  /// window, and a search running on a hidden tab has nothing to highlight.
  function findCommand(name: "findStart" | "findNext" | "findPrevious" | "findStop", arg?: unknown): void {
    const node = view(active.id);
    if (node) sendCommand(node, name, arg);
  }

  function openFind(): void {
    setFind((f) => ({ ...f, open: true }));
  }

  function closeFind(): void {
    findCommand("findStop");
    setFind(NO_FIND);
    const node = view(active.id);
    if (node) sendCommand(node, "focus");
  }

  function runFind(text: string): void {
    setFind((f) => ({ ...f, open: true, query: text, count: null }));
    if (text) findCommand("findStart", { text });
    else findCommand("findStop");
  }

  // ---------------------------------------------------- permissions ---

  /// The queue is a ref with the state mirroring it, because the two exits
  /// from it can happen in one turn: answering the prompt on show closes the
  /// popover, and the close handler must then find the queue already short of
  /// it rather than answer the same id twice.
  function setQueue(next: PermissionPrompt[]): void {
    pending.current = next;
    setPrompts(next);
  }

  function respond(tabId: string, id: string, allow: boolean): void {
    const node = view(tabId);
    if (node) sendCommand(node, "respondPermission", { id, allow });
    if (TEST_HOOKS) console.error(`ND_APP PERMISSION id=${id} allow=${allow}`);
  }

  function answerPrompt(prompt: PermissionPrompt, allow: boolean): void {
    respond(prompt.tabId, prompt.id, allow);
    setQueue(pending.current.filter((p) => p.id !== prompt.id));
  }

  /// Everything that takes a prompt away without the user choosing: escape, a
  /// click outside the popover, the tab navigating, the tab closing. Block is
  /// the safe answer and nothing is remembered, which is what Chrome does with
  /// a dismissed bubble. An id left unanswered would leave the page waiting
  /// for ever.
  function denyPromptsFor(tabId: string): void {
    const doomed = pending.current.filter((p) => p.tabId === tabId);
    if (doomed.length === 0) return;
    for (const prompt of doomed) respond(tabId, prompt.id, false);
    setQueue(pending.current.filter((p) => p.tabId !== tabId));
  }

  function onPermissionRequest(tabId: string, data: unknown): void {
    const request = (data ?? {}) as { id?: string; origin?: string; types?: string };
    if (!request.id) return;
    const types = splitTypes(request.types ?? "");
    const origin = request.origin ?? "";
    const decided = rememberedDecision(prefs.sitePermissions, origin, types);
    if (decided) {
      respond(tabId, request.id, decided === "allow");
      return;
    }
    setQueue([...pending.current, { id: request.id, tabId, origin, types }]);
    // The bubble opens itself for the tab being looked at, the way Chrome's
    // does; a background tab's request waits for the tab.
    if (tabId === active.id) setSiteInfoOpen(true);
  }

  /// Allow and Block are the only answers that are remembered, and answering
  /// puts the bubble away the way Chrome's does.
  function decidePrompt(prompt: PermissionPrompt, decision: PermissionDecision): void {
    if (prompt.origin) {
      settings.update((s) => ({
        ...s,
        sitePermissions: rememberDecision(s.sitePermissions, prompt.origin, prompt.types, decision),
      }));
    }
    answerPrompt(prompt, decision === "allow");
    setSiteInfoOpen(false);
  }

  function resetSiteDecisions(origin: string): void {
    settings.update((s) => ({ ...s, sitePermissions: forgetOrigin(s.sitePermissions, origin) }));
  }

  // ------------------------------------------------------ extensions ---

  /// Both halves of the list, from the one view Chromium answers on. Called
  /// where the registry can have changed: at first attach, when the panel is
  /// opened, after the app's own install, and on `chromeDialog`, which is what
  /// a Web Store install and Chrome's own "Remove …?" confirmation arrive as.
  /// There is no push event for the registry, so those are the triggers.
  function refreshExtensions(): void {
    const node = extRegistry.current;
    if (!node) return;
    void listExtensions(node).then(setRegistry).catch(() => {});
    void listExtensionActions(node).then(setExtActions).catch(() => {});
  }

  function openExtensionsList(): void {
    refreshExtensions();
    setExtensionsOpen(true);
  }

  function pinExtension(id: string): void {
    settings.update((s) => ({ ...s, pinnedExtensions: togglePinned(s.pinnedExtensions, id) }));
  }

  /// A second click on the action that is already open closes it, which is
  /// what Chrome's own toolbar button does.
  function openExtensionPopup(id: string): void {
    setExtensionsOpen(false);
    if (popupId === id) {
      setPopupId("");
      return;
    }
    setPopupSize({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
    setPopupId(id);
  }

  function closeExtensionPopup(): void {
    setPopupId("");
  }

  /// What the button says it will do. An extension with no popup cannot be
  /// triggered at all here: there is no Chromium toolbar button for
  /// `chrome.action.onClicked` to fire on.
  function popupTooltip(row: ExtensionRow): string {
    if (!row.enabled) return `${row.name} is turned off`;
    return row.popupUrl ? row.name : `${row.name} has no popup`;
  }

  /// A popup page is not sized by its document here and does not close on blur,
  /// so the app owns both: one eval after the load reads the size Chrome would
  /// have used and routes the page's own window.close back through the script
  /// channel registered on the view.
  function fitPopup(node: NdNodeRef<"webview">, attempt = 0): void {
    void executeJavaScript(
      node,
      // The BODY's own box, not the root's scroll extent: the root fills
      // whatever view it is in, so measuring it would only ever report the
      // size the app already chose. A popup that declares no size of its own
      // reports the view's width and its content height, which is what Chrome
      // lays one out at too.
      `(() => {
         window.close = () => window.webkit.messageHandlers.ndPopup.postMessage(1);
         const b = document.body;
         if (!b) return JSON.stringify([0, 0]);
         const r = b.getBoundingClientRect();
         const s = getComputedStyle(b);
         const mx = parseFloat(s.marginLeft) + parseFloat(s.marginRight);
         const my = parseFloat(s.marginTop) + parseFloat(s.marginBottom);
         return JSON.stringify([Math.ceil(r.width + mx), Math.ceil(r.height + my)]);
       })()`,
    )
      .then((size) => {
        if (TEST_HOOKS) console.error(`ND_APP POPUPFIT attempt=${attempt} size=${JSON.stringify(size)}`);
        const parsed = typeof size === "string" ? (JSON.parse(size) as number[]) : ((size ?? []) as unknown as number[]);
        const [w, h] = parsed;
        // A view created at a chrome-extension:// URL answers before its
        // document exists, and there is no event that says "laid out". The
        // retry is what turns the default size into the measured one.
        if (!(Number(w) >= POPUP_MIN) && attempt < 6) {
          setTimeout(() => fitPopup(node, attempt + 1), 400);
          return;
        }
        setPopupSize(clampPopup(Number(w), Number(h)));
      })
      .catch((e: unknown) => {
        if (TEST_HOOKS) console.error(`ND_APP POPUPFIT attempt=${attempt} failed=${String(e)}`);
        if (attempt < 6) setTimeout(() => fitPopup(node, attempt + 1), 400);
      });
  }

  function extensionPopup(row: ExtensionRow): React.ReactNode {
    return (
      <box
        testID={`ext-popup-body-${row.id}`}
        orientation="vertical"
        style={{ minWidth: popupSize.width, minHeight: popupSize.height }}
      >
        {/* Created AT the extension URL, never navigated to it: Chromium
            refuses a renderer-initiated navigation to a chrome-extension://
            page, so the key remounts the view when another action is opened. */}
        <webview
          key={row.popupUrl}
          ref={(node) => {
            popupView.current = node as NdNodeRef<"webview"> | null;
            if (!node || popupHooked.current === node.id) return;
            popupHooked.current = node.id;
            sendCommand(node as NdNodeRef<"webview">, "registerScriptMessage", { name: "ndPopup" });
            fitPopup(node as NdNodeRef<"webview">);
          }}
          url={row.popupUrl}
          testID={`ext-popup-view-${row.id}`}
          style={{ hexpand: true, vexpand: true }}
          onLoadingChanged={(e) => {
            if (e.checked || !popupView.current) return;
            fitPopup(popupView.current);
          }}
          onJavaScriptResult={onJavaScriptResult}
          onScriptMessage={(e) => {
            const message = e.data as { name?: string };
            if (message.name === "ndPopup") closeExtensionPopup();
          }}
        />
      </box>
    );
  }

  /// Test-only: `launchApp` passes no argv, so a drive cannot hand the host a
  /// `--load-extension`, and the Web Store needs the network. The app's own
  /// install API is the one route left.
  function installTestExtension(): void {
    const node = extRegistry.current;
    const dir = process.env.NB_TEST_EXT;
    if (!node || !dir) return;
    void installExtension(node, dir)
      .then(() => refreshExtensions())
      .catch(() => {});
  }

  // ------------------------------------------------------- context menu ---

  /// The engine draws the menu: Back/Forward/Reload, Open Link and Copy Image
  /// are its own and always there. These are the things a browser has to add
  /// on top, because they act on the browser rather than on the page: a tab,
  /// this app's downloads and the search engine the user picked. Inspect is
  /// Chromium's own item, which opens the docked inspector on the element.
  function appContextMenuItems(): ContextMenuItem[] {
    return [
      { id: "nb-open-link", label: "Open Link in New Tab", contexts: ["link"] },
      { id: "nb-save-image", label: "Save Image", contexts: ["image"] },
      { id: "nb-search-selection", label: `Search with ${engineOf(prefs.searchEngine).name}`, contexts: ["selection"] },
    ];
  }

  /// Pushes each tab's menu to its own view. Sent only when the tree actually
  /// changes, which is what makes calling it per render safe.
  function syncContextMenus(only?: string): void {
    for (const tab of tabs) {
      if (only !== undefined && tab.id !== only) continue;
      const node = views.current.get(tab.id);
      if (!node) continue;
      const items = appContextMenuItems();
      const shape = JSON.stringify(items);
      // Keyed on the widget as well as the tree: a remounted view (Try Again
      // bumps the webview's key) starts with no items of its own.
      const stamp = `${node.id}|${shape}`;
      if (sentMenus.current.get(tab.id) === stamp) continue;
      sentMenus.current.set(tab.id, stamp);
      setContextMenuItems(node, items);
      if (TEST_HOOKS) console.error(`ND_APP CTXMENU tab=${tab.id} ${shape}`);
    }
  }

  /// An item the user chose in a page's context menu: one of the three above.
  function onContextMenuItem(tabId: string, click: ContextMenuItemClick): void {
    switch (click.id) {
      case "nb-open-link":
        if (click.linkUrl) openTab(click.linkUrl, true);
        return;
      case "nb-save-image":
        if (click.imageUrl) startDownload(click.imageUrl);
        return;
      case "nb-search-selection":
        if (click.selectionText) openTab(toUrl(click.selectionText) ?? "", true);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ favicon ---

  function onFavicon(tabUrl: string, data: { dataUrl?: string; iconUrl?: string }): void {
    if (data.dataUrl) {
      if (rememberFavicon(tabUrl, data.dataUrl)) setIconEpoch((n) => n + 1);
      return;
    }
    // macOS reports the icon's ADDRESS rather than its bytes, so it has to be
    // fetched before it can go in a row.
    if (data.iconUrl) {
      void fetchFavicon(tabUrl, data.iconUrl).then((changed) => {
        if (changed) setIconEpoch((n) => n + 1);
      });
    }
  }

  function startDownload(url: string, suggested?: string): void {
    // A download is not a navigation: whichever tab aimed at this URL goes back
    // to the page it was showing, so the restored session never points at it.
    session.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.url === url ? { ...t, url: committed.current.get(t.id) ?? "" } : t)),
    }));

    const id = `d${downloadSeq.current++}`;
    const guess = suggested || fileNameFromUrl(url);
    setDownloads((d) => [{ id, name: guess, url, path: "", state: "running" }, ...d]);
    setDownloadsOpen(true);
    runDownload(url, suggested).then(
      (done) => {
        setDownloads((d) => d.map((x) => (x.id === id ? { ...x, ...done, state: "done" as const } : x)));
        if (toast.current) void showToast(toast.current, { title: `Saved ${done.name}` });
      },
      () => {
        setDownloads((d) => d.map((x) => (x.id === id ? { ...x, state: "failed" as const } : x)));
        if (toast.current) void showToast(toast.current, { title: `Unable to download ${guess}` });
      },
    );
  }

  function openPalette(seed: string): void {
    // Ctrl+T seeds "" over a seed that is already "": nothing changes, nothing
    // is sent, and the entry still holds the address the last tab was sent to.
    if (seed === paletteSeed) setPaletteEpoch((n) => n + 1);
    setPaletteSeed(seed);
    setPaletteQuery(seed);
    void searchHistory(seed).then(setHistoryHits);
    setPaletteOpen(true);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteSeed("");
    setPaletteQuery("");
  }

  /// New tab is Arc-shaped: the empty tab appears and the palette opens over it,
  /// so one keystroke gets you from "new tab" to "typing an address".
  function newTab(): void {
    openTab("");
    // Compact has no palette to open over the page: its own pill becomes the
    // field, which is where a new tab starts in Safari.
    if (compact) setEditingAddress(true);
    else openPalette("");
  }

  /// What Ctrl+L, the padlock and the new tab page all mean by "let me type an
  /// address", which is a different widget in each layout.
  function openAddress(): void {
    if (compact) setEditingAddress(true);
    else openPalette(active.url);
  }

  function commitQuery(raw: string): void {
    setEditingAddress(false);
    closePalette();
    navigate(active.id, raw);
  }

  function runPaletteItem(id: string): void {
    closePalette();
    if (id === "url") return commitQuery(paletteQuery);
    if (id.startsWith("tab:")) return selectTab(id.slice(4));
    if (id.startsWith("hist:")) return navigate(active.id, id.slice(5));
    switch (id.slice(4)) {
      case "new-tab":
        return newTab();
      case "close-tab":
        return closeTab(active.id);
      case "reopen-tab":
        return reopenTab();
      case "reload":
        return command("reload");
      case "find":
        return openFind();
      case "downloads":
        return setDownloadsOpen(true);
      case "layout":
        return setLayout(prefs.layout === "sidebar" ? "compact" : "sidebar");
      case "private":
        return setPrivateOpen(true);
      case "settings":
        return setSettingsOpen(true);
      case "zoom-in":
        return setZoom(zoomFor(active.url) + 0.1);
      case "zoom-out":
        return setZoom(zoomFor(active.url) - 0.1);
      case "zoom-reset":
        return setZoom(1);
      case "extensions":
        openTab("chrome://extensions");
        return;
      case "webstore":
        openTab("https://chromewebstore.google.com");
        return;
    }
  }

  const activeRt = rt(active.id);
  const compact = prefs.layout === "compact";
  const recentDownloads = downloads.slice(0, DOWNLOADS_SHOWN);
  const shownUrl = displayUrl(active.url);
  const pageTitle = tabLabel(active);
  const activeOrigin = originOf(active.url);
  /// Only the active tab's prompt is on show; the rest of the queue waits.
  const activePrompt = prompts.find((p) => p.tabId === active.id) ?? null;
  const siteDecisions = decisionsFor(prefs.sitePermissions, activeOrigin);
  const rows = extensionRows(registry, extActions);
  const pinnedActions = pinnedRows(rows, prefs.pinnedExtensions);
  /// An action opened from the panel rather than from a button of its own has
  /// nowhere to hang, so its popup rides the puzzle piece.
  const openAction = rows.find((r) => r.id === popupId) ?? null;
  const unpinnedPopup = openAction && !prefs.pinnedExtensions.includes(openAction.id) ? openAction : null;

  void iconEpoch;
  // One line per tab: favicon and title, nothing else. A second line of host
  // costs a third of the column's height and repeats what the address bar
  // already says about the tab you are looking at.
  function tabNode(t: (typeof tabs)[number]): SourceTreeNode {
    return {
      id: t.id,
      title: tabLabel(t),
      // The site's own icon when it has been seen, the generic page glyph
      // until then. iconData wins over iconName when both are set.
      iconData: faviconFor(t.url),
      iconName: "web-browser-symbolic",
      // Pin rides the selected row only. Every action a row declares reserves
      // its width whether or not it is being hovered, and a second one on a
      // 190pt column costs a third of the title; the Tabs menu covers pinning
      // from the keyboard.
      actionIds: t.id === active.id ? [t.pinned ? "unpin" : "pin", "close"] : ["close"],
      testID: `tab-${t.id}`,
    };
  }

  // Headings only once a tab is pinned: an unpinned window is a plain column of
  // tabs, and a lone "Tabs" heading over it would be labelling the obvious.
  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);
  const nodes: SourceTreeNode[] = [];
  if (pinned.length > 0) {
    nodes.push({ id: "section-pinned", title: "Pinned", section: true });
    for (const t of pinned) nodes.push(tabNode(t));
    if (loose.length > 0) nodes.push({ id: "section-tabs", title: "Tabs", section: true });
  }
  for (const t of loose) nodes.push(tabNode(t));

  // Ranking is entirely the app's job: <commandpalette> renders what it is
  // given, in order. Address first (that is what a browser bar is for), then
  // open tabs, then history, then app commands.
  const query = paletteQuery.trim();
  const lowered = query.toLowerCase();
  const paletteItems: PaletteItem[] = [];
  if (query) {
    const target = toUrl(query);
    if (target) {
      const searching = isSearch(target);
      const engine = SEARCH_ENGINES.find((e) => e.id === prefs.searchEngine)?.name ?? "the web";
      paletteItems.push({
        id: "url",
        title: searching ? `Search ${engine} for ${query}` : `Go to ${query}`,
        subtitle: searching ? undefined : hostOf(target) || target,
        iconName: searching ? "system-search-symbolic" : "web-browser-symbolic",
      });
    }
  }
  for (const t of tabs) {
    if (t.id === active.id) continue;
    const label = t.title || displayUrl(t.url) || "New Tab";
    if (lowered && !`${label} ${t.url}`.toLowerCase().includes(lowered)) continue;
    paletteItems.push({
      id: `tab:${t.id}`,
      title: `Switch to ${label}`,
      subtitle: displayUrl(t.url) || undefined,
      iconName: "web-browser-symbolic",
    });
  }
  for (const v of historyHits) {
    if (v.url === active.url) continue;
    paletteItems.push({
      id: `hist:${v.url}`,
      title: v.title || displayUrl(v.url),
      subtitle: displayUrl(v.url),
      iconName: "document-open-recent-symbolic",
    });
  }
  for (const c of COMMANDS) {
    if (lowered && !c.title.toLowerCase().includes(lowered)) continue;
    paletteItems.push({ id: `cmd:${c.id}`, title: c.title, subtitle: c.hint, iconName: c.iconName });
  }

  return (
    <>
    <window
      title={pageTitle}
      testID="main-window"
      defaultWidth={initialWidth}
      defaultHeight={initialHeight}
      onSizeChanged={(e) => {
        const { width, height } = e.data as { width: number; height: number };
        session.update((s) => ({ ...s, windowWidth: width, windowHeight: height }));
      }}
    >
      <menubar defaults>
        <menu label="File" testID="menu-file">
          <menuitem testID="menu-new-tab" label="New Tab" accelerator="primary+t" onSelect={newTab} />
          <menuitem
            testID="menu-private-window"
            label="New Private Window"
            accelerator="primary+shift+p"
            onSelect={() => setPrivateOpen(true)}
          />
          <menuitem
            testID="menu-address"
            label="Open Address Bar"
            accelerator="primary+l"
            onSelect={openAddress}
          />
          <menuitem testID="menu-close-tab" label="Close Tab" accelerator="primary+w" onSelect={() => closeTab(active.id)} />
          <menuitem
            testID="menu-reopen-tab"
            label="Reopen Closed Tab"
            accelerator="primary+shift+t"
            onSelect={reopenTab}
          />
          <menuitem role="separator" testID="menu-file-sep" />
          <menuitem
            testID="menu-settings"
            label="Settings"
            accelerator="primary+comma"
            onSelect={() => setSettingsOpen(true)}
          />
        </menu>
        <menu label="Edit" testID="menu-edit">
          <menuitem testID="menu-find" label="Find in Page" accelerator="primary+f" onSelect={openFind} />
          <menuitem testID="menu-find-next" label="Find Next" accelerator="primary+g" onSelect={() => findCommand("findNext")} />
          <menuitem
            testID="menu-find-previous"
            label="Find Previous"
            accelerator="primary+shift+g"
            onSelect={() => findCommand("findPrevious")}
          />
        </menu>
        <menu label="View" testID="menu-view">
          <menuitem testID="menu-reload" label="Reload" accelerator="primary+r" onSelect={() => command("reload")} />
          <menuitem
            testID="menu-layout"
            label={prefs.layout === "sidebar" ? "Use Compact Layout" : "Use Sidebar Layout"}
            accelerator="primary+shift+s"
            onSelect={() => setLayout(prefs.layout === "sidebar" ? "compact" : "sidebar")}
          />
          <menuitem testID="menu-downloads" label="Downloads" onSelect={() => setDownloadsOpen(true)} />
          <menuitem role="separator" testID="menu-view-sep" />
          <menuitem
            testID="menu-zoom-in"
            label="Zoom In"
            accelerator="primary+plus"
            onSelect={() => setZoom(zoomFor(active.url) + 0.1)}
          />
          <menuitem
            testID="menu-zoom-out"
            label="Zoom Out"
            accelerator="primary+minus"
            onSelect={() => setZoom(zoomFor(active.url) - 0.1)}
          />
          <menuitem testID="menu-zoom-reset" label="Reset Zoom" accelerator="primary+0" onSelect={() => setZoom(1)} />
        </menu>
        <menu label="Tabs" testID="menu-tabs">
          <menuitem testID="menu-next-tab" label="Next Tab" accelerator="primary+tab" onSelect={() => cycleTab(1)} />
          <menuitem
            testID="menu-prev-tab"
            label="Previous Tab"
            accelerator="primary+shift+tab"
            onSelect={() => cycleTab(-1)}
          />
          <menuitem
            testID="menu-pin-tab"
            label={active.pinned ? "Unpin Tab" : "Pin Tab"}
            onSelect={() => setPinned(active.id, !active.pinned)}
          />
          <menuitem role="separator" testID="menu-tabs-sep" />
          {tabs.map((t, i) => (
            <menuitem
              key={t.id}
              testID={`menu-tab-${i}`}
              label={tabLabel(t)}
              onSelect={() => selectTab(t.id)}
            />
          ))}
        </menu>
        <menu label="Go" testID="menu-go">
          <menuitem
            testID="menu-back"
            label="Back"
            enabled={activeRt.canGoBack}
            onSelect={() => command("goBack")}
          />
          <menuitem
            testID="menu-forward"
            label="Forward"
            enabled={activeRt.canGoForward}
            onSelect={() => command("goForward")}
          />
        </menu>
        {/* Test-only: page content is unreachable from GTK automation (no
            pointer/key synthesis), so the acceptance drive needs one way to
            run a snippet inside the active page. Gated on NB_TEST_HOOKS, so
            it never exists in a normal run. */}
        {TEST_HOOKS && (
          <menu label="Debug" testID="menu-debug">
            <menuitem
              testID="menu-run-test-js"
              label="Run test script"
              onSelect={() => {
                const node = view(active.id);
                const code = process.env.NB_TEST_JS;
                if (node && code) void executeJavaScript(node, code).catch(() => {});
              }}
            />
            {/* The menu itself belongs to the engine now, and no automation can
                open one: GTK4 synthesises no pointer input, and the engine's
                own context menu never fires headlessly. These feed the app's
                own handler the payload a real click would carry, which is the
                half the app owns. What the menu CONTAINS is asserted from the
                ND_APP CTXMENU trace instead. */}
            <menuitem
              testID="menu-ctx-open-link"
              label="Context: open link in new tab"
              onSelect={() =>
                onContextMenuItem(active.id, {
                  id: "nb-open-link",
                  pageUrl: active.url,
                  linkUrl: `${active.url || "https://example.com/"}#link`,
                  editable: false,
                })
              }
            />
            <menuitem
              testID="menu-ctx-save-image"
              label="Context: save image"
              onSelect={() =>
                onContextMenuItem(active.id, {
                  id: "nb-save-image",
                  pageUrl: active.url,
                  imageUrl: process.env.NB_TEST_IMAGE || `${active.url || "https://example.com/"}#image`,
                  editable: false,
                })
              }
            />
            <menuitem
              testID="menu-ctx-search-selection"
              label="Context: search the selection"
              onSelect={() =>
                onContextMenuItem(active.id, {
                  id: "nb-search-selection",
                  pageUrl: active.url,
                  selectionText: "selected words",
                  editable: false,
                })
              }
            />
          </menu>
        )}
        <menu label="Extensions" testID="menu-extensions">
          <menuitem
            testID="menu-extensions-page"
            label="Extensions"
            onSelect={() => openTab("chrome://extensions")}
          />
          <menuitem testID="menu-webstore" label="Chrome Web Store" onSelect={() => openTab("https://chromewebstore.google.com")} />
        </menu>
        <menu label="History" testID="menu-history">
          {history.length === 0 ? (
            <menuitem testID="menu-history-empty" label="No History Yet" enabled={false} />
          ) : (
            history.map((v, i) => (
              <menuitem
                key={v.url}
                testID={`menu-history-${i}`}
                label={v.title || displayUrl(v.url)}
                onSelect={() => openTab(v.url)}
              />
            ))
          )}
        </menu>
      </menubar>

      <toastoverlay ref={toast} onToastButtonClicked={onToastButtonClicked} onToastDismissed={onToastDismissed}>
        <splitview sidebarWidth={0.24} testID="split">
          {/* Compact drops the sidebar child on both backends. The content
              pane stays this splitview's second child either way, so no
              `<webview>` moves and no page reloads. */}
          {!compact && (
            <toolbarview slot="sidebar" testID="sidebar-toolbar">
              <headerbar testID="sidebar-header" title="NativeBrowser" />
              {/* No horizontal padding: a source-list row insets its own
                  content, so every point the container takes comes straight
                  off the tab title. */}
              <box
                testID="sidebar"
                orientation="vertical"
                spacing={Spacing.xs}
                style={{ vexpand: true, padding: { top: Spacing.sm, bottom: Spacing.sm } }}
              >
                {/* Full-width and left-aligned, so it reads as the first row of
                    the column rather than a button parked above it. The box
                    around it carries the row inset the button itself cannot:
                    `padding` on a button only inflates its intrinsic size. */}
                <box orientation="horizontal" style={{ hexpand: true, padding: { left: Spacing.md } }}>
                  <button
                    testID="new-tab"
                    label="New Tab"
                    iconName="tab-new-symbolic"
                    labelAlign="start"
                    cssClasses={["flat"]}
                    style={{ hexpand: true }}
                    onClick={newTab}
                  />
                </box>
                <sourcetree
                  testID="tab-list"
                  nodes={nodes}
                  actions={TAB_ACTIONS}
                  selectedId={active.id}
                  // A flat list has no levels, and the reserved indent is what
                  // pushed the tab rows out of line with the New Tab row.
                  indentationPerLevel={0}
                  style={{ vexpand: true }}
                  onSelectionChanged={(e) => {
                    const { nodeId } = e.data as { nodeId: string | null };
                    if (nodeId && tabs.some((t) => t.id === nodeId)) selectTab(nodeId);
                  }}
                  onMiddleClick={(e) => {
                    const { nodeId } = e.data as { nodeId: string | null };
                    if (nodeId && tabs.some((t) => t.id === nodeId)) closeTab(nodeId);
                  }}
                  onActionClicked={(e) => {
                    const { nodeId, actionId } = e.data as { nodeId: string; actionId: string };
                    if (actionId === "close") closeTab(nodeId);
                    if (actionId === "pin") setPinned(nodeId, true);
                    if (actionId === "unpin") setPinned(nodeId, false);
                  }}
                />
              </box>
            </toolbarview>
          )}

          <toolbarview slot="content" testID="content-toolbar">
            <headerbar
              testID="chrome"
              title=""
              canGoBack={activeRt.canGoBack}
              canGoForward={activeRt.canGoForward}
              onBack={() => command("goBack")}
              onForward={() => command("goForward")}
            >
              {/* One icon for both directions: Adwaita's sidebar-hide glyph has
                  no SF Symbol behind it, so the state rides the tooltip. */}
              <button
                slot="start"
                testID="layout-toggle"
                iconName="sidebar-show-symbolic"
                tooltip={prefs.layout === "sidebar" ? "Use Compact Layout" : "Use Sidebar Layout"}
                cssClasses={["flat"]}
                onClick={() => setLayout(prefs.layout === "sidebar" ? "compact" : "sidebar")}
              />
              <button
                slot="start"
                testID="reload"
                iconName={activeRt.loading ? "process-stop-symbolic" : "view-refresh-symbolic"}
                tooltip={activeRt.loading ? "Stop" : "Reload"}
                cssClasses={["flat"]}
                onClick={() => command(activeRt.loading ? "stop" : "reload")}
              />
              {/* One indicator, updated in place. The state rides the testID
                  because getTree exposes a node's text but never its icon
                  name, so that is the only way a drive can assert which
                  padlock is drawn; it must NOT ride a `key`, which remounts
                  the button and left AppKit with one toolbar item per state
                  the page had ever been in. */}
              {/* The padlock is Chrome's site-info button: what this page is
                  allowed to do hangs off it, and so does a permission the page
                  is asking for right now. Boxed because a popover anchors on
                  its tree parent and a header bar's handle is not one. */}
              <box slot="start" testID="site-info-anchor" orientation="horizontal">
                <button
                  testID={`security-${activeRt.security}`}
                  iconName={SECURITY_ICON[activeRt.security]}
                  tooltip={SECURITY_TOOLTIP[activeRt.security]}
                  cssClasses={["flat"]}
                  onClick={() => setSiteInfoOpen(!siteInfoOpen)}
                />
                <popover
                  testID="site-info-popover"
                  open={siteInfoOpen}
                  position="bottom"
                  onClosed={() => {
                    setSiteInfoOpen(false);
                    // Escape and a click outside are a dismissal, and a
                    // dismissed request is denied rather than left pending.
                    denyPromptsFor(active.id);
                  }}
                >
                  <box
                    testID="site-info-panel"
                    orientation="vertical"
                    spacing={Spacing.sm}
                    style={{ padding: Spacing.sm, minWidth: SITE_PANEL_WIDTH }}
                  >
                    <label
                      testID="site-info-host"
                      text={hostOf(active.url) || "New Tab"}
                      cssClasses={["heading"]}
                      style={{ halign: "start" }}
                    />
                    <label
                      testID="site-info-security"
                      text={SECURITY_TOOLTIP[activeRt.security]}
                      cssClasses={["dimmed", "caption"]}
                      ellipsize
                      style={{ halign: "start" }}
                    />
                    {activePrompt ? (
                      <box orientation="vertical" spacing={Spacing.sm}>
                        <label
                          testID="permission-request"
                          text={permissionSentence(hostOf(active.url) || activePrompt.origin, activePrompt.types)}
                          style={{ halign: "start" }}
                        />
                        <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
                          <button
                            testID="permission-block"
                            label="Block"
                            onClick={() => decidePrompt(activePrompt, "block")}
                          />
                          <button
                            testID="permission-allow"
                            label="Allow"
                            cssClasses={["suggested-action"]}
                            onClick={() => decidePrompt(activePrompt, "allow")}
                          />
                        </box>
                      </box>
                    ) : siteDecisions.length === 0 ? (
                      <label
                        testID="site-permissions-empty"
                        text="This site has not asked for anything yet."
                        cssClasses={["dimmed"]}
                        style={{ halign: "start" }}
                      />
                    ) : (
                      <box orientation="vertical" spacing={Spacing.xs}>
                        {siteDecisions.map((row) => (
                          <box key={row.type} orientation="horizontal" spacing={Spacing.sm}>
                            <label
                              testID={`site-permission-${row.type}`}
                              text={`${permissionName(row.type)}: ${row.decision === "allow" ? "Allowed" : "Blocked"}`}
                              ellipsize
                              style={{ halign: "start", hexpand: true }}
                            />
                          </box>
                        ))}
                        <button
                          testID="site-permissions-reset"
                          label="Reset Permissions"
                          cssClasses={["flat"]}
                          onClick={() => resetSiteDecisions(activeOrigin)}
                        />
                      </box>
                    )}
                  </box>
                </popover>
              </box>
              {/* One address widget on both backends. The private window
                  proved a `<searchinput>` takes the header bar's whole free
                  run on GTK too (523px of a 778px bar), so the main window no
                  longer draws its address as a flat label. Typing and Enter
                  commit straight from the field; Ctrl+L still opens the
                  palette, which is where history and command ranking live.

                  The padlock stays a separate button to its left: the widget
                  has no leading-icon prop on either backend, so putting the
                  security state inside the field would need a framework arm
                  (LEDGER). */}
              {!compact && (
                <searchinput
                  slot="start"
                  testID="omnibox"
                  text={shownUrl}
                  placeholder="Search or Enter Address"
                  style={{ hexpand: true }}
                  onActivate={(e) => commitQuery(e.text)}
                />
              )}

              {/* Compact is Safari's: one toolbar row, and the tabs in it ARE
                  the address bar. Every pill takes an equal share of what is
                  left after the buttons, the active one carries more of it,
                  and clicking the active pill (or Ctrl+L) swaps it for the
                  field. Nothing is drawn below this row. */}
              {compact && (
                <box
                  slot="start"
                  testID="tab-strip"
                  orientation="horizontal"
                  spacing={Spacing.xs}
                  style={{ hexpand: true }}
                >
                  {tabs.map((t) =>
                    t.id === active.id && editingAddress ? (
                      <searchinput
                        key={t.id}
                        ref={(node) => {
                          if (!node) {
                            addressFocused.current = 0;
                            return;
                          }
                          if (addressFocused.current === node.id) return;
                          addressFocused.current = node.id;
                          sendCommand(node as NdNodeRef<"searchinput">, "focus");
                        }}
                        testID="omnibox"
                        text={shownUrl}
                        placeholder="Search or Enter Address"
                        style={{ hexpand: true, minWidth: PILL_ACTIVE_WIDTH }}
                        onActivate={(e) => commitQuery(e.text)}
                      />
                    ) : (
                      <box
                        key={t.id}
                        testID={`tab-slot-${t.id}`}
                        orientation="horizontal"
                        style={{ hexpand: true }}
                        onHoverChanged={(e) => setHoveredTab(e.checked ? t.id : "")}
                      >
                        <button
                          testID={`tab-pill-${t.id}`}
                          label={tabLabel(t)}
                          iconData={faviconFor(t.url)}
                          iconName="web-browser-symbolic"
                          ellipsize
                          tooltip={displayUrl(t.url) || "New Tab"}
                          cssClasses={t.id === active.id ? ["pill", "raised"] : ["pill", "flat"]}
                          style={{
                            hexpand: true,
                            minWidth: t.id === active.id ? PILL_ACTIVE_WIDTH : PILL_MIN_WIDTH,
                          }}
                          onClick={() => (t.id === active.id ? setEditingAddress(true) : selectTab(t.id))}
                        />
                        {/* The close button appears under the pointer, as it
                            does in Safari. The slot it takes is reserved
                            either way, so the row does not resize as the
                            pointer crosses it. */}
                        {hoveredTab === t.id ? (
                          <button
                            testID={`tab-close-${t.id}`}
                            iconName="window-close-symbolic"
                            tooltip={`Close ${tabLabel(t)}`}
                            cssClasses={["flat", "circular"]}
                            size="small"
                            style={{ minWidth: CLOSE_SLOT_WIDTH, valign: "center" }}
                            onClick={() => closeTab(t.id)}
                          />
                        ) : (
                          <box orientation="horizontal" style={{ minWidth: CLOSE_SLOT_WIDTH }} />
                        )}
                      </box>
                    ),
                  )}
                </box>
              )}
              {compact && (
                <button
                  slot="end"
                  testID="header-new-tab"
                  iconName="tab-new-symbolic"
                  tooltip="New Tab"
                  cssClasses={["flat"]}
                  onClick={newTab}
                />
              )}

              {/* Chrome's extensions area: the pinned actions, then the puzzle
                  piece that lists everything installed. Each pinned action is
                  boxed with its own popover so the popup opens under the button
                  that was clicked; an unpinned one opens under the puzzle. */}
              {pinnedActions.map((row) => (
                <box slot="end" key={row.id} testID={`ext-pin-${row.id}`} orientation="horizontal">
                  <button
                    testID={`ext-action-${row.id}`}
                    iconData={row.iconData || undefined}
                    iconName="application-x-addon-symbolic"
                    tooltip={popupTooltip(row)}
                    cssClasses={["flat"]}
                    enabled={row.enabled && row.popupUrl !== ""}
                    onClick={() => openExtensionPopup(row.id)}
                  />
                  <popover
                    testID={`ext-popup-${row.id}`}
                    open={popupId === row.id}
                    position="bottom"
                    onClosed={closeExtensionPopup}
                  >
                    {popupId === row.id ? extensionPopup(row) : <box orientation="horizontal" />}
                  </popover>
                </box>
              ))}
              <box slot="end" testID="extensions-anchor" orientation="horizontal">
                <button
                  testID="extensions-button"
                  iconName="application-x-addon-symbolic"
                  tooltip="Extensions"
                  cssClasses={["flat"]}
                  onClick={() => (extensionsOpen ? setExtensionsOpen(false) : openExtensionsList())}
                />
                <popover
                  testID="extensions-popover"
                  open={extensionsOpen}
                  position="bottom"
                  onClosed={() => setExtensionsOpen(false)}
                >
                  <box
                    testID="extensions-panel"
                    orientation="vertical"
                    spacing={Spacing.sm}
                    style={{ padding: Spacing.sm, minWidth: EXTENSIONS_PANEL_WIDTH }}
                  >
                    <label text="Extensions" cssClasses={["heading"]} style={{ halign: "start" }} />
                    {rows.length === 0 ? (
                      <label
                        testID="extensions-empty"
                        text="Extensions you install appear here."
                        cssClasses={["dimmed"]}
                        style={{ halign: "start" }}
                      />
                    ) : (
                      rows.map((row) => (
                        <box key={row.id} orientation="horizontal" spacing={Spacing.sm}>
                          {/* The name IS the button: a row-wide target is
                              what a pointer aims at, and the icon rides it
                              rather than sitting beside it as decoration. */}
                          <button
                            testID={`ext-row-${row.id}`}
                            label={row.name}
                            iconData={row.iconData || undefined}
                            iconName="application-x-addon-symbolic"
                            labelAlign="start"
                            ellipsize
                            tooltip={popupTooltip(row)}
                            cssClasses={["flat"]}
                            enabled={row.enabled && row.popupUrl !== ""}
                            style={{ hexpand: true }}
                            onClick={() => openExtensionPopup(row.id)}
                          />
                          <togglebutton
                            testID={`ext-pin-toggle-${row.id}`}
                            iconName="view-pin-symbolic"
                            tooltip={prefs.pinnedExtensions.includes(row.id) ? "Unpin from toolbar" : "Pin to toolbar"}
                            active={prefs.pinnedExtensions.includes(row.id)}
                            cssClasses={["flat"]}
                            style={{ valign: "center" }}
                            onToggled={() => pinExtension(row.id)}
                          />
                        </box>
                      ))
                    )}
                    <button
                      testID="extensions-manage"
                      label="Manage Extensions"
                      cssClasses={["flat"]}
                      onClick={() => {
                        setExtensionsOpen(false);
                        openTab("chrome://extensions");
                      }}
                    />
                    {/* Test-only: the drive has no other way in. `nd dev` and
                        a packaged run both take extensions from the Web Store
                        or the command line, and launchApp passes no argv. */}
                    {TEST_HOOKS && (
                      <button
                        testID="extensions-install-test"
                        label="Install the test extension"
                        cssClasses={["flat"]}
                        onClick={installTestExtension}
                      />
                    )}
                  </box>
                </popover>
                {/* An unpinned action has no button of its own, so its popup
                    hangs off the puzzle piece it was opened from. */}
              <popover
                testID="ext-popup-unpinned"
                open={unpinnedPopup !== null}
                position="bottom"
                onClosed={closeExtensionPopup}
              >
                {unpinnedPopup ? extensionPopup(unpinnedPopup) : <box orientation="horizontal" />}
              </popover>
              </box>

              {/* A popover anchors on its TREE parent on both backends, and a
                  header bar's own handle never joins a view hierarchy, so the
                  button it hangs off has to be boxed. */}
              <box slot="end" testID="downloads-anchor" orientation="horizontal">
                <button
                  testID="downloads-button"
                  iconName="folder-download-symbolic"
                  tooltip="Downloads"
                  cssClasses={["flat"]}
                  onClick={() => setDownloadsOpen(!downloadsOpen)}
                />
                <popover
                  testID="downloads-popover"
                  open={downloadsOpen}
                  position="bottom"
                  onClosed={() => setDownloadsOpen(false)}
                >
                  {/* Stacked boxes rather than a list widget: a popover sizes
                      itself from what it contains, and every list widget here
                      is a scroll view, which contributes no height at all. */}
                  <box
                    testID="downloads-panel"
                    orientation="vertical"
                    spacing={Spacing.sm}
                    style={{ padding: Spacing.sm }}
                  >
                    <label text="Downloads" cssClasses={["heading"]} style={{ halign: "start" }} />
                    {recentDownloads.length === 0 ? (
                      <label
                        testID="downloads-empty"
                        text="Files you download appear here."
                        cssClasses={["dimmed"]}
                        style={{ halign: "start" }}
                      />
                    ) : (
                      recentDownloads.map((d) => (
                        <box key={d.id} orientation="horizontal" spacing={Spacing.sm}>
                          <image
                            iconName={d.state === "failed" ? "dialog-warning-symbolic" : "folder-download-symbolic"}
                            symbolScale="small"
                            cssClasses={d.state === "failed" ? ["error"] : ["dimmed"]}
                          />
                          <box orientation="vertical" style={{ hexpand: true }}>
                            <label
                              testID={`downloads-item-${d.id}`}
                              text={d.name}
                              ellipsize
                              style={{ halign: "start" }}
                            />
                            <label
                              testID={`downloads-status-${d.id}`}
                              text={downloadStatus(d)}
                              cssClasses={["dimmed", "caption"]}
                              style={{ halign: "start" }}
                            />
                          </box>
                          {/* Only once the transfer has produced a file. */}
                          {d.state === "done" && (
                            <button
                              testID={`downloads-reveal-${d.id}`}
                              iconName="folder-symbolic"
                              tooltip="Show in Folder"
                              cssClasses={["flat"]}
                              style={{ halign: "end", valign: "center" }}
                              onClick={() => void revealPath(d.path).catch(() => {})}
                            />
                          )}
                        </box>
                      ))
                    )}
                    <button
                      testID="downloads-folder"
                      label="Open Downloads Folder"
                      cssClasses={["flat"]}
                      onClick={() => void openPath(downloadDir()).catch(() => {})}
                    />
                  </box>
                </popover>
              </box>
            </headerbar>

            <box testID="content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
              {/* Presents over the active window wherever it is mounted. */}
              <commandpalette
                key={paletteEpoch}
                testID="palette"
                open={paletteOpen}
                placeholder="Search or enter address"
                query={paletteSeed}
                items={paletteItems}
                onQueryChanged={(e) => {
                  setPaletteQuery(e.text);
                  void searchHistory(e.text).then(setHistoryHits);
                }}
                onActivate={(e) => runPaletteItem(e.text)}
                onSubmit={(e) => commitQuery(e.text)}
                onCancel={closePalette}
              />

              {/* The load bar floats over the page instead of taking a row of
                  layout: mounting it must not resize the webview. First child
                  of the overlay is the content; the bar is a floating layer
                  pinned to the top edge. */}
              <overlay testID="page-stack" style={{ hexpand: true, vexpand: true }}>
                <box orientation="vertical" style={{ hexpand: true, vexpand: true }}>
                  {tabs
                    .filter((t) => t.url !== "")
                    .map((t) => {
                      const state = rt(t.id);
                      const shown = t.id === active.id && state.error === null;
                      // React never attaches refs inside a subtree that mounts
                      // straight into a hidden Activity, and without the ref a tab's
                      // content scripts are never registered and its URL is never
                      // set. A tab opened in this session therefore stays "visible"
                      // for the one frame it takes to arm — it has no URL yet, so
                      // the frame is blank. A RESTORED tab is left alone until it is
                      // selected, which is the lazy session restore every browser
                      // does anyway.
                      const arming = !armedTabs[t.id] && opened.current.has(t.id);
                      return (
                        <Activity key={t.id} mode={shown || arming ? "visible" : "hidden"}>
                          <webview
                            key={state.attempt}
                            ref={(node) => {
                              views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                              if (!node) return;
                              // The view exists now, so its menu can be pushed; the
                              // render-time sync could only skip it.
                              syncContextMenus(t.id);
                              setArmedTabs((a) => (a[t.id] ? a : { ...a, [t.id]: true }));
                            }}
                            url={armedTabs[t.id] ? t.url : ""}
                            testID={`page-${t.id}`}
                            style={{ hexpand: true, vexpand: true }}
                            onNavigate={(e) => onNavigated(t.id, e.text)}
                            onTitleChanged={(e) => onTitled(t.id, e.text)}
                            onLoadingChanged={(e) => patch(t.id, { loading: e.checked })}
                            onLoadProgress={(e) => patch(t.id, { progress: e.value })}
                            onBackAvailable={(e) => patch(t.id, { canGoBack: e.checked })}
                            onForwardAvailable={(e) => patch(t.id, { canGoForward: e.checked })}
                            onLoadFailed={(e) => patch(t.id, { error: e.data as { url: string; error: string } })}
                            onNewWindow={(e) => openTab(e.text, true)}
                            onJavaScriptResult={onJavaScriptResult}
                            onChromeDialog={() => refreshExtensions()}
                            onPermissionRequest={(e) => onPermissionRequest(t.id, e.data)}
                            onFaviconChanged={(e) => onFavicon(t.url, e.data as { dataUrl?: string; iconUrl?: string })}
                            onSecurityChanged={(e) => patch(t.id, { security: securityOf(t.url, e.data) })}
                            onFindResult={(e) => {
                              // Two events per search on GTK: `done` carries the
                              // outcome, `done: false` carries the total from the
                              // separate counting pass, which AppKit never sends.
                              const r = e.data as { matchFound: boolean; matchCount?: number; done: boolean };
                              setFind((f) =>
                                r.done ? { ...f, found: r.matchFound } : { ...f, count: r.matchCount ?? null },
                              );
                            }}
                            onContextMenuItemClicked={(e) => onContextMenuItem(t.id, e.data as ContextMenuItemClick)}
                            onDownloadRequested={(e) => {
                              const d = e.data as { url: string; suggestedFilename?: string };
                              startDownload(d.url, d.suggestedFilename);
                            }}
                          />
                        </Activity>
                      );
                    })}

                  {activeRt.error !== null && (
                    <statuspage
                      testID="error-page"
                      iconName="network-error-symbolic"
                      title="Unable to load this page"
                      description={`${displayUrl(activeRt.error.url)} — ${activeRt.error.error}`}
                      style={{ vexpand: true }}
                    >
                      <button
                        testID="retry"
                        label="Try Again"
                        cssClasses={["suggested-action", "pill"]}
                        onClick={() => patch(active.id, { error: null, attempt: activeRt.attempt + 1 })}
                      />
                    </statuspage>
                  )}

                  {active.url === "" && (
                    <statuspage
                      testID="new-tab-page"
                      iconName="web-browser-symbolic"
                      title="New Tab"
                      description="Search the web, or open a page you have visited before."
                      style={{ vexpand: true }}
                    >
                      <button
                        testID="new-tab-search"
                        label="Search or Enter Address"
                        cssClasses={["suggested-action", "pill"]}
                        onClick={openAddress}
                      />
                    </statuspage>
                  )}
                </box>

                {activeRt.loading && (
                  <progressbar
                    testID="progress"
                    fraction={activeRt.progress}
                    cssClasses={["osd"]}
                    style={{ valign: "start", hexpand: true }}
                  />
                )}

                {/* Chromium answers listExtensions and listExtensionActions on
                    a view showing chrome://extensions and nowhere else, so the
                    toolbar keeps one of its own. It is a floating layer of the
                    overlay rather than a row, so it takes no layout, and it is
                    where the app's own installs go too. */}
                <box
                  testID="extensions-registry"
                  orientation="horizontal"
                  style={{ halign: "start", valign: "end", minWidth: 1, minHeight: 1 }}
                >
                  <webview
                    ref={(node) => {
                      // Guarded by widget id and never reset: an inline ref
                      // callback runs on every render, and a refresh that
                      // re-renders would arm itself again for ever.
                      const view = node as NdNodeRef<"webview"> | null;
                      extRegistry.current = view;
                      if (!view || registryArmed.current === view.id) return;
                      registryArmed.current = view.id;
                      refreshExtensions();
                    }}
                    url="chrome://extensions"
                    testID="extensions-registry-view"
                    style={{ minWidth: 1, minHeight: 1 }}
                    onExtensionsList={onExtensionsList}
                    onExtensionActions={onExtensionActions}
                    onChromeDialog={() => refreshExtensions()}
                  />
                </box>

                {/* Chrome's find bar: it floats over the top right of the page
                    rather than taking a row of layout, so opening it never
                    moves the page. A GTK widget laid over the webview cannot
                    be seen on Linux, because the Chrome-style engine lives in
                    an X11 child window of the toplevel and X composites a
                    child above everything its parent draws. A popover has a
                    surface of its own, which is the route the page's own
                    context menu already takes. The anchor draws nothing; it
                    exists to put the popover's corner where Chrome's is. */}
                <box
                  testID="find-anchor"
                  orientation="horizontal"
                  style={{
                    halign: "end",
                    valign: "start",
                    minWidth: FIND_BAR_WIDTH,
                    minHeight: 1,
                    margin: { top: Spacing.sm, right: Spacing.md },
                  }}
                >
                  {find.open && (
                    <popover testID="find-popover" open position="bottom" onClosed={closeFind}>
                      <box
                        testID="find-bar"
                        orientation="horizontal"
                        spacing={Spacing.sm}
                        style={{ padding: Spacing.sm, minWidth: FIND_BAR_WIDTH }}
                      >
                        {/* Adwaita's `.error` on the entry is what a search that
                            found nothing looks like in GNOME; the count label alone
                            leaves the field claiming everything is fine. Empty
                            rather than absent, so the class comes back off. */}
                        <searchinput
                          ref={(node) => {
                            if (!node) {
                              findFocused.current = 0;
                              return;
                            }
                            if (findFocused.current === node.id) return;
                            findFocused.current = node.id;
                            sendCommand(node as NdNodeRef<"searchinput">, "focus");
                          }}
                          testID="find-query"
                          placeholder="Find in Page"
                          cssClasses={findFailed(find) ? ["error"] : []}
                          style={{ hexpand: true }}
                          onChanged={(e) => runFind(e.text)}
                          onActivate={() => findCommand("findNext")}
                        />
                        <label
                          key={`${find.query}:${find.count}:${find.found}`}
                          testID="find-count"
                          text={findSummary(find)}
                          cssClasses={["dimmed", "numeric"]}
                        />
                        <button
                          testID="find-previous"
                          iconName="go-up-symbolic"
                          tooltip="Previous match"
                          cssClasses={["flat"]}
                          onClick={() => findCommand("findPrevious")}
                        />
                        <button
                          testID="find-next"
                          iconName="go-down-symbolic"
                          tooltip="Next match"
                          cssClasses={["flat"]}
                          onClick={() => findCommand("findNext")}
                        />
                        {/* Escape closes the popover, which is what fires
                            onClosed; the button is the same exit for a
                            pointer. */}
                        <button
                          testID="find-close"
                          iconName="window-close-symbolic"
                          tooltip="Close"
                          cssClasses={["flat"]}
                          onClick={closeFind}
                        />
                      </box>
                    </popover>
                  )}
                </box>
              </overlay>

            </box>
          </toolbarview>
        </splitview>
      </toastoverlay>
    </window>

    {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
    {privateOpen && (
      <PrivateWindow
        onClose={() => setPrivateOpen(false)}
        onSettings={() => setSettingsOpen(true)}
        onDownloads={() => setDownloadsOpen(true)}
        onDownload={startDownload}
      />
    )}
    </>
  );
}

/// Settings. A handful of preferences, native rows, written straight through
/// the store: there is no Apply button because there is nothing to apply.
/// Grouped the way the window is used: how it looks, what it searches, what it
/// opens with, and where files land.
function SettingsWindow({ onClose }: { onClose: () => void }): React.ReactNode {
  const prefs = useStoreValue(settings);
  const engineIndex = Math.max(0, SEARCH_ENGINES.findIndex((e) => e.id === prefs.searchEngine));
  const layoutIndex = Math.max(0, LAYOUTS.findIndex((l) => l.id === prefs.layout));

  return (
    <window title="Settings" testID="settings-window" defaultWidth={560} defaultHeight={620} onClosed={onClose}>
      <toolbarview testID="settings-toolbar">
        <headerbar testID="settings-header" title="Settings" />
        <scrollview testID="settings-scroll" style={{ hexpand: true, vexpand: true }}>
          <clamp maximumSize={640}>
            <box orientation="vertical" spacing={Spacing.lg} style={{ padding: Spacing.lg, hexpand: true }}>
              <settingsgroup testID="settings-appearance" title="Appearance">
                <row
                  testID="settings-layout-row"
                  title="Layout"
                  subtitle="Sidebar keeps a tab column; compact puts everything in the toolbar"
                >
                  <segmentedcontrol
                    slot="suffix"
                    testID="settings-layout"
                    options={LAYOUTS.map((l) => l.name)}
                    selectedIndex={layoutIndex}
                    onSelectionChanged={(e) => {
                      const layout = LAYOUTS[e.index]?.id ?? "sidebar";
                      settings.update((s) => ({ ...s, layout }));
                    }}
                  />
                </row>
              </settingsgroup>

              <settingsgroup testID="settings-search" title="Search">
                <row testID="settings-engine-row" title="Search Engine" subtitle="Used when what you type is not an address">
                  <select
                    slot="suffix"
                    testID="settings-engine"
                    options={SEARCH_ENGINES.map((e) => e.name)}
                    selectedIndex={engineIndex}
                    onSelectionChanged={(e) => {
                      const engine = SEARCH_ENGINES[e.index]?.id ?? "duckduckgo";
                      settings.update((s) => ({ ...s, searchEngine: engine }));
                    }}
                  />
                </row>
              </settingsgroup>

              <settingsgroup testID="settings-startup" title="Startup">
                <row testID="settings-homepage-row" title="Homepage" subtitle="Opened by new windows. Leave empty for the new tab page.">
                  <textinput
                    slot="suffix"
                    testID="settings-homepage"
                    placeholder="example.com"
                    text={prefs.homepage}
                    onChanged={(e) => settings.update((s) => ({ ...s, homepage: e.text }))}
                  />
                </row>
                <switchrow
                  testID="settings-restore"
                  title="Reopen Tabs on Launch"
                  subtitle="Start with the tabs you had open last time"
                  checked={prefs.restoreOnLaunch}
                  onToggled={(e) => settings.update((s) => ({ ...s, restoreOnLaunch: e.checked }))}
                />
              </settingsgroup>

              {/* Read-only: the folder is the OS download folder, or whatever
                  NB_DOWNLOAD_DIR names for a drive run. The row exists so the
                  answer to "where did that go" is in the app. */}
              <settingsgroup testID="settings-downloads" title="Downloads">
                <row testID="settings-download-dir-row" title="Save Files To" subtitle={downloadDir()}>
                  <button
                    slot="suffix"
                    testID="settings-download-dir"
                    label="Open Folder"
                    cssClasses={["flat"]}
                    style={{ halign: "end" }}
                    onClick={() => void openPath(downloadDir()).catch(() => {})}
                  />
                </row>
              </settingsgroup>
            </box>
          </clamp>
        </scrollview>
      </toolbarview>
    </window>
  );
}
