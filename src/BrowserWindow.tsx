// One normal browser window: its toolbar, its tab list and the slot its tabs'
// pages are shown in. The pages themselves are not children of this tree: the
// app root keeps every tab's `<webview>` in the framework's off-window pool and
// moves the live widget into whichever window's slot shows it, which is what
// lets a tab change windows without its page reloading. Everything keyed by
// tab lives at the root for the same reason; what lives here is the state of
// this window's own chrome (palette, popovers, the popup an action opened).
import {
  Activity,
  Platform,
  Spacing,
  clipboard,
  executeJavaScript,
  onAlertResult,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  sendCommand,
  showAlert,
  showToast,
  useStoreValue,
} from "@nativedesktop/react";
import type {
  ContextMenuItemClick,
  ExtensionActionState,
  JSX,
  MenuEntry,
  NdNodeRef,
} from "@nativedesktop/react";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onSettled } from "solid-js";

import { INSET, Sidebar } from "./Sidebar.tsx";
import { CompactTabs, LAYOUT_BUTTON_WIDTH, tabRunMetrics } from "./CompactTabs.tsx";
import { ZoomFootControl, createZoomPopover } from "./ZoomControl.tsx";
import { PopupBlockedControl } from "./PopupBlocked.tsx";
import { stepZoom, zoomPercent } from "./lib/zoom.ts";
import { DownloadRow, type DownloadActions } from "./Downloads.tsx";
import { addBookmark, bookmarks, isBookmarked, removeBookmark } from "./lib/bookmarks.ts";
import { downloads } from "./lib/downloads.ts";
import { trackStore } from "./lib/live.ts";
import { BookmarksPanel, DownloadsPanel, HistoryPanel, type Panel } from "./Panels.tsx";
import {
  badgeVariant,
  clampPopup,
  POPUP_DEFAULT_HEIGHT,
  POPUP_DEFAULT_WIDTH,
  POPUP_MIN,
  type ExtensionRow,
} from "./lib/extensions.ts";
import { completionCandidates, searchHistory, type Visit } from "./lib/history.ts";
import { FIND_BAR_WIDTH } from "./lib/metrics.ts";
import {
  decisionsFor,
  originOf,
  permissionName,
  permissionSentence,
  type PermissionDecision,
  type PermissionPrompt,
} from "./lib/permissions.ts";
import type { SessionState, SessionTab, SessionWindow } from "./lib/session.ts";
import { KEYS, tabKey } from "./lib/keys.ts";
import { blockedSentence, commandTitle, omniRows, shortcutLabel, type OmniMode, type OmniTarget } from "./lib/omnibox.ts";
import { SEARCH_ENGINES, engineOf, type Layout, type SettingsState } from "./lib/settings.ts";
import { parseTabPayload, tabPayload } from "./lib/tabdrag.ts";
import {
  SECURITY_ICON,
  SECURITY_TOOLTIP,
  findFailed,
  findSummary,
  tabHover,
  tabLabel,
  type FindState,
  type Runtime,
} from "./lib/tabstate.ts";
import { displayUrl, hostOf, toUrl, fieldAddress } from "./lib/url.ts";

/// Most recent downloads the toolbar popover lists. Older ones are still on
/// disk; the panel is a receipt for what just happened, not a file manager.
const DOWNLOADS_SHOWN = 6;

export const TEST_HOOKS = process.env.NB_TEST_HOOKS === "1";

/// Characters of the address the sidebar's address button shows.
const SIDEBAR_ADDRESS_CHARS = 40;

type Blocking = ReturnType<BrowserContext["blockingFor"]>;

/// Blocking is read per tab and rebuilt on every switch; tabs on one site
/// read the same.
function sameBlocking(a: Blocking, b: Blocking): boolean {
  return a.site === b.site && a.on === b.on && a.hidden === b.hidden && a.blocked === b.blocked;
}

function capLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/// The extensions panel. Wide enough for a name beside its pin toggle, and
/// fixed so the panel does not resize as extensions come and go.
const EXTENSIONS_PANEL_WIDTH = 300;

/// The site-info panel, sized for a permission sentence rather than for the
/// shortest thing it ever holds.
const SITE_PANEL_WIDTH = 320;
/// The downloads popover's width. Its file names ellipsize, and on GTK an
/// ellipsizing label asks for no width of its own, so this floor is what a
/// name gets: room for the 44 characters shortName leaves, beside a row's
/// progress and two buttons.
const DOWNLOADS_PANEL_WIDTH = 440;

/// What the root asks of a window's own chrome. The menu bar belongs to one
/// window and acts on whichever window is focused, so it reaches the others'
/// palette and popovers through these.
export interface WindowController {
  /// Opens the command bar holding `seed`. `target` is where Enter sends an
  /// address: "new-tab" for ⌘T, "current" (the default) otherwise.
  openPalette(seed: string, target?: OmniTarget): void;
  /// ⌘L: the command bar seeded with the showing tab's address.
  openAddress(): void;
  /// ⌘K: the command bar as a tab switcher and command list.
  openSwitcher(): void;
  /// Test-only: what Esc in the command bar does.
  closePalette(): void;
  openDownloads(): void;
  /// Opens a panel, or puts it away when it is the one already open: the
  /// keystroke that brings a panel up also dismisses it.
  togglePanel(panel: Panel): void;
  openPanel(panel: Panel): void;
  /// Bookmark This Page, or let the page go when it is already kept.
  bookmarkPage(): void;
  openSiteInfo(): void;
  /// Arc's Cmd+S, for the sidebar layout.
  toggleSidebar(): void;
  /// Test-only: what the pointer at the leading edge does, for a backend with
  /// no pointer synthesis.
  revealSidebar(show: boolean): void;
  /// The auto-hidden window-control strip, for drives without a real pointer.
  revealStrip(show: boolean): void;
  showPopup(id: string, url: string): void;
  toast(title: string): void;
  /// Asks, in this window's own dialog, whether to add a Web Store
  /// extension. `lines` are what it can do, in Chrome's words.
  confirmInstall(name: string, lines: string[]): Promise<boolean>;
}

/// A window a tab can be sent to. "private" is the private window.
export interface MoveTarget {
  id: string;
  label: string;
}

/// Everything a window reads from or asks of the app root.
export interface BrowserContext {
  session: SessionState;
  prefs: SettingsState;
  chromium: boolean;
  history: Visit[];
  downloadActions: DownloadActions;
  clearHistory(): Promise<void>;
  prompts: PermissionPrompt[];
  rows: ExtensionRow[];
  pinnedActions: ExtensionRow[];
  checkingAction: string;
  privateOpen: boolean;
  focusedWindowId: string;
  /// Where a dragged tab would land: this window's row and the index in it.
  dropHint: { windowId: string; index: number } | null;
  /// A site's favicon, read again whenever a new one lands.
  iconFor(url: string): string | undefined;
  /// The registry and action views. They need a realized window to exist in,
  /// and the first one hosts them.
  hiddenViews(): JSX.Element;

  rt(tabId: string): Runtime;
  findFor(tabId: string): FindState;
  actionStates: Record<string, ExtensionActionState>;
  actionDefaults: Record<string, ExtensionActionState>;
  moveTargets(fromWindowId: string): MoveTarget[];

  openTab(windowId: string, url: string, background?: boolean): string;
  closeTab(id: string): void;
  selectTab(id: string): void;
  setPinned(id: string, pinned: boolean): void;
  canSleep(id: string): boolean;
  sleepTab(id: string): void;
  /// Put to sleep and not shown since.
  asleep(id: string): boolean;
  closeOtherTabs(id: string): void;
  resetPinned(id: string): void;
  reopenTab(windowId: string): void;
  cycleTab(windowId: string, step: number): void;
  navigate(tabId: string, raw: string): void;
  retry(tabId: string): void;
  command(tabId: string, name: "goBack" | "goForward" | "reload" | "stop"): void;
  toggleReader(tabId: string): void;
  toggleFloat(tabId: string): void;
  /// The built-in blocker on a tab's site.
  blockingFor(tabId: string): { site: string; on: boolean; hidden: number; blocked: number };
  toggleBlocking(tabId: string): void;
  /// ⇧⌘H: the element picker on the tab's page, or away again.
  toggleHiding(tabId: string): void;
  restoreHidden(tabId: string): void;
  updateLists(): void;
  zoomFor(url: string): number;
  setZoom(tabId: string, next: number): void;
  /// One preset step in, out, or (0) back to 100%, with the popover shown.
  zoomStep(tabId: string, direction: 1 | -1 | 0): void;
  setLayout(next: Layout): void;

  openFind(tabId: string): void;
  closeFind(tabId: string): void;
  runFind(tabId: string, text: string): void;
  findCommand(tabId: string, name: "findStart" | "findNext" | "findPrevious" | "findStop", arg?: unknown): void;

  decidePrompt(prompt: PermissionPrompt, decision: PermissionDecision): void;
  denyPromptsFor(tabId: string): void;
  resetSiteDecisions(origin: string): void;
  /// A pop-up the engine blocked, opened as a tab after all.
  openBlockedPopup(tabId: string, url: string): void;
  /// Always allow pop-ups from the tab's site.
  allowSitePopups(tabId: string): void;

  refreshExtensions(): void;
  pinExtension(id: string): void;
  clickAction(windowId: string, row: ExtensionRow): void;
  installTestExtension(dir: string | undefined): void;
  uninstallExtension(id: string): void;

  newWindow(): void;
  openPrivate(): void;
  openSettings(): void;
  moveTab(tabId: string, toWindowId: string, index: number): void;
  moveTabBy(tabId: string, step: number): void;
  moveTabTo(tabId: string, target: string): void;
  onTabDropped(windowId: string, payload: string, index: number): void;
  setDropHint(windowId: string, index: number): void;
  onDragStart(payload: string): void;
  onDragEnd(): void;

  onWindowFocused(windowId: string, focused: boolean): void;
  onWindowClosed(windowId: string): void;
  onWindowSize(windowId: string, width: number, height: number): void;
  registerSlot(windowId: string, node: NdNodeRef<"box"> | null): void;
  registerController(windowId: string, controller: WindowController): void;
  controllerFor(windowId: string): WindowController | undefined;

  runTestJs(tabId: string): void;
  onContextMenuItem(tabId: string, click: ContextMenuItemClick): void;
}

export interface BrowserWindowProps {
  win: SessionWindow;
  /// The first window hosts the menu bar and the hidden views.
  first: boolean;
  ctx: BrowserContext;
}

export function BrowserWindow(props: BrowserWindowProps) {
  const ctx = props.ctx;
  const prefs = ctx.prefs;
  const chromium = (): boolean => ctx.chromium;
  const winId = props.win.id;
  const tabs = (): SessionTab[] => props.win.tabs;
  const active = createMemo((): SessionTab => tabs().find((t) => t.id === props.win.activeId) ?? tabs()[0] ?? NO_TAB);
  /// TestIDs of the first window keep their plain names; every other window's
  /// are prefixed with its id, so a drive can tell them apart.
  const p = (): string => (props.first ? "" : `${winId}-`);

  const [paletteOpen, setPaletteOpen] = createSignal(false);
  // Two halves of one field. `paletteSeed` is the controlled `query` prop and
  // only ever changes when the app deliberately seeds or clears it; echoing
  // keystrokes back into it makes GTK's set_text race the entry and blank it.
  // `paletteQuery` is what the user actually typed, and only feeds ranking.
  const [paletteSeed, setPaletteSeed] = createSignal("");
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteTarget, setPaletteTarget] = createSignal<OmniTarget>("current");
  const [historyHits, setHistoryHits] = createSignal<Visit[]>([]);
  /// The latest history lookup the bar asked for; older answers are dropped.
  let hitsAsked = 0;
  const [completions, setCompletions] = createSignal<string[]>([]);
  const [paletteMode, setPaletteMode] = createSignal<OmniMode>("address");
  /// Tab ids of this window, most recently shown first, so the switcher lists
  /// the page you just left at the top.
  let recent: string[] = [];
  createEffect(
    () => active().id,
    (id) => {
      if (recent[0] === id) return;
      recent = [id, ...recent.filter((x) => x !== id && tabs().some((t) => t.id === x))];
    },
  );
  const [downloadsOpen, setDownloadsOpen] = createSignal(false);
  const [panel, setPanel] = createSignal<Panel | null>(null);
  // The Bookmark This Page item reads the store while rendering.
  const bookmarkState = useStoreValue(bookmarks);
  const kept = (url: string): boolean => {
    bookmarkState();
    return isBookmarked(url);
  };
  const downloadState = trackStore(downloads);
  const [siteInfoOpen, setSiteInfoOpen] = createSignal(false);
  const [extensionsOpen, setExtensionsOpen] = createSignal(false);
  let windowRef: NdNodeRef<"window"> | undefined;
  /// The action whose popup is open, "" for none, and the address it was
  /// mounted at: the one Chromium reported at the click, which an extension
  /// can change at runtime away from the manifest's.
  const [popupId, setPopupId] = createSignal("");
  const [popupUrl, setPopupUrl] = createSignal("");
  const [popupSize, setPopupSize] = createSignal({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
  /// Arc's Cmd+S: the column is hidden and the page takes the window, and the
  /// pointer at the leading edge brings the column back over it while it is.
  const [sidebarHidden, setSidebarHidden] = createSignal(false);
  /// Whether that hidden column is showing over the page right now.
  const [revealed, setRevealed] = createSignal(false);
  /// Whether the desktop's decoration layout puts window buttons on the
  /// trailing side (GTK); they then get the strip over the page.
  const [trailingControls, setTrailingControls] = createSignal(false);
  /// The same for the leading side, which the sidebar places. With neither
  /// (a tiling compositor) there is no frame to draw: the page runs to the
  /// window's edges.
  const [leadingControls, setLeadingControls] = createSignal(false);

  let toast: NdNodeRef<"toastoverlay"> | undefined;
  let split: NdNodeRef<"splitview"> | undefined;
  let contentBars: NdNodeRef<"toolbarview"> | undefined;
  let slot: NdNodeRef<"box"> | undefined;

  const activeRt = (): Runtime => ctx.rt(active().id);
  const activeBlocking = createMemo(() => ctx.blockingFor(active().id), { equals: sameBlocking });
  const find = (): FindState => ctx.findFor(active().id);
  const compact = (): boolean => prefs.layout === "compact";
  const gtk = Platform.backend === "gtk";
  const zoomFactor = (): number => ctx.zoomFor(active().url);
  const zoomPopover = createZoomPopover(
    () => `${prefs.layout}/${active().id}`,
    zoomFactor,
    () => activeRt().zoomNotice,
    () => {
      // The sidebar's foot is out of sight with the sidebar hidden, so the new
      // value is said in a toast instead.
      if (!compact() && sidebarHidden() && toast) void showToast(toast, { title: `Zoom ${zoomPercent(zoomFactor())}` });
    },
  );

  // The slot is shown to the root once its widget exists, and taken back
  // when the window goes.
  onSettled(() => {
    if (slot) ctx.registerSlot(winId, slot);
    return () => ctx.registerSlot(winId, null);
  });

  ctx.registerController(winId, {
    openPalette,
    openAddress,
    openSwitcher,
    closePalette,
    // A download starting while the Downloads panel is up is already in view.
    openDownloads: () => {
      if (panel() !== "downloads") openPanel("downloads");
    },
    openPanel: (next) => {
      openPanel(null);
      setPanel(next);
    },
    bookmarkPage: () => toggleBookmark(active()),
    togglePanel: (next) => {
      openPanel(null);
      setPanel((cur) => (cur === next ? null : next));
    },
    toggleSidebar: () => void setSidebarHidden((h) => !h),
    revealSidebar: (show) => {
      if (split) sendCommand(split, show ? "revealSidebar" : "concealSidebar");
    },
    revealStrip: (show) => {
      if (contentBars) sendCommand(contentBars, show ? "revealTopBars" : "concealTopBars");
    },
    openSiteInfo: () => openPanel("siteInfo"),
    showPopup: (id, url) => {
      openPanel("popup");
      setPopupSize({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
      setPopupUrl(url);
      setPopupId(id);
    },
    toast: (title) => {
      if (toast) void showToast(toast, { title });
    },
    confirmInstall: (name, lines) => {
      const node = windowRef;
      if (!node) return Promise.resolve(false);
      return showAlert(node, {
        title: name ? `Add “${name}”?` : "Add this extension?",
        body: lines.length > 0 ? `It can:\n${lines.map((l) => `• ${l}`).join("\n")}` : undefined,
        // The first button is the leftmost on GTK and the rightmost on
        // AppKit, and each platform puts the action on the right.
        buttons: gtk
          ? [
              { id: "cancel", label: "Cancel" },
              { id: "add", label: "Add extension", style: "suggested" },
            ]
          : [
              { id: "add", label: "Add extension", style: "suggested" },
              { id: "cancel", label: "Cancel" },
            ],
        defaultId: "add",
        closeId: "cancel",
      })
        .then((answer) => answer.buttonId === "add")
        .catch(() => false);
    },
  });

  /// The one way into the command bar. Each open starts from `seed`: the
  /// widget presents with its last `query` prop, never with what was typed
  /// into an earlier open. A blank tab has nothing to keep, so an address
  /// typed while it shows loads there even from ⌘T.
  function openPalette(seed: string, target: OmniTarget = "current"): void {
    present("address", seed, target);
  }

  /// ⌘K: which open page, or what to do. Only what is open is listed, and
  /// every command, so no action needs a button.
  function openSwitcher(): void {
    present("switcher", "", "current");
  }

  function present(mode: OmniMode, seed: string, target: OmniTarget): void {
    setPaletteMode(mode);
    setPaletteSeed(seed);
    setPaletteQuery(seed);
    setPaletteTarget(target);
    refreshHits(seed === active().url ? "" : seed);
    if (paletteOpen()) {
      // Already open: an unchanged seed is no prop change, so the field would
      // keep what was typed. Closing and presenting again starts it from the
      // seed, and it is still one bar, never a second.
      setPaletteOpen(false);
      setTimeout(() => setPaletteOpen(true), 0);
    } else {
      setPaletteOpen(true);
    }
    if (TEST_HOOKS) console.error(`ND_APP PALETTE open mode=${mode} target=${target} seed=${JSON.stringify(seed)}`);
  }

  function refreshHits(text: string): void {
    // Typing runs one query per key; an answer for an older text that lands
    // late must not replace a newer one.
    const ask = ++hitsAsked;
    void searchHistory(text).then((hits) => {
      if (ask === hitsAsked) setHistoryHits(hits);
    });
    void completionCandidates(text).then((urls) => {
      if (ask === hitsAsked) setCompletions(urls);
    });
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteSeed("");
    setPaletteQuery("");
  }

  /// ⌘L, and a click on the tab already on show in either layout: the command
  /// bar holding the address, all of it selected, so typing replaces it.
  function openAddress(): void {
    // A second ⌘L puts the bar away again.
    if (paletteOpen()) return closePalette();
    openPalette(active().url, "current");
    if (TEST_HOOKS) console.error("ND_APP FOCUS target=palette");
  }

  function commitQuery(raw: string, target: OmniTarget = paletteTarget()): void {
    closePalette();
    const tab = active();
    raw = fieldAddress(raw, tab.url);
    if (target === "new-tab" && tab.url !== "") {
      const url = toUrl(raw);
      if (url) ctx.openTab(winId, url);
      return;
    }
    ctx.navigate(tab.id, raw);
  }

  /// A history or completion row: the address itself, sent where Enter sends
  /// typed text.
  function openUrl(url: string): void {
    if (paletteTarget() === "new-tab" && active().url !== "") {
      ctx.openTab(winId, url);
      return;
    }
    ctx.navigate(active().id, url);
  }

  function selectTab(id: string): void {
    setSiteInfoOpen(false);
    ctx.selectTab(id);
  }

  /// The commands that act on one tab, run on `tab`: the tab on show from the
  /// command bar, the one right-clicked from its menu. False for any other id.
  function runTabCommand(id: string, tab: SessionTab): boolean {
    switch (id) {
      case "close-tab":
        ctx.closeTab(tab.id);
        return true;
      case "close-other-tabs":
        ctx.closeOtherTabs(tab.id);
        return true;
      case "pin-tab":
        ctx.setPinned(tab.id, !tab.pinned);
        return true;
      case "reset-pinned":
        ctx.resetPinned(tab.id);
        return true;
      case "sleep-tab":
        ctx.sleepTab(tab.id);
        return true;
      case "duplicate-tab":
        if (tab.url) ctx.openTab(winId, tab.url);
        return true;
      case "move-new-window":
        ctx.moveTabTo(tab.id, "new");
        return true;
      case "copy-address":
        if (tab.url) void clipboard.writeText(tab.url).catch(() => {});
        return true;
      case "reload":
        ctx.command(tab.id, "reload");
        return true;
    }
    return false;
  }

  /// A tab's right-click menu, in the command table's words. A pinned tile
  /// gets the few that make sense for a page kept on purpose.
  function tabMenu(tab: SessionTab): MenuEntry[] {
    const item = (id: string, enabled = true): MenuEntry => ({ id, label: commandTitle(id, tab.pinned), enabled });
    const gap: MenuEntry = { separator: true };
    if (tab.pinned) {
      return [item("reset-pinned", !!tab.pinnedUrl && tab.pinnedUrl !== tab.url), item("pin-tab"), item("sleep-tab", ctx.canSleep(tab.id)), gap, item("close-tab")];
    }
    return [
      item("reload", !!tab.url),
      item("duplicate-tab", !!tab.url),
      item("copy-address", !!tab.url),
      gap,
      item("pin-tab"),
      item("move-new-window", tabs().length > 1),
      item("sleep-tab", ctx.canSleep(tab.id)),
      gap,
      item("close-tab"),
      item("close-other-tabs", tabs().some((t) => t.id !== tab.id && !t.pinned)),
    ];
  }

  function runPaletteItem(id: string): void {
    if (id === "url") return commitQuery(paletteQuery());
    closePalette();
    if (id.startsWith("tab:")) return selectTab(id.slice(4));
    if (id.startsWith("hist:")) return openUrl(id.slice(5));
    if (id.startsWith("go:")) return openUrl(id.slice(3));
    const tab = active();
    if (runTabCommand(id.slice(4), tab)) return;
    switch (id.slice(4)) {
      case "new-tab":
        return openPalette("", "new-tab");
      case "new-window":
        return ctx.newWindow();
      case "reopen-tab":
        return ctx.reopenTab(winId);
      case "next-tab":
        return ctx.cycleTab(winId, 1);
      case "prev-tab":
        return ctx.cycleTab(winId, -1);
      case "back":
        return ctx.command(tab.id, "goBack");
      case "forward":
        return ctx.command(tab.id, "goForward");
      case "site-info":
        return void setSiteInfoOpen(true);
      case "find":
        return ctx.openFind(tab.id);
      case "downloads":
        return openPanel("downloads");
      case "downloads-all":
        openPanel(null);
        return void setPanel("downloads");
      case "history":
      case "bookmarks":
        openPanel(null);
        return void setPanel(id.slice(4) as Panel);
      case "bookmark-page":
        return toggleBookmark(tab);
      case "layout":
        return ctx.setLayout(compact() ? "sidebar" : "compact");
      case "private":
        return ctx.openPrivate();
      case "reader":
        return ctx.toggleReader(tab.id);
      case "float":
        return ctx.toggleFloat(tab.id);
      case "blocking":
        return ctx.toggleBlocking(tab.id);
      case "hide-element":
        return ctx.toggleHiding(tab.id);
      case "restore-hidden":
        return ctx.restoreHidden(tab.id);
      case "update-lists":
        return ctx.updateLists();
      case "settings":
        return ctx.openSettings();
      case "zoom-in":
        return ctx.zoomStep(tab.id, 1);
      case "zoom-out":
        return ctx.zoomStep(tab.id, -1);
      case "zoom-reset":
        return ctx.zoomStep(tab.id, 0);
      case "extensions":
        return openExtensionsList();
      case "extensions-page":
        ctx.openTab(winId, "chrome://extensions");
        return;
      case "webstore":
        ctx.openTab(winId, "https://chromewebstore.google.com");
        return;
    }
  }

  /// One of the window's panels at a time: opening one puts any other away,
  /// the way a second menu replaces the first. GTK leaves an earlier popover
  /// up when another is opened from code, and AppKit's transient popovers
  /// only close on a click outside them.
  function openPanel(which: "downloads" | "siteInfo" | "extensions" | "popup" | null): void {
    if (which) setPanel(null);
    setDownloadsOpen(which === "downloads");
    setSiteInfoOpen(which === "siteInfo");
    setExtensionsOpen(which === "extensions");
    if (which !== "popup") setPopupId("");
  }

  // ------------------------------------------------------ extensions ---

  function openExtensionsList(): void {
    ctx.refreshExtensions();
    openPanel("extensions");
  }

  /// A second click on the action that is already open closes it, which is
  /// what Chrome's own toolbar button does. Anything else is decided at the
  /// root, on the action's live state.
  function openExtensionPopup(row: ExtensionRow): void {
    setExtensionsOpen(false);
    setDownloadsOpen(false);
    setSiteInfoOpen(false);
    if (popupId() === row.id) {
      setPopupId("");
      return;
    }
    ctx.clickAction(winId, row);
  }

  /// Chromium's own "Remove ...?" dialog hangs off a toolbar the app never
  /// shows, so the confirmation is the window's, and the engine removes the
  /// extension without asking again.
  function confirmRemoveExtension(row: ExtensionRow): void {
    const node = windowRef;
    if (!node) return;
    setExtensionsOpen(false);
    void showAlert(node, {
      title: `Remove “${row.name}”?`,
      body: "Its settings and data in this browser are removed with it.",
      // The first button is the leftmost on GTK and the rightmost on AppKit,
      // and each platform puts Remove on the right.
      buttons: gtk
        ? [
            { id: "cancel", label: "Cancel" },
            { id: "remove", label: "Remove", style: "destructive" },
          ]
        : [
            { id: "remove", label: "Remove", style: "destructive" },
            { id: "cancel", label: "Cancel" },
          ],
      // Return removes and Escape keeps it, as in Chrome's own dialog.
      defaultId: "remove",
      closeId: "cancel",
    })
      .then((answer) => {
        if (answer.buttonId === "remove") ctx.uninstallExtension(row.id);
      })
      .catch(() => {});
  }

  function closeExtensionPopup(): void {
    setPopupId("");
  }

  /// The live state for the tab on show, or the extension's defaults when the
  /// last answer was for another tab.
  function actionState(id: string): ExtensionActionState | null {
    const state = ctx.actionStates[id];
    if (state && state.tabUrl === active().url) return state;
    return ctx.actionDefaults[id] ?? null;
  }

  /// What the button says it will do: the title the extension set for this
  /// tab when there is one.
  function popupTooltip(row: ExtensionRow): string {
    if (!row.enabled) return `${row.name} is turned off`;
    return actionState(row.id)?.title || row.name;
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
      // lays one out at too. Measured to the body's far edges rather than its
      // size: a first child's top margin collapses through the body and
      // pushes it down, and a size that leaves that out scrolls the popup.
      `(() => {
         window.close = () => window.webkit.messageHandlers.ndPopup.postMessage(1);
         const b = document.body;
         if (!b) return JSON.stringify([0, 0]);
         const r = b.getBoundingClientRect();
         const s = getComputedStyle(b);
         return JSON.stringify([
           Math.ceil(r.right + parseFloat(s.marginRight)),
           Math.ceil(r.bottom + parseFloat(s.marginBottom)),
         ]);
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

  /// The view of an open popup. Created AT the extension URL, never navigated
  /// to it: Chromium refuses a renderer-initiated navigation to a
  /// chrome-extension:// page, so another action's popup is a new view.
  function PopupView(v: { id: string; url: string }) {
    let node!: NdNodeRef<"webview">;
    onSettled(() => {
      sendCommand(node, "registerScriptMessage", { name: "ndPopup" });
      fitPopup(node);
    });
    return (
      <webview
        ref={node}
        url={v.url}
        testID={`${p()}ext-popup-view-${v.id}`}
        style={{ hexpand: true, vexpand: true }}
        onLoadingChanged={(e) => {
          if (!e.checked) fitPopup(node);
        }}
        onJavaScriptResult={onJavaScriptResult}
        onScriptMessage={(e) => {
          const message = e.data as { name?: string };
          if (message.name === "ndPopup") closeExtensionPopup();
        }}
      />
    );
  }

  function extensionPopup(row: () => ExtensionRow) {
    return (
      <box
        testID={`${p()}ext-popup-body-${row().id}`}
        orientation="vertical"
        style={{ minWidth: popupSize().width, minHeight: popupSize().height }}
      >
        <Show when={popupUrl()} keyed>
          {(url) => <PopupView id={row().id} url={url} />}
        </Show>
      </box>
    );
  }

  /// Bookmark This Page keeps the page as it is titled; pressed again on a
  /// kept page, it lets it go.
  function toggleBookmark(tab: { url: string; title: string }): void {
    if (!/^https?:/.test(tab.url)) return;
    if (isBookmarked(tab.url)) {
      removeBookmark(tab.url);
      if (toast) void showToast(toast, { title: "Bookmark removed" });
    } else {
      addBookmark(tab.url, tab.title);
      if (toast) void showToast(toast, { title: "Bookmarked" });
    }
  }

  /// History, bookmarks and downloads, one at a time, over the window.
  function panels() {
    const open = (url: string): void => {
      setPanel(null);
      ctx.navigate(active().id, url);
    };
    return (
      <Switch>
        <Match when={panel() === "history"}>
          <HistoryPanel
            onClose={() => setPanel(null)}
            onOpen={open}
            onClearData={() => {
              setPanel(null);
              ctx.openTab(winId, "chrome://settings/clearBrowserData");
            }}
            onClearHistory={ctx.clearHistory}
          />
        </Match>
        <Match when={panel() === "bookmarks"}>
          <BookmarksPanel onClose={() => setPanel(null)} onOpen={open} current={active()} onToggleCurrent={() => toggleBookmark(active())} />
        </Match>
        <Match when={panel() === "downloads"}>
          <DownloadsPanel onClose={() => setPanel(null)} actions={ctx.downloadActions} />
        </Match>
      </Switch>
    );
  }

  // ------------------------------------------------------------- render ---

  const recentDownloads = createMemo(() => downloadState.items.slice(0, DOWNLOADS_SHOWN));
  const pageTitle = (): string => tabLabel(active());
  const activeOrigin = (): string => originOf(active().url);
  /// Only the active tab's prompt is on show; the rest of the queue waits.
  const activePrompt = createMemo(() => ctx.prompts.find((q) => q.tabId === active().id) ?? null);
  const siteDecisions = createMemo(() => decisionsFor(prefs.sitePermissions, activeOrigin()));
  /// An action opened from the panel rather than from a button of its own has
  /// nowhere to hang, so its popup rides the puzzle piece.
  const unpinnedPopup = createMemo(() => {
    const open = ctx.rows.find((r) => r.id === popupId());
    return open && !prefs.pinnedExtensions.includes(open.id) ? open : null;
  });
  /// The tab run is sized from the window rather than from hexpand: GTK would
  /// hand every tab an equal share of the whole row, which left every title
  /// at two characters. Lazy: only the compact layout reads it.
  const tabMetrics = createMemo(
    () => tabRunMetrics(props.win.width, tabs(), active().id, chromium() ? ctx.pinnedActions.length + 1 : 0, gtk ? "gtk" : "appkit", false),
    { lazy: true },
  );
  const targets = (): MoveTarget[] => ctx.moveTargets(winId);
  const dropIndex = (): number | null => (ctx.dropHint?.windowId === winId ? ctx.dropHint.index : null);

  // Ranking is entirely the app's job: <commandpalette> renders what it is
  // given, in order (lib/omnibox.ts, docs/omnibox.md). A ⌘L seed nobody has
  // edited yet ranks like an empty field; the same address typed in full
  // still gets its own row.
  const paletteItems = createMemo(() => {
    const tab = active();
    const query = paletteQuery();
    const untouchedSeed = query !== "" && query === paletteSeed() && paletteSeed() === tab.url;
    const typedQuery = untouchedSeed ? "" : query;
    // History only: the most visited places first (the completion picks from
    // them in this order), then the newest matches.
    const hits = historyHits();
    const places = [...completions().map((url) => ({ url, title: "" })), ...hits]
      .filter((v) => v.url !== tab.url)
      .map((v) => ({ url: v.url, title: v.title || hits.find((h) => h.url === v.url)?.title || "" }));
    const byRecency = (t: { id: string }) => {
      const at = recent.indexOf(t.id);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    return omniRows({
      mode: paletteMode(),
      query: typedQuery,
      target: paletteTarget(),
      tabs: tabs()
        .filter((t) => t.id !== tab.id)
        .sort((a, b) => byRecency(a) - byRecency(b)),
      history: places,
      engineName: SEARCH_ENGINES.find((e) => e.id === prefs.searchEngine)?.name ?? "the web",
      chromium: chromium(),
      pinned: tab.pinned,
      canSleep: ctx.canSleep(tab.id),
      reading: ctx.rt(tab.id).reading,
      blocking: chromium() ? ctx.blockingFor(tab.id) : undefined,
      favicon: ctx.iconFor,
    });
  });

  /// The tab-moving items, shared by the menu bar and a window's own menu.
  /// `from` is the window whose active tab they act on.
  function moveItems(prefix: string, from: () => SessionWindow, fromTargets: () => MoveTarget[]) {
    const tab = (): SessionTab => from().tabs.find((t) => t.id === from().activeId) ?? from().tabs[0] ?? NO_TAB;
    const at = (): number => from().tabs.indexOf(tab());
    return (
      <>
        <menuitem
          testID={`${prefix}move-left`}
          label="Move Tab Left"
          enabled={at() > 0}
          onSelect={() => ctx.moveTabBy(tab().id, -1)}
        />
        <menuitem
          testID={`${prefix}move-right`}
          label="Move Tab Right"
          enabled={at() < from().tabs.length - 1}
          onSelect={() => ctx.moveTabBy(tab().id, 1)}
        />
        <menuitem
          testID={`${prefix}move-new-window`}
          label="Move Tab to New Window"
          enabled={from().tabs.length > 1}
          onSelect={() => ctx.moveTabTo(tab().id, "new")}
        />
        <Show when={fromTargets().length > 0}>
          <menu label="Move Tab to Window" testID={`${prefix}move-to`}>
            <For each={fromTargets()} keyed={(t) => t.id}>
              {(t) => (
                <menuitem
                  testID={`${prefix}move-to-${t().id}`}
                  label={t().label}
                  onSelect={() => ctx.moveTabTo(tab().id, t().id)}
                />
              )}
            </For>
          </menu>
        </Show>
      </>
    );
  }

  /// The page-load bar: a thin line in the secondary ink along the page's top
  /// edge, in both layouts. Floats over the page, so it takes no layout of
  /// its own, and stays mounted once a load has run so a finished load can
  /// fade out instead of vanishing.
  function loadBar() {
    return (
      <Show when={activeRt().loading || activeRt().progress > 0}>
        <progressbar
          testID={`${p()}progress`}
          // The engine reports nothing for the first moments of a load; a
          // sliver says the click was heard.
          fraction={activeRt().loading ? Math.max(activeRt().progress, 0.08) : 1}
          cssClasses={["osd", "dimmed"]}
          style={{ valign: "start", hexpand: true }}
        />
      </Show>
    );
  }

  // The controls a popover hangs off. Both layouts draw them, in the header
  // bar (compact) or the sidebar, so each is built once and handed a slot.
  // Without a slot they sit in the sidebar's foot at the window's bottom, so
  // their popovers open upward and stay inside the window. Opened downward
  // GTK shrinks one to the room left under the window and then closes it for
  // being under its minimum size.

  /// What the page may do and what it is asking for, hung off the padlock.
  function siteInfoPanel() {
    return (
      <box
        testID={`${p()}site-info-panel`}
        orientation="vertical"
        spacing={Spacing.sm}
        style={{ padding: Spacing.sm, minWidth: SITE_PANEL_WIDTH }}
      >
        <label
          testID={`${p()}site-info-host`}
          text={hostOf(active().url) || "New Tab"}
          cssClasses={["heading"]}
          style={{ halign: "start" }}
        />
        <label
          testID={`${p()}site-info-security`}
          text={SECURITY_TOOLTIP[activeRt().security]}
          cssClasses={["dimmed", "caption"]}
          style={{ halign: "start" }}
        />
        <Show when={chromium() && activeBlocking().site}>
          <box testID={`${p()}site-blocking`} orientation="horizontal" spacing={Spacing.sm}>
            <box orientation="vertical" style={{ hexpand: true, valign: "center" }}>
              <label testID={`${p()}site-blocking-title`} text="Block Ads and Trackers" style={{ halign: "start" }} />
              <label
                testID={`${p()}site-blocking-count`}
                text={activeBlocking().on ? blockedSentence(activeBlocking().blocked) : "Off for this site"}
                cssClasses={["dimmed", "caption"]}
                style={{ halign: "start" }}
              />
            </box>
            <switch
              testID={`${p()}site-blocking-switch`}
              checked={activeBlocking().on}
              tooltip="Block Ads and Trackers"
              style={{ valign: "center" }}
              onToggled={(e) => {
                if (e.checked !== activeBlocking().on) ctx.toggleBlocking(active().id);
              }}
            />
          </box>
        </Show>
        <Switch
          fallback={
            <box orientation="vertical" spacing={Spacing.xs}>
              <For each={siteDecisions()} keyed={(row) => row.type}>
                {(row) => (
                  <box orientation="horizontal" spacing={Spacing.sm}>
                    <label
                      testID={`${p()}site-permission-${row().type}`}
                      text={`${permissionName(row().type)}: ${row().decision === "allow" ? "Allowed" : "Blocked"}`}
                      ellipsize
                      style={{ halign: "start", hexpand: true }}
                    />
                  </box>
                )}
              </For>
              <button
                testID={`${p()}site-permissions-reset`}
                label="Reset Permissions"
                cssClasses={["flat"]}
                onClick={() => ctx.resetSiteDecisions(activeOrigin())}
              />
            </box>
          }
        >
          <Match when={activePrompt()}>
            {(prompt) => (
              <box orientation="vertical" spacing={Spacing.sm}>
                <label
                  testID={`${p()}permission-request`}
                  text={permissionSentence(hostOf(active().url) || prompt().origin, prompt().types)}
                  style={{ halign: "start" }}
                />
                <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
                  <button
                    testID={`${p()}permission-block`}
                    label="Block"
                    onClick={() => {
                      ctx.decidePrompt(prompt(), "block");
                      setSiteInfoOpen(false);
                    }}
                  />
                  <button
                    testID={`${p()}permission-allow`}
                    label="Allow"
                    cssClasses={["suggested-action"]}
                    onClick={() => {
                      ctx.decidePrompt(prompt(), "allow");
                      setSiteInfoOpen(false);
                    }}
                  />
                </box>
              </box>
            )}
          </Match>
          <Match when={siteDecisions().length === 0}>
            <label
              testID={`${p()}site-permissions-empty`}
              text="This site has not asked for anything yet."
              cssClasses={["dimmed"]}
              style={{ halign: "start" }}
            />
          </Match>
        </Switch>
      </box>
    );
  }

  function closeSiteInfo(): void {
    setSiteInfoOpen(false);
    // Escape and a click outside are a dismissal, and a dismissed request is
    // denied rather than left pending.
    ctx.denyPromptsFor(active().id);
  }

  /// The padlock. In the sidebar it is a button in the foot, so the popover
  /// opens upward and stays inside the window: opened downward GTK shrinks one
  /// to the room left under the window and then closes it for being under its
  /// minimum size. In compact it leads the active tab and opens downward.
  function siteInfoControl(position: "top" | "bottom") {
    return (
      // One indicator, updated in place. The state rides the testID because
      // getTree exposes a node's text but never its icon name, so that is the
      // only way a drive can assert which padlock is drawn. The padlock is
      // Chrome's site-info button: what this page is allowed to do hangs off
      // it, and so does a permission the page is asking for right now. Boxed
      // because a popover anchors on its tree parent.
      <box testID={`${p()}site-info-anchor`} orientation="horizontal" style={{ valign: "center" }}>
        <button
          testID={`${p()}security-${activeRt().security}`}
          iconName={SECURITY_ICON[activeRt().security]}
          tooltip={SECURITY_TOOLTIP[activeRt().security]}
          cssClasses={position === "bottom" ? ["flat", "dimmed"] : ["flat"]}
          size={position === "bottom" ? "small" : undefined}
          // Inside the tab it is a glyph beside the favicon, not a button
          // of the row's size; Adwaita's side padding would part the two.
          style={position === "bottom" && gtk ? { padding: { left: 6, right: 0 } } : undefined}
          onClick={() => (siteInfoOpen() ? setSiteInfoOpen(false) : openPanel("siteInfo"))}
        />
        <popover testID={`${p()}site-info-popover`} open={siteInfoOpen()} position={position} onClosed={closeSiteInfo}>
          {siteInfoPanel()}
        </popover>
      </box>
    );
  }

  /// Chrome's blocked pop-up icon in the address bar, for the page on show.
  function popupsControl(position: "top" | "bottom") {
    return (
      <PopupBlockedControl
        prefix={p()}
        position={position}
        scope={`${active().id}:${position}`}
        urls={activeRt().popups.map((b) => b.url)}
        site={hostOf(active().url)}
        onOpen={(url) => ctx.openBlockedPopup(active().id, url)}
        onAllow={() => ctx.allowSitePopups(active().id)}
      />
    );
  }

  function windowMenu(slot?: "end") {
    return (
      // The menu bar lives in the first window. Every other window carries
      // its own menu for what acts on THAT window, moving its tab above all,
      // which a drag must never be the only way to do.
      <Show when={!props.first}>
        <menubutton slot={slot} testID={`${p()}window-menu`} iconName="open-menu-symbolic" tooltip="Main Menu">
          <menuitem testID={`${p()}menu-new-tab`} label="New Tab" onSelect={() => openPalette("", "new-tab")} />
          <menuitem testID={`${p()}menu-new-window`} label="New Window" onSelect={() => ctx.newWindow()} />
          <menuitem testID={`${p()}menu-close-tab`} label="Close Tab" onSelect={() => ctx.closeTab(active().id)} />
          <menuitem
            testID={`${p()}menu-sleep-tab`}
            label="Put Tab to Sleep"
            enabled={ctx.canSleep(active().id)}
            onSelect={() => ctx.sleepTab(active().id)}
          />
          <menuitem role="separator" testID={`${p()}menu-sep-move`} />
          {moveItems(`${p()}menu-`, () => props.win, targets)}
          <menuitem role="separator" testID={`${p()}menu-sep`} />
          <menuitem testID={`${p()}menu-find`} label="Find in Page" onSelect={() => ctx.openFind(active().id)} />
          <menuitem testID={`${p()}menu-show-history`} label="History" onSelect={() => setPanel("history")} />
          <menuitem testID={`${p()}menu-downloads`} label="Downloads" onSelect={() => setPanel("downloads")} />
          <menuitem testID={`${p()}menu-bookmarks`} label="Bookmarks" onSelect={() => setPanel("bookmarks")} />
          <menuitem testID={`${p()}menu-settings`} label="Settings" onSelect={() => ctx.openSettings()} />
        </menubutton>
      </Show>
    );
  }

  function extensionControls(slot?: "end") {
    return (
      // Chrome's extensions area: the pinned actions, then the puzzle piece
      // that lists everything installed. Each pinned action is boxed with its
      // own popover so the popup opens under the button that was clicked; an
      // unpinned one opens under the puzzle.
      <Show when={chromium()}>
        <For each={ctx.pinnedActions} keyed={(r) => r.id}>
          {(row) => {
            const live = () => actionState(row().id);
            return (
              <box slot={slot} testID={`${p()}ext-pin-${row().id}`} orientation="horizontal">
                {/* The badge floats over the icon's top corner, where Chrome
                    draws it, rather than widening the button. */}
                <overlay testID={`${p()}ext-action-stack-${row().id}`}>
                  <button
                    testID={`${p()}ext-action-${row().id}`}
                    iconData={row().iconData || undefined}
                    iconName="application-x-addon-symbolic"
                    tooltip={popupTooltip(row())}
                    cssClasses={["flat"]}
                    enabled={row().enabled && ctx.checkingAction !== row().id}
                    onClick={() => openExtensionPopup(row())}
                  />
                  <Show when={live()?.badgeText}>
                    <badge
                      testID={`${p()}ext-badge-${row().id}`}
                      label={live()!.badgeText}
                      variant={badgeVariant(live()!.badgeColor)}
                      style={{ halign: "end", valign: "start" }}
                    />
                  </Show>
                </overlay>
                <popover
                  testID={`${p()}ext-popup-${row().id}`}
                  open={popupId() === row().id}
                  position={slot ? "bottom" : "top"}
                  onClosed={closeExtensionPopup}
                >
                  <Show when={popupId() === row().id} fallback={<box orientation="horizontal" />}>
                    {extensionPopup(row)}
                  </Show>
                </popover>
              </box>
            );
          }}
        </For>
        <box slot={slot} testID={`${p()}extensions-anchor`} orientation="horizontal">
          <button
            testID={`${p()}extensions-button`}
            iconName="application-x-addon-symbolic"
            tooltip="Extensions"
            cssClasses={["flat"]}
            onClick={() => (extensionsOpen() ? setExtensionsOpen(false) : openExtensionsList())}
          />
          <popover
            testID={`${p()}extensions-popover`}
            open={extensionsOpen()}
            position={slot ? "bottom" : "top"}
            onClosed={() => setExtensionsOpen(false)}
          >
            <box
              testID={`${p()}extensions-panel`}
              orientation="vertical"
              spacing={Spacing.sm}
              style={{ padding: Spacing.sm, minWidth: EXTENSIONS_PANEL_WIDTH }}
            >
              <label text="Extensions" cssClasses={["heading"]} style={{ halign: "start" }} />
              <For
                each={ctx.rows}
                keyed={(r) => r.id}
                fallback={
                  <label
                    testID={`${p()}extensions-empty`}
                    text="Extensions you install appear here."
                    cssClasses={["dimmed"]}
                    style={{ halign: "start" }}
                  />
                }
              >
                {(row) => (
                  <box orientation="horizontal" spacing={Spacing.sm}>
                    {/* The name IS the button: a row-wide target is what a
                        pointer aims at, and the icon rides it rather than
                        sitting beside it as decoration. */}
                    <button
                      testID={`${p()}ext-row-${row().id}`}
                      label={row().name}
                      iconData={row().iconData || undefined}
                      iconName="application-x-addon-symbolic"
                      labelAlign="start"
                      ellipsize
                      tooltip={popupTooltip(row())}
                      cssClasses={["flat"]}
                      enabled={row().enabled}
                      style={{ hexpand: true }}
                      onClick={() => openExtensionPopup(row())}
                    />
                    <togglebutton
                      testID={`${p()}ext-pin-toggle-${row().id}`}
                      iconName="view-pin-symbolic"
                      tooltip={prefs.pinnedExtensions.includes(row().id) ? "Unpin from toolbar" : "Pin to toolbar"}
                      active={prefs.pinnedExtensions.includes(row().id)}
                      cssClasses={["flat"]}
                      style={{ valign: "center" }}
                      onToggled={() => ctx.pinExtension(row().id)}
                    />
                    <menubutton
                      testID={`${p()}ext-more-${row().id}`}
                      iconName="view-more-symbolic"
                      tooltip={`More for ${row().name}`}
                      cssClasses={["flat"]}
                      style={{ valign: "center" }}
                    >
                      <Show when={row().optionsUrl}>
                        <menuitem
                          testID={`${p()}ext-options-${row().id}`}
                          label="Options"
                          onSelect={() => {
                            setExtensionsOpen(false);
                            ctx.openTab(winId, row().optionsUrl);
                          }}
                        />
                      </Show>
                      <menuitem
                        testID={`${p()}ext-remove-${row().id}`}
                        label="Remove…"
                        onSelect={() => confirmRemoveExtension(row())}
                      />
                    </menubutton>
                  </box>
                )}
              </For>
              <button
                testID={`${p()}extensions-manage`}
                label="Manage Extensions"
                cssClasses={["flat"]}
                onClick={() => {
                  setExtensionsOpen(false);
                  ctx.openTab(winId, "chrome://extensions");
                }}
              />
              {/* Test-only: the drive has no other way in. `nd dev` and a
                  packaged run both take extensions from the Web Store or the
                  command line, and launchApp passes no argv. */}
              <Show when={TEST_HOOKS}>
                <button
                  testID={`${p()}extensions-install-test`}
                  label="Install the test extension"
                  cssClasses={["flat"]}
                  onClick={() => ctx.installTestExtension(process.env.NB_TEST_EXT)}
                />
                <button
                  testID={`${p()}extensions-install-action-test`}
                  label="Install the action test extension"
                  cssClasses={["flat"]}
                  onClick={() => ctx.installTestExtension(process.env.NB_TEST_EXT_ACTION)}
                />
              </Show>
            </box>
          </popover>
          {/* An unpinned action has no button of its own, so its popup hangs
              off the puzzle piece it was opened from. */}
          <popover
            testID={`${p()}ext-popup-unpinned`}
            open={unpinnedPopup() !== null}
            position={slot ? "bottom" : "top"}
            onClosed={closeExtensionPopup}
          >
            <Show when={unpinnedPopup()} fallback={<box orientation="horizontal" />}>
              {(row) => extensionPopup(row)}
            </Show>
          </popover>
        </box>
      </Show>
    );
  }

  function downloadsControl(slot?: "end") {
    return (
      // A popover anchors on its TREE parent on both backends, and a header
      // bar's own handle never joins a view hierarchy, so the button it hangs
      // off has to be boxed.
      <box slot={slot} testID={`${p()}downloads-anchor`} orientation="horizontal">
        <button
          testID={`${p()}downloads-button`}
          iconName="folder-download-symbolic"
          tooltip="Downloads"
          cssClasses={["flat"]}
          onClick={() => (downloadsOpen() ? setDownloadsOpen(false) : openPanel("downloads"))}
        />
        <popover
          testID={`${p()}downloads-popover`}
          open={downloadsOpen()}
          position={slot ? "bottom" : "top"}
          onClosed={() => setDownloadsOpen(false)}
        >
          {/* Stacked boxes rather than a list widget: a popover sizes itself
              from what it contains, and every list widget here is a scroll
              view, which contributes no height at all. */}
          <box
            testID={`${p()}downloads-panel`}
            orientation="vertical"
            spacing={Spacing.sm}
            style={{ padding: Spacing.sm, minWidth: DOWNLOADS_PANEL_WIDTH }}
          >
            <label text="Downloads" cssClasses={["heading"]} style={{ halign: "start" }} />
            <For
              each={recentDownloads()}
              keyed={(d) => d.id}
              fallback={
                <label
                  testID={`${p()}downloads-empty`}
                  text="Files you download appear here."
                  cssClasses={["dimmed"]}
                  style={{ halign: "start" }}
                />
              }
            >
              {(d) => <DownloadRow d={d()} actions={ctx.downloadActions} prefix={p()} compact />}
            </For>
            <box orientation="horizontal" spacing={Spacing.sm} style={{ hexpand: true }}>
              <button
                testID={`${p()}downloads-folder`}
                label="Open Downloads Folder"
                cssClasses={["flat"]}
                onClick={() => ctx.downloadActions.openFolder()}
              />
              <box orientation="horizontal" style={{ hexpand: true }} />
              <button
                testID={`${p()}downloads-all`}
                label="Show All"
                tooltip={`Every download (${shortcutLabel(KEYS.downloads)})`}
                cssClasses={["flat"]}
                onClick={() => {
                  openPanel(null);
                  setPanel("downloads");
                }}
              />
            </box>
          </box>
        </popover>
      </box>
    );
  }

  /// Chrome's find bar. The field takes the caret once, when the bar opens:
  /// focusing on every change would fight the user for it.
  function FindBar() {
    let field!: NdNodeRef<"searchinput">;
    onSettled(() => sendCommand(field, "focus"));
    return (
      <box
        testID={`${p()}find-bar`}
        orientation="horizontal"
        spacing={Spacing.sm}
        style={{ padding: Spacing.sm, minWidth: FIND_BAR_WIDTH }}
      >
        {/* Adwaita's `.error` on the entry is what a search that found
            nothing looks like in GNOME; the count label alone leaves the
            field claiming everything is fine. Empty rather than absent, so
            the class comes back off. */}
        <searchinput
          ref={field}
          testID={`${p()}find-query`}
          placeholder="Find in Page"
          cssClasses={findFailed(find()) ? ["error"] : []}
          style={{ hexpand: true }}
          onChanged={(e) => ctx.runFind(active().id, e.text)}
          onActivate={() => ctx.findCommand(active().id, "findNext")}
        />
        <Show when={`${find().query}:${find().count}:${find().found}`} keyed>
          {(_shape) => (
            <label
              testID={`${p()}find-count`}
              text={findSummary(find())}
              cssClasses={["dimmed", "numeric"]}
            />
          )}
        </Show>
        <button
          testID={`${p()}find-previous`}
          iconName="go-up-symbolic"
          tooltip="Previous match"
          cssClasses={["flat"]}
          onClick={() => ctx.findCommand(active().id, "findPrevious")}
        />
        <button
          testID={`${p()}find-next`}
          iconName="go-down-symbolic"
          tooltip="Next match"
          cssClasses={["flat"]}
          onClick={() => ctx.findCommand(active().id, "findNext")}
        />
        {/* Escape closes the popover, which is what fires onClosed; the
            button is the same exit for a pointer. */}
        <button
          testID={`${p()}find-close`}
          iconName="window-close-symbolic"
          tooltip="Close"
          cssClasses={["flat"]}
          onClick={() => ctx.closeFind(active().id)}
        />
      </box>
    );
  }

  // The menu bar acts on the FOCUSED window, whichever window draws it: its
  // accelerators are the app's, not this window's.
  const menuWin = createMemo((): SessionWindow => ctx.session.windows.find((w) => w.id === ctx.focusedWindowId && w.tabs.length > 0) ?? props.win);
  const menuActive = createMemo((): SessionTab => menuWin().tabs.find((t) => t.id === menuWin().activeId) ?? menuWin().tabs[0] ?? NO_TAB);
  const menuBlocking = createMemo(() => ctx.blockingFor(menuActive().id), { equals: sameBlocking });
  const menuRt = (): Runtime => ctx.rt(menuActive().id);
  const menuTarget = (): WindowController | undefined => ctx.controllerFor(menuWin().id);

  return (
    <window
      ref={windowRef}
      onAlertResult={(e) => {
        if (windowRef) onAlertResult(windowRef, e);
      }}
      title={pageTitle()}
      testID={props.first ? "main-window" : `${p()}window`}
      defaultWidth={props.win.width}
      defaultHeight={props.win.height}
      onFocused={(e) => ctx.onWindowFocused(winId, e.checked)}
      onClosed={() => ctx.onWindowClosed(winId)}
      onSizeChanged={(e) => {
        const { width, height } = e.data as { width: number; height: number };
        ctx.onWindowSize(winId, width, height);
      }}
    >
      <Show when={props.first}>
        <menubar defaults testID="menubar">
          <menu label="File" testID="menu-file">
            <menuitem
              testID="menu-new-tab"
              label="New Tab"
              accelerator={KEYS["new-tab"]}
              onSelect={() => menuTarget()?.openPalette("", "new-tab")}
            />
            <menuitem testID="menu-new-window" label="New Window" accelerator={KEYS["new-window"]} onSelect={() => ctx.newWindow()} />
            <menuitem
              testID="menu-private-window"
              label="New Private Window"
              accelerator={KEYS.private}
              onSelect={() => ctx.openPrivate()}
            />
            <menuitem
              testID="menu-address"
              label="Open Address Bar"
              accelerator={KEYS.address}
              onSelect={() => menuTarget()?.openAddress()}
            />
            <menuitem
              testID="menu-palette"
              label="Switch Tabs"
              accelerator={KEYS.switcher}
              onSelect={() => menuTarget()?.openSwitcher()}
            />
            <menuitem
              testID="menu-close-tab"
              label="Close Tab"
              accelerator={KEYS["close-tab"]}
              onSelect={() => ctx.closeTab(menuActive().id)}
            />
            <menuitem
              testID="menu-reopen-tab"
              label="Reopen Closed Tab"
              accelerator={KEYS["reopen-tab"]}
              onSelect={() => ctx.reopenTab(menuWin().id)}
            />
            <menuitem role="separator" testID="menu-file-sep" />
            <menuitem testID="menu-settings" label="Settings" accelerator={KEYS.settings} onSelect={() => ctx.openSettings()} />
          </menu>
          <menu label="Edit" testID="menu-edit">
            <menuitem
              testID="menu-copy-address"
              label="Copy Address"
              accelerator={KEYS["copy-address"]}
              enabled={!!menuActive().url}
              onSelect={() => runTabCommand("copy-address", menuActive())}
            />
            <menuitem
              testID="menu-find"
              label="Find in Page"
              accelerator={KEYS.find}
              onSelect={() => ctx.openFind(menuActive().id)}
            />
            <menuitem
              testID="menu-find-next"
              label="Find Next"
              accelerator={KEYS["find-next"]}
              onSelect={() => ctx.findCommand(menuActive().id, "findNext")}
            />
            <menuitem
              testID="menu-find-previous"
              label="Find Previous"
              accelerator={KEYS["find-previous"]}
              onSelect={() => ctx.findCommand(menuActive().id, "findPrevious")}
            />
          </menu>
          <menu label="View" testID="menu-view">
            <menuitem
              testID="menu-reload"
              label="Reload"
              accelerator={KEYS.reload}
              onSelect={() => ctx.command(menuActive().id, "reload")}
            />
            <Show when={!compact()}>
              <menuitem
                testID="menu-toggle-sidebar"
                label={sidebarHidden() && menuWin().id === winId ? "Show Sidebar" : "Hide Sidebar"}
                accelerator={KEYS["toggle-sidebar"]}
                onSelect={() => menuTarget()?.toggleSidebar()}
              />
            </Show>
            {/* Chromium binds most ctrl and ctrl+shift letters, and password
                managers take ctrl+shift+l and ctrl+shift+x. primary+shift+comma
                never fired from the address field on X11, where GTK sees the
                key as less. */}
            <menuitem
              testID="menu-layout"
              label={compact() ? "Use Sidebar Layout" : "Use Compact Layout"}
              accelerator={KEYS.layout}
              onSelect={() => ctx.setLayout(compact() ? "sidebar" : "compact")}
            />
            <menuitem
              testID="menu-downloads"
              label="Downloads"
              accelerator={KEYS.downloads}
              onSelect={() => menuTarget()?.togglePanel("downloads")}
            />
            <menuitem
              testID="menu-bookmarks"
              label="Bookmarks"
              accelerator={KEYS.bookmarks}
              onSelect={() => menuTarget()?.togglePanel("bookmarks")}
            />
            <menuitem
              testID="menu-bookmark-page"
              label={kept(menuActive().url) ? "Remove Bookmark" : "Bookmark This Page"}
              accelerator={KEYS["bookmark-page"]}
              enabled={/^https?:/.test(menuActive().url)}
              onSelect={() => toggleBookmark(menuActive())}
            />
            <menuitem
              testID="menu-reader"
              label={menuRt().reading ? "Leave Reading Mode" : "Reading Mode"}
              accelerator={KEYS.reader}
              enabled={chromium()}
              onSelect={() => ctx.toggleReader(menuActive().id)}
            />
            <menuitem
              testID="menu-blocking"
              label={menuBlocking().on ? `Allow Ads on ${menuBlocking().site || "This Site"}` : `Block Ads on ${menuBlocking().site}`}
              enabled={chromium() && !!menuBlocking().site}
              onSelect={() => ctx.toggleBlocking(menuActive().id)}
            />
            <menuitem
              testID="menu-hide-element"
              label="Hide Element"
              accelerator={KEYS["hide-element"]}
              enabled={chromium() && /^https?:/.test(menuActive().url)}
              onSelect={() => ctx.toggleHiding(menuActive().id)}
            />
            <menuitem
              testID="menu-float"
              label="Float Video"
              accelerator={KEYS.float}
              enabled={chromium()}
              onSelect={() => ctx.toggleFloat(menuActive().id)}
            />
            <menuitem role="separator" testID="menu-view-sep" />
            <menuitem
              testID="menu-zoom-in"
              label="Zoom In"
              accelerator={KEYS["zoom-in"]}
              onSelect={() => ctx.zoomStep(menuActive().id, 1)}
            />
            <menuitem
              testID="menu-zoom-out"
              label="Zoom Out"
              accelerator={KEYS["zoom-out"]}
              onSelect={() => ctx.zoomStep(menuActive().id, -1)}
            />
            <menuitem
              testID="menu-zoom-reset"
              label="Reset Zoom"
              accelerator={KEYS["zoom-reset"]}
              onSelect={() => ctx.zoomStep(menuActive().id, 0)}
            />
          </menu>
          <menu label="Tabs" testID="menu-tabs">
            <menuitem
              testID="menu-next-tab"
              label="Next Tab"
              accelerator={KEYS["next-tab"]}
              onSelect={() => ctx.cycleTab(menuWin().id, 1)}
            />
            <menuitem
              testID="menu-prev-tab"
              label="Previous Tab"
              accelerator={KEYS["prev-tab"]}
              onSelect={() => ctx.cycleTab(menuWin().id, -1)}
            />
            <menuitem
              testID="menu-pin-tab"
              label={menuActive().pinned ? "Unpin Tab" : "Pin Tab"}
              onSelect={() => ctx.setPinned(menuActive().id, !menuActive().pinned)}
            />
            <menuitem
              testID="menu-sleep-tab"
              label="Put Tab to Sleep"
              enabled={ctx.canSleep(menuActive().id)}
              onSelect={() => ctx.sleepTab(menuActive().id)}
            />
            {moveItems("menu-", menuWin, () => ctx.moveTargets(menuWin().id))}
            <menuitem role="separator" testID="menu-tabs-sep" />
            <For each={menuWin().tabs} keyed={(t) => t.id}>
              {(t, i) => (
                <menuitem
                  testID={`menu-tab-${i()}`}
                  label={tabLabel(t())}
                  accelerator={tabKey(i(), menuWin().tabs.length)}
                  onSelect={() => ctx.selectTab(t().id)}
                />
              )}
            </For>
          </menu>
          <menu label="Go" testID="menu-go">
            <menuitem
              testID="menu-back"
              label="Back"
              accelerator={KEYS.back}
              enabled={menuRt().canGoBack}
              onSelect={() => ctx.command(menuActive().id, "goBack")}
            />
            <menuitem
              testID="menu-forward"
              label="Forward"
              accelerator={KEYS.forward}
              enabled={menuRt().canGoForward}
              onSelect={() => ctx.command(menuActive().id, "goForward")}
            />
          </menu>
          {/* Test-only: page content is unreachable from GTK automation (no
              pointer/key synthesis), so the acceptance drive needs one way to
              run a snippet inside the active page. Gated on NB_TEST_HOOKS, so
              it never exists in a normal run. */}
          <Show when={TEST_HOOKS}>
            <menu label="Debug" testID="menu-debug">
              <menuitem
                testID="menu-run-test-js"
                label="Run test script"
                onSelect={() => ctx.runTestJs(menuActive().id)}
              />
              <menuitem
                testID="menu-reveal-sidebar"
                label="Reveal the hidden sidebar"
                onSelect={() => menuTarget()?.revealSidebar(true)}
              />
              <menuitem
                testID="menu-conceal-sidebar"
                label="Conceal the revealed sidebar"
                onSelect={() => menuTarget()?.revealSidebar(false)}
              />
              <menuitem
                testID="menu-reveal-strip"
                label="Reveal the hidden window controls"
                onSelect={() => menuTarget()?.revealStrip(true)}
              />
              <menuitem
                testID="menu-conceal-strip"
                label="Conceal the revealed window controls"
                onSelect={() => menuTarget()?.revealStrip(false)}
              />
              {/* Esc in the command bar: a keystroke, and GTK synthesises
                  none (-32003). */}
              <menuitem
                testID="menu-close-palette"
                label="Close the command bar"
                onSelect={() => menuTarget()?.closePalette()}
              />
              {/* The menu itself belongs to the engine now, and no automation can
                  open one: GTK4 synthesises no pointer input, and the engine's
                  own context menu never fires headlessly. These feed the app's
                  own handler the payload a real click would carry, which is the
                  half the app owns. What the menu CONTAINS is asserted from the
                  ND_APP CTXMENU trace instead. */}
              <menuitem
                testID="menu-ctx-search-selection"
                label="Context: search the selection"
                onSelect={() =>
                  ctx.onContextMenuItem(menuActive().id, {
                    id: "nb-search-selection",
                    pageUrl: menuActive().url,
                    selectionText: "selected words",
                    editable: false,
                  })
                }
              />
            </menu>
          </Show>
          <Show when={chromium()}>
            <menu label="Extensions" testID="menu-extensions">
              <menuitem
                testID="menu-extensions-page"
                label="Extensions"
                onSelect={() => ctx.openTab(menuWin().id, "chrome://extensions")}
              />
              <menuitem
                testID="menu-webstore"
                label="Chrome Web Store"
                onSelect={() => ctx.openTab(menuWin().id, "https://chromewebstore.google.com")}
              />
            </menu>
          </Show>
          <menu label="History" testID="menu-history">
            <menuitem
              testID="menu-show-history"
              label="Show All History"
              accelerator={KEYS.history}
              onSelect={() => menuTarget()?.togglePanel("history")}
            />
            <menuitem role="separator" testID="menu-history-sep" />
            <For
              each={ctx.history}
              keyed={(v) => v.url}
              fallback={<menuitem testID="menu-history-empty" label="No History Yet" enabled={false} />}
            >
              {(v, i) => (
                <menuitem
                  testID={`menu-history-${i()}`}
                  label={v().title || displayUrl(v().url)}
                  onSelect={() => ctx.openTab(menuWin().id, v().url)}
                />
              )}
            </For>
          </menu>
        </menubar>
      </Show>

      <toastoverlay ref={toast} onToastButtonClicked={onToastButtonClicked} onToastDismissed={onToastDismissed}>
        {/* The sidebar layout is Arc's: no header bar, the column running
            the window's full height with the window controls in its first
            row, and the page a rounded card on the sidebar's surface
            (docs/sidebar.md). Compact drops the column and puts one header
            bar row over a plain page. The content pane stays this
            splitview's second child in both, so the page slot never moves
            and no page reloads on a switch. */}
        <splitview
          ref={split}
          sidebarWidth={0.24}
          collapsed={!compact() && sidebarHidden()}
          edgeReveal={!compact()}
          // AppKit's glass sidebar reflects the page beside it, so the page
          // runs to the window's edges there; libadwaita keeps
          // it in an inset card on the sidebar's colour, unless the desktop
          // draws no window controls at all.
          contentStyle={compact() || !gtk || (!leadingControls() && !trailingControls()) ? "plain" : "card"}
          testID={`${p()}split`}
          onRevealChanged={(e) => setRevealed(e.checked)}
        >
          <Show when={!compact()}>
            <Sidebar
              p={p()}
              tabs={tabs()}
              activeId={active().id}
              loading={activeRt().loading}
              labelFor={tabLabel}
              hoverFor={tabHover}
              iconFor={ctx.iconFor}
              pinStyle={prefs.pinStyle}
              asleep={ctx.asleep}
              siteInfo={siteInfoControl("top")}
              zoom={
                <>
                  {popupsControl("top")}
                  <ZoomFootControl
                    open={zoomPopover.open() && !sidebarHidden()}
                    position="top"
                    factor={zoomFactor()}
                    prefix={p()}
                    onToggle={zoomPopover.toggle}
                    onStep={(direction) => ctx.setZoom(active().id, stepZoom(zoomFactor(), direction))}
                    onReset={() => ctx.setZoom(active().id, 1)}
                    onClosed={zoomPopover.close}
                  />
                </>
              }
              extensions={extensionControls()}
              downloads={downloadsControl()}
              windowMenu={windowMenu()}
              onSelect={selectTab}
              onClose={ctx.closeTab}
              menuFor={tabMenu}
              onMenu={(t, id) => runTabCommand(id, t)}
              menu={[
                { id: "new-tab", label: "New Tab", accelerator: KEYS["new-tab"] },
                { separator: true },
                { id: "toggle-sidebar", label: "Hide Sidebar", accelerator: KEYS["toggle-sidebar"] },
                { id: "layout", label: "Use Compact Layout", accelerator: KEYS.layout },
              ]}
              onColumnMenu={(id) => {
                if (id === "new-tab") ctx.openTab(winId, "");
                else if (id === "toggle-sidebar") setSidebarHidden(true);
                else if (id === "layout") ctx.setLayout("compact");
              }}
              onNewTab={() => ctx.openTab(winId, "")}
              onOpenAddress={openAddress}
              onOpenSettings={() => ctx.openSettings()}
              onLeadingControlsChanged={setLeadingControls}
              dragPayload={(t) => tabPayload({ profile: "default", tabId: t.id, url: t.url })}
              dropIndex={dropIndex()}
              onDragOverIndex={(index) => {
                if (TEST_HOOKS) console.error(`ND_APP DRAG over index=${index}`);
                ctx.setDropHint(winId, index);
              }}
              onDropAt={(payload, index, pinned) => {
                if (TEST_HOOKS) console.error(`ND_APP DRAG drop index=${index} pinned=${pinned}`);
                const drag = parseTabPayload(payload);
                // Landing in the other section is what pins or unpins a tab.
                if (drag?.profile === "default") {
                  const tab = ctx.session.windows.flatMap((w) => w.tabs).find((t) => t.id === drag.tabId);
                  if (tab && tab.pinned !== pinned) ctx.setPinned(tab.id, pinned);
                }
                ctx.onTabDropped(winId, payload, index);
              }}
              onDragStart={(payload) => {
                if (TEST_HOOKS) console.error("ND_APP DRAG start");
                ctx.onDragStart(payload);
              }}
              onDragEnd={ctx.onDragEnd}
            />
          </Show>

          {/* With the sidebar hidden the page is immersive: the strip slides
              away over it and comes back while the pointer is at the top
              edge, and the page never moves for it (topBarsAutoHide). */}
          <toolbarview
            ref={contentBars}
            slot="content"
            testID={`${p()}content-toolbar`}
            topBarsAutoHide={!compact() && gtk && sidebarHidden() && trailingControls()}
          >
            {/* Window controls the desktop puts on the TRAILING side
                (GNOME's default) do not belong in a leading sidebar: they get
                a strip of their own over the page card, which starts below
                it. The strip is only as tall as the controls and moves the
                window like a title bar. With no trailing controls (a layout
                that leads with them, or none at all as on a tiling
                compositor) it is hidden rather than unmounted, so the card
                keeps its full inset and a change of the setting is still
                heard. macOS has all three in the sidebar. */}
            <Show when={!compact() && gtk}>
              <Activity mode={trailingControls() ? "visible" : "hidden"}>
                <box slot="top" testID={`${p()}controls-strip`} orientation="horizontal" windowHandle style={{ padding: INSET }}>
                  <box orientation="horizontal" style={{ hexpand: true }} />
                  <windowcontrols
                    testID={`${p()}controls-end`}
                    side="end"
                    style={{ valign: "center" }}
                    onEmptyChanged={(e) => setTrailingControls(!e.checked)}
                  />
                </box>
              </Activity>
            </Show>
            <Show when={compact()}>
              <headerbar
                testID={`${p()}chrome`}
                title=""
                canGoBack={activeRt().canGoBack}
                canGoForward={activeRt().canGoForward}
                onBack={() => ctx.command(active().id, "goBack")}
                onForward={() => ctx.command(active().id, "goForward")}
              >
                {/* One icon for both directions: Adwaita's sidebar-hide glyph has
                    no SF Symbol behind it, so the state rides the tooltip. In
                    compact it joins the trailing controls, so the row starts
                    where the reference's does: back, forward, reload, tabs. */}
                <button
                  slot="start"
                  testID={`${p()}reload`}
                  iconName={activeRt().loading ? "process-stop-symbolic" : "view-refresh-symbolic"}
                  tooltip={activeRt().loading ? "Stop" : "Reload"}
                  cssClasses={["flat"]}
                  onClick={() => ctx.command(active().id, activeRt().loading ? "stop" : "reload")}
                />

                {/* Compact puts the tabs in the row itself, after reload, and
                    nothing below it. The active tab is the address. */}
                <CompactTabs
                  tabs={tabs()}
                  activeId={active().id}
                  metrics={tabMetrics()}
                  prefix={p()}
                  iconFor={ctx.iconFor}
                  labelFor={tabLabel}
                  hoverFor={tabHover}
                  onOpenAddress={openAddress}
                  addressLeading={siteInfoControl("bottom")}
                  addressTrailing={
                    <>
                      {popupsControl("bottom")}
                      <ZoomFootControl
                        open={zoomPopover.open()}
                        factor={zoomFactor()}
                        prefix={p()}
                        position="bottom"
                        onToggle={zoomPopover.toggle}
                        onStep={(direction) => ctx.setZoom(active().id, stepZoom(zoomFactor(), direction))}
                        onReset={() => ctx.setZoom(active().id, 1)}
                        onClosed={zoomPopover.close}
                      />
                    </>
                  }
                  asleep={ctx.asleep}
                  onSelect={selectTab}
                  onClose={ctx.closeTab}
                  menuFor={(t) => tabMenu(tabs().find((x) => x.id === t.id)!)}
                  onMenu={(t, id) => runTabCommand(id, tabs().find((x) => x.id === t.id)!)}
                  dragPayload={(t) => tabPayload({ profile: "default", tabId: t.id, url: t.url })}
                  dropIndex={dropIndex()}
                  onDragOverIndex={(index) => ctx.setDropHint(winId, index)}
                  onDropAt={(payload, index) => ctx.onTabDropped(winId, payload, index)}
                  onDragStart={ctx.onDragStart}
                  onDragEnd={ctx.onDragEnd}
                />
                <button
                  slot="start"
                  testID={`${p()}header-new-tab`}
                  // A bare plus, not the boxed tab glyph: in one row of tabs
                  // the boxed one reads as a sixth tab.
                  iconName="list-add-symbolic"
                  tooltip="New Tab"
                  cssClasses={["flat"]}
                  onClick={() => ctx.openTab(winId, "")}
                />

                {/* A narrow row gives this one up first: the View menu and the
                    chord switch layouts too. */}
                <Show when={props.win.width >= LAYOUT_BUTTON_WIDTH}>
                  <button
                    slot="end"
                    testID={`${p()}layout-toggle`}
                    iconName="sidebar-show-symbolic"
                    tooltip="Use Sidebar Layout"
                    cssClasses={["flat"]}
                    onClick={() => ctx.setLayout("sidebar")}
                  />
                </Show>

                {extensionControls("end")}

                {downloadsControl("end")}

                {/* Last in the row, where the first window's menu bar puts its
                    own button. */}
                {windowMenu("end")}
              </headerbar>
            </Show>

            <box testID={`${p()}content`} orientation="vertical" spacing={0} style={{ hexpand: true, vexpand: true }}>
              {panels()}
              {/* Presents over the active window wherever it is mounted. */}
              <commandpalette
                testID={`${p()}palette`}
                open={paletteOpen()}
                placeholder={paletteMode() === "switcher" ? "Switch to a tab or run a command" : "Search or enter address"}
                query={paletteSeed()}
                items={paletteItems()}
                onQueryChanged={(e) => {
                  setPaletteQuery(e.text);
                  refreshHits(e.text);
                }}
                onActivate={(e) => runPaletteItem(e.text)}
                onSubmit={(e) => commitQuery(e.text)}
                onCancel={closePalette}
              />

              {/* The load bar floats over the page instead of taking a row of
                  layout: mounting it must not resize the webview. First child
                  of the overlay is the page slot; everything else is a
                  floating layer. */}
              <overlay testID={`${p()}page-stack`} style={{ hexpand: true, vexpand: true }}>
                {/* Where this window's tabs' pages are shown. The root moves
                    each live `<webview>` in here (moveNode); nothing this
                    window renders is a child of it, so no update of this
                    window can reorder or remove a page. Only the active tab's
                    view is visible. */}
                <box
                  ref={slot}
                  testID={`${p()}view-slot`}
                  orientation="vertical"
                  style={{ hexpand: true, vexpand: true }}
                />

                <Show when={activeRt().error}>
                  {(error) => (
                    <statuspage
                      testID={`${p()}error-page`}
                      iconName="network-error-symbolic"
                      title="Unable to load this page"
                      description={`${displayUrl(error().url)}: ${error().error}`}
                      style={{ hexpand: true, vexpand: true }}
                    >
                      <button
                        testID={`${p()}retry`}
                        label="Try Again"
                        cssClasses={["suggested-action", "pill"]}
                        onClick={() => ctx.retry(active().id)}
                      />
                    </statuspage>
                  )}
                </Show>

                {/* A new tab has no webview at all, so this native page is
                    all the content area shows: a GTK widget cannot be seen
                    over the engine's own X11 child window, and there is none
                    here to be under. */}
                <Show when={active().url === ""}>
                  <box testID={`${p()}new-tab-page`} orientation="vertical" style={{ hexpand: true, vexpand: true }}>
                    <box
                      orientation="vertical"
                      spacing={Spacing.sm}
                      style={{ halign: "center", valign: "center", vexpand: true }}
                    >
                      {/* Not a second address field: the command bar is the
                          only place an address is typed, and this opens it. */}
                      <button
                        testID={`${p()}new-tab-search`}
                        label="Search or enter address"
                        iconName="system-search-symbolic"
                        cssClasses={["pill"]}
                        onClick={() => openPalette("", "current")}
                      />
                      <box orientation="horizontal" spacing={Spacing.xs} style={{ halign: "center" }}>
                        <image iconName="system-search-symbolic" symbolScale="small" cssClasses={["dimmed"]} />
                        <label
                          testID={`${p()}new-tab-engine`}
                          text={`Search with ${engineOf(prefs.searchEngine).name}`}
                          cssClasses={["dimmed", "caption"]}
                        />
                      </box>
                    </box>
                  </box>
                </Show>

                {loadBar()}

                <Show when={props.first}>{ctx.hiddenViews()}</Show>

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
                  testID={`${p()}find-anchor`}
                  orientation="horizontal"
                  style={{
                    halign: "end",
                    valign: "start",
                    minWidth: FIND_BAR_WIDTH,
                    minHeight: 1,
                    margin: { top: Spacing.sm, right: Spacing.md },
                  }}
                >
                  <Show when={find().open}>
                    <popover testID={`${p()}find-popover`} open position="bottom" onClosed={() => ctx.closeFind(active().id)}>
                      <FindBar />
                    </popover>
                  </Show>
                </box>
              </overlay>
            </box>
          </toolbarview>
        </splitview>
      </toastoverlay>
    </window>
  );
}

/// What a window's derived values fall back to in the moment between its last
/// tab going and the window itself being taken down.
const NO_TAB: SessionTab = { id: "", url: "", title: "", pinned: false };
