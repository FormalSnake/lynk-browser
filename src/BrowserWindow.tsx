// One normal browser window: its toolbar, its tab list and the slot its tabs'
// pages are shown in. The pages themselves are not children of this tree: the
// app root keeps every tab's `<webview>` in the framework's off-window pool and
// moves the live widget into whichever window's slot shows it, which is what
// lets a tab change windows without its page reloading. Everything keyed by
// tab lives at the root for the same reason; what lives here is the state of
// this window's own chrome (palette, popovers, the popup an action opened).
import {
  Platform,
  Spacing,
  clipboard,
  createPortal,
  executeJavaScript,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  openPath,
  revealPath,
  sendCommand,
  showToast,
  useRef,
  useState,
} from "@nativedesktop/react";
import { Activity } from "react";
import type {
  ContextMenuItemClick,
  ExtensionActionState,
  NdNodeRef,
} from "@nativedesktop/react";

import { INSET, Sidebar } from "./Sidebar.tsx";
import { ADDRESS_MIN_WIDTH, CompactTabs, LAYOUT_BUTTON_WIDTH, tabRunMetrics } from "./CompactTabs.tsx";
import { ZoomFootControl, ZoomPopover, useZoomPopover, zoomFieldProps } from "./ZoomControl.tsx";
import { stepZoom, zoomPercent } from "./lib/zoom.ts";
import type { DownloadItem } from "./lib/downloads.ts";
import { downloadDir } from "./lib/downloads.ts";
import {
  badgeVariant,
  clampPopup,
  POPUP_DEFAULT_HEIGHT,
  POPUP_DEFAULT_WIDTH,
  POPUP_MIN,
  type ExtensionRow,
} from "./lib/extensions.ts";
import { faviconFor } from "./lib/favicons.ts";
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
import type { SessionState, SessionWindow } from "./lib/session.ts";
import { KEYS } from "./lib/keys.ts";
import { omniRows, type OmniMode, type OmniTarget } from "./lib/omnibox.ts";
import { SEARCH_ENGINES, engineOf, type Layout, type SettingsState } from "./lib/settings.ts";
import { parseTabPayload, tabPayload } from "./lib/tabdrag.ts";
import {
  SECURITY_ICON,
  SECURITY_TOOLTIP,
  downloadStatus,
  findFailed,
  findSummary,
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

function capLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/// The extensions panel. Wide enough for a name beside its pin toggle, and
/// fixed so the panel does not resize as extensions come and go.
const EXTENSIONS_PANEL_WIDTH = 300;

/// The site-info panel, sized for a permission sentence rather than for the
/// shortest thing it ever holds.
const SITE_PANEL_WIDTH = 320;
/// The downloads panel's width. Its file names ellipsize, and an ellipsizing
/// label asks for no width of its own, so without a floor the panel shrank
/// until every name read "…".
const DOWNLOADS_PANEL_WIDTH = 300;

/// What the root asks of a window's own chrome. The menu bar belongs to one
/// window and acts on whichever window is focused, so it reaches the others'
/// palette, address field and popovers through these.
export interface WindowController {
  /// Opens the command bar holding `seed`. `target` is where Enter sends an
  /// address: "new-tab" for ⌘T, "current" (the default) otherwise.
  openPalette(seed: string, target?: OmniTarget): void;
  /// ⌘L: the command bar seeded with the showing tab's address.
  openAddress(): void;
  /// ⌘K: the command bar as a tab switcher and command list.
  openSwitcher(): void;
  /// Test-only: runs what Enter in the address field runs, on what the field
  /// is holding.
  commitAddress(): void;
  /// Test-only: what Esc in the command bar does.
  closePalette(): void;
  openDownloads(): void;
  openSiteInfo(): void;
  /// Fires the compact address field's padlock, or the sidebar's.
  pressPadlock(): void;
  /// Arc's Cmd+S, for the sidebar layout.
  toggleSidebar(): void;
  /// Test-only: what the pointer at the leading edge does, for a backend with
  /// no pointer synthesis.
  revealSidebar(show: boolean): void;
  /// The auto-hidden window-control strip, for drives without a real pointer.
  revealStrip(show: boolean): void;
  showPopup(id: string, url: string): void;
  toast(title: string): void;
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
  downloads: DownloadItem[];
  prompts: PermissionPrompt[];
  rows: ExtensionRow[];
  pinnedActions: ExtensionRow[];
  checkingAction: string;
  privateOpen: boolean;
  focusedWindowId: string;
  /// Where a dragged tab would land: this window's row and the index in it.
  dropHint: { windowId: string; index: number } | null;
  iconEpoch: number;
  /// The registry and action views. They need a realized window to exist in,
  /// and the first one hosts them.
  hiddenViews: React.ReactNode;

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
  reopenTab(windowId: string): void;
  cycleTab(windowId: string, step: number): void;
  navigate(tabId: string, raw: string): void;
  retry(tabId: string): void;
  command(tabId: string, name: "goBack" | "goForward" | "reload" | "stop"): void;
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

  refreshExtensions(): void;
  pinExtension(id: string): void;
  clickAction(windowId: string, row: ExtensionRow): void;
  installTestExtension(dir: string | undefined): void;

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

export function BrowserWindow({ win, first, ctx }: BrowserWindowProps): React.ReactNode {
  const { prefs, chromium } = ctx;
  const tabs = win.tabs;
  const active = tabs.find((t) => t.id === win.activeId) ?? tabs[0]!;
  /// TestIDs of the first window keep their plain names; every other window's
  /// are prefixed with its id, so a drive can tell them apart.
  const p = first ? "" : `${win.id}-`;

  const [paletteOpen, setPaletteOpen] = useState(false);
  // Two halves of one field. `paletteSeed` is the controlled `query` prop and
  // only ever changes when the app deliberately seeds or clears it; echoing
  // keystrokes back into it makes GTK's set_text race the entry and blank it.
  // `paletteQuery` is what the user actually typed, and only feeds ranking.
  const [paletteSeed, setPaletteSeed] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteTarget, setPaletteTarget] = useState<OmniTarget>("current");
  const [historyHits, setHistoryHits] = useState<Visit[]>([]);
  const [completions, setCompletions] = useState<string[]>([]);
  const [paletteMode, setPaletteMode] = useState<OmniMode>("address");
  /// Tab ids of this window, most recently shown first, so the switcher lists
  /// the page you just left at the top.
  const recent = useRef<string[]>([]);
  if (recent.current[0] !== active.id) {
    recent.current = [active.id, ...recent.current.filter((id) => id !== active.id && tabs.some((t) => t.id === id))];
  }
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  /// The action whose popup is open, "" for none, and the address it was
  /// mounted at: the one Chromium reported at the click, which an extension
  /// can change at runtime away from the manifest's.
  const [popupId, setPopupId] = useState("");
  const [popupUrl, setPopupUrl] = useState("");
  const [popupSize, setPopupSize] = useState({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
  /// Arc's Cmd+S: the column is hidden and the page takes the window, and the
  /// pointer at the leading edge brings the column back over it while it is.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  /// Whether that hidden column is showing over the page right now.
  const [revealed, setRevealed] = useState(false);
  /// Whether the desktop's decoration layout puts window buttons on the
  /// trailing side (GTK); they then get the strip over the page.
  const [trailingControls, setTrailingControls] = useState(false);

  const toast = useRef<NdNodeRef<"toastoverlay">>(null);
  const split = useRef<NdNodeRef<"splitview">>(null);
  const contentBars = useRef<NdNodeRef<"toolbarview">>(null);
  /// The find field the app has already put the caret in. An inline ref
  /// callback runs on every render, and focusing on each one would fight the
  /// user for the caret.
  const findFocused = useRef(0);
  /// Compact's address field, which the zoom popover points at: its trailing
  /// icon is the magnifier.
  const addressField = useRef<NdNodeRef<"searchinput"> | null>(null);
  /// What is in the address field right now. Only a test hook reads it: a
  /// person presses Enter, which carries the text with it.
  const typedAddress = useRef("");
  /// The open popup's view, and the id of the one whose window.close the app
  /// has already hooked.
  const popupView = useRef<NdNodeRef<"webview"> | null>(null);
  const popupHooked = useRef(0);

  const activeRt = ctx.rt(active.id);
  const find = ctx.findFor(active.id);
  const compact = prefs.layout === "compact";
  const gtk = Platform.backend === "gtk";
  const zoomFactor = ctx.zoomFor(active.url);
  const zoomPopover = useZoomPopover(active.id, activeRt.zoomNotice, () => {
    // The sidebar's foot is out of sight with the sidebar hidden, so the new
    // value is said the way the reference browser says it.
    if (!compact && sidebarHidden && toast.current) void showToast(toast.current, { title: `Zoom ${zoomPercent(zoomFactor)}` });
  });

  ctx.registerController(win.id, {
    openPalette,
    openAddress,
    openSwitcher,
    commitAddress: () => commitQuery(typedAddress.current, "current"),
    closePalette,
    openDownloads: () => openPanel("downloads"),
    toggleSidebar: () => setSidebarHidden((h) => !h),
    revealSidebar: (show) => {
      if (split.current) sendCommand(split.current, show ? "revealSidebar" : "concealSidebar");
    },
    revealStrip: (show) => {
      if (contentBars.current) sendCommand(contentBars.current, show ? "revealTopBars" : "concealTopBars");
    },
    openSiteInfo: () => openPanel("siteInfo"),
    pressPadlock: () => {
      if (compact && addressField.current) sendCommand(addressField.current, "activateLeadingIcon");
      else if (siteInfoOpen) setSiteInfoOpen(false);
      else openPanel("siteInfo");
    },
    showPopup: (id, url) => {
      openPanel("popup");
      setPopupSize({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
      setPopupUrl(url);
      setPopupId(id);
    },
    toast: (title) => {
      if (toast.current) void showToast(toast.current, { title });
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
    refreshHits(seed === active.url ? "" : seed);
    if (paletteOpen) {
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
    void searchHistory(text).then(setHistoryHits);
    void completionCandidates(text).then(setCompletions);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteSeed("");
    setPaletteQuery("");
  }

  /// ⌘L in both layouts, and a click on the sidebar's address: the command
  /// bar holding the address, all of it selected, so typing replaces it.
  function openAddress(): void {
    // A second ⌘L puts the bar away again.
    if (paletteOpen) return closePalette();
    openPalette(active.url, "current");
    if (TEST_HOOKS) console.error("ND_APP FOCUS target=palette");
  }

  function commitQuery(raw: string, target: OmniTarget = paletteTarget): void {
    closePalette();
    raw = fieldAddress(raw, active.url);
    if (target === "new-tab" && active.url !== "") {
      const url = toUrl(raw);
      if (url) ctx.openTab(win.id, url);
      return;
    }
    ctx.navigate(active.id, raw);
  }

  /// A history or completion row: the address itself, sent where Enter sends
  /// typed text.
  function openUrl(url: string): void {
    if (paletteTarget === "new-tab" && active.url !== "") {
      ctx.openTab(win.id, url);
      return;
    }
    ctx.navigate(active.id, url);
  }

  function selectTab(id: string): void {
    setSiteInfoOpen(false);
    ctx.selectTab(id);
  }

  function runPaletteItem(id: string): void {
    if (id === "url") return commitQuery(paletteQuery);
    closePalette();
    if (id.startsWith("tab:")) return selectTab(id.slice(4));
    if (id.startsWith("hist:")) return openUrl(id.slice(5));
    if (id.startsWith("go:")) return openUrl(id.slice(3));
    switch (id.slice(4)) {
      case "new-tab":
        return openPalette("", "new-tab");
      case "new-window":
        return ctx.newWindow();
      case "close-tab":
        return ctx.closeTab(active.id);
      case "reopen-tab":
        return ctx.reopenTab(win.id);
      case "next-tab":
        return ctx.cycleTab(win.id, 1);
      case "prev-tab":
        return ctx.cycleTab(win.id, -1);
      case "pin-tab":
        return ctx.setPinned(active.id, !active.pinned);
      case "sleep-tab":
        return ctx.sleepTab(active.id);
      case "duplicate-tab":
        if (active.url) ctx.openTab(win.id, active.url);
        return;
      case "move-new-window":
        return ctx.moveTabTo(active.id, "new");
      case "back":
        return ctx.command(active.id, "goBack");
      case "forward":
        return ctx.command(active.id, "goForward");
      case "copy-address":
        if (active.url) void clipboard.writeText(active.url).catch(() => {});
        return;
      case "site-info":
        return setSiteInfoOpen(true);
      case "reload":
        return ctx.command(active.id, "reload");
      case "find":
        return ctx.openFind(active.id);
      case "downloads":
        return openPanel("downloads");
      case "layout":
        return ctx.setLayout(compact ? "sidebar" : "compact");
      case "private":
        return ctx.openPrivate();
      case "settings":
        return ctx.openSettings();
      case "zoom-in":
        return ctx.zoomStep(active.id, 1);
      case "zoom-out":
        return ctx.zoomStep(active.id, -1);
      case "zoom-reset":
        return ctx.zoomStep(active.id, 0);
      case "extensions":
        return openExtensionsList();
      case "extensions-page":
        ctx.openTab(win.id, "chrome://extensions");
        return;
      case "webstore":
        ctx.openTab(win.id, "https://chromewebstore.google.com");
        return;
    }
  }

  /// One of the window's panels at a time: opening one puts any other away,
  /// the way a second menu replaces the first. GTK leaves an earlier popover
  /// up when another is opened from code, and AppKit's transient popovers
  /// only close on a click outside them.
  function openPanel(which: "downloads" | "siteInfo" | "extensions" | "popup"): void {
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
    if (popupId === row.id) {
      setPopupId("");
      return;
    }
    ctx.clickAction(win.id, row);
  }

  function closeExtensionPopup(): void {
    setPopupId("");
  }

  /// The live state for the tab on show, or the extension's defaults when the
  /// last answer was for another tab.
  function actionState(id: string): ExtensionActionState | null {
    const state = ctx.actionStates[id];
    if (state && state.tabUrl === active.url) return state;
    return ctx.actionDefaults[id] ?? null;
  }

  /// What the button says it will do: the title the extension set for this
  /// tab when there is one. An extension with no popup in its manifest cannot
  /// be triggered at all here: there is no Chromium toolbar button for
  /// `chrome.action.onClicked` to fire on.
  function popupTooltip(row: ExtensionRow): string {
    if (!row.enabled) return `${row.name} is turned off`;
    if (!row.popupUrl) return `${row.name} has no popup`;
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
        testID={`${p}ext-popup-body-${row.id}`}
        orientation="vertical"
        style={{ minWidth: popupSize.width, minHeight: popupSize.height }}
      >
        {/* Created AT the extension URL, never navigated to it: Chromium
            refuses a renderer-initiated navigation to a chrome-extension://
            page, so the key remounts the view when another action is opened. */}
        <webview
          key={popupUrl}
          ref={(node) => {
            popupView.current = node as NdNodeRef<"webview"> | null;
            if (!node || popupHooked.current === node.id) return;
            popupHooked.current = node.id;
            sendCommand(node as NdNodeRef<"webview">, "registerScriptMessage", { name: "ndPopup" });
            fitPopup(node as NdNodeRef<"webview">);
          }}
          url={popupUrl}
          testID={`${p}ext-popup-view-${row.id}`}
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

  // ------------------------------------------------------------- render ---

  const recentDownloads = ctx.downloads.slice(0, DOWNLOADS_SHOWN);
  const shownUrl = displayUrl(active.url);
  const pageTitle = tabLabel(active);
  const activeOrigin = originOf(active.url);
  /// Only the active tab's prompt is on show; the rest of the queue waits.
  const activePrompt = ctx.prompts.find((q) => q.tabId === active.id) ?? null;
  const siteDecisions = decisionsFor(prefs.sitePermissions, activeOrigin);
  const rows = ctx.rows;
  const pinnedActions = ctx.pinnedActions;
  /// An action opened from the panel rather than from a button of its own has
  /// nowhere to hang, so its popup rides the puzzle piece.
  const openAction = rows.find((r) => r.id === popupId) ?? null;
  const unpinnedPopup = openAction && !prefs.pinnedExtensions.includes(openAction.id) ? openAction : null;
  /// The tab run is sized from the window rather than from hexpand: GTK would
  /// hand every tab an equal share of the whole row, which is what left the
  /// address field nowhere to go and every title at two characters.
  const tabMetrics = tabRunMetrics(win.width, tabs, active.id, chromium ? pinnedActions.length + 1 : 0, gtk ? "gtk" : "appkit");
  const targets = ctx.moveTargets(win.id);
  const dropIndex = ctx.dropHint?.windowId === win.id ? ctx.dropHint.index : null;

  void ctx.iconEpoch;

  // Ranking is entirely the app's job: <commandpalette> renders what it is
  // given, in order (lib/omnibox.ts, docs/omnibox.md). A ⌘L seed nobody has
  // edited yet ranks like an empty field; the same address typed in full
  // still gets its own row.
  const untouchedSeed = paletteQuery !== "" && paletteQuery === paletteSeed && paletteSeed === active.url;
  const typedQuery = untouchedSeed ? "" : paletteQuery;
  // History only: the most visited places first (the completion picks from
  // them in this order), then the newest matches.
  const places = [...completions.map((url) => ({ url, title: "" })), ...historyHits]
    .filter((v) => v.url !== active.url)
    .map((v) => ({ url: v.url, title: v.title || historyHits.find((h) => h.url === v.url)?.title || "" }));
  const byRecency = (t: { id: string }) => {
    const at = recent.current.indexOf(t.id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const paletteItems = omniRows({
    mode: paletteMode,
    query: typedQuery,
    target: paletteTarget,
    tabs: tabs.filter((t) => t.id !== active.id).sort((a, b) => byRecency(a) - byRecency(b)),
    history: places,
    engineName: SEARCH_ENGINES.find((e) => e.id === prefs.searchEngine)?.name ?? "the web",
    chromium,
    pinned: active.pinned,
    canSleep: ctx.canSleep(active.id),
    favicon: faviconFor,
  });

  /// The tab-moving items, shared by the menu bar and a window's own menu.
  /// `from` is the window whose active tab they act on.
  function moveItems(prefix: string, from: SessionWindow, fromTargets: MoveTarget[]): React.ReactNode {
    const tab = from.tabs.find((t) => t.id === from.activeId) ?? from.tabs[0]!;
    const at = from.tabs.indexOf(tab);
    return (
      <>
        <menuitem
          testID={`${prefix}move-left`}
          label="Move Tab Left"
          enabled={at > 0}
          onSelect={() => ctx.moveTabBy(tab.id, -1)}
        />
        <menuitem
          testID={`${prefix}move-right`}
          label="Move Tab Right"
          enabled={at < from.tabs.length - 1}
          onSelect={() => ctx.moveTabBy(tab.id, 1)}
        />
        <menuitem
          testID={`${prefix}move-new-window`}
          label="Move Tab to New Window"
          enabled={from.tabs.length > 1}
          onSelect={() => ctx.moveTabTo(tab.id, "new")}
        />
        {fromTargets.length > 0 && (
          <menu label="Move Tab to Window" testID={`${prefix}move-to`}>
            {fromTargets.map((t) => (
              <menuitem
                key={t.id}
                testID={`${prefix}move-to-${t.id}`}
                label={t.label}
                onSelect={() => ctx.moveTabTo(tab.id, t.id)}
              />
            ))}
          </menu>
        )}
      </>
    );
  }

  /// The page-load bar: a thin line in the secondary ink along the page's top
  /// edge, in both layouts. Floats over the page, so it takes no layout of
  /// its own, and stays mounted once a load has run so a finished load can
  /// fade out instead of vanishing.
  function loadBar(): React.ReactNode {
    if (!activeRt.loading && activeRt.progress <= 0) return null;
    return (
      <progressbar
        testID={`${p}progress`}
        // The engine reports nothing for the first moments of a load; a
        // sliver says the click was heard.
        fraction={activeRt.loading ? Math.max(activeRt.progress, 0.08) : 1}
        cssClasses={["osd", "dimmed"]}
        style={{ valign: "start", hexpand: true }}
      />
    );
  }

  // The controls a popover hangs off. Both layouts draw them, in the header
  // bar (compact) or the sidebar, so each is built once and handed a slot.
  // Without a slot they sit in the sidebar's foot at the window's bottom, so
  // their popovers open upward and stay inside the window. Opened downward
  // GTK shrinks one to the room left under the window and then closes it for
  // being under its minimum size.

  /// What the page may do and what it is asking for, hung off the padlock.
  function siteInfoPanel(): React.ReactNode {
    return (
      <box
        testID={`${p}site-info-panel`}
        orientation="vertical"
        spacing={Spacing.sm}
        style={{ padding: Spacing.sm, minWidth: SITE_PANEL_WIDTH }}
      >
        <label
          testID={`${p}site-info-host`}
          text={hostOf(active.url) || "New Tab"}
          cssClasses={["heading"]}
          style={{ halign: "start" }}
        />
        <label
          testID={`${p}site-info-security`}
          text={SECURITY_TOOLTIP[activeRt.security]}
          cssClasses={["dimmed", "caption"]}
          ellipsize
          style={{ halign: "start" }}
        />
        {activePrompt ? (
          <box orientation="vertical" spacing={Spacing.sm}>
            <label
              testID={`${p}permission-request`}
              text={permissionSentence(hostOf(active.url) || activePrompt.origin, activePrompt.types)}
              style={{ halign: "start" }}
            />
            <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
              <button
                testID={`${p}permission-block`}
                label="Block"
                onClick={() => {
                  ctx.decidePrompt(activePrompt, "block");
                  setSiteInfoOpen(false);
                }}
              />
              <button
                testID={`${p}permission-allow`}
                label="Allow"
                cssClasses={["suggested-action"]}
                onClick={() => {
                  ctx.decidePrompt(activePrompt, "allow");
                  setSiteInfoOpen(false);
                }}
              />
            </box>
          </box>
        ) : siteDecisions.length === 0 ? (
          <label
            testID={`${p}site-permissions-empty`}
            text="This site has not asked for anything yet."
            cssClasses={["dimmed"]}
            style={{ halign: "start" }}
          />
        ) : (
          <box orientation="vertical" spacing={Spacing.xs}>
            {siteDecisions.map((row) => (
              <box key={row.type} orientation="horizontal" spacing={Spacing.sm}>
                <label
                  testID={`${p}site-permission-${row.type}`}
                  text={`${permissionName(row.type)}: ${row.decision === "allow" ? "Allowed" : "Blocked"}`}
                  ellipsize
                  style={{ halign: "start", hexpand: true }}
                />
              </box>
            ))}
            <button
              testID={`${p}site-permissions-reset`}
              label="Reset Permissions"
              cssClasses={["flat"]}
              onClick={() => ctx.resetSiteDecisions(activeOrigin)}
            />
          </box>
        )}
      </box>
    );
  }

  function closeSiteInfo(): void {
    setSiteInfoOpen(false);
    // Escape and a click outside are a dismissal, and a dismissed request is
    // denied rather than left pending.
    ctx.denyPromptsFor(active.id);
  }

  /// The sidebar's padlock: a button in its foot, so the popover opens upward
  /// and stays inside the window. Opened downward GTK shrinks one to the room
  /// left under the window and then closes it for being under its minimum
  /// size. Compact draws the padlock inside the address field instead
  /// (`leadingIconName`).
  function siteInfoControl(): React.ReactNode {
    return (
      <>
        {/* One indicator, updated in place. The state rides the testID
            because getTree exposes a node's text but never its icon
            name, so that is the only way a drive can assert which
            padlock is drawn; it must NOT ride a `key`, which remounts
            the button. The padlock is Chrome's site-info button: what
            this page is allowed to do hangs off it, and so does a
            permission the page is asking for right now. Boxed because a
            popover anchors on its tree parent. */}
        <box testID={`${p}site-info-anchor`} orientation="horizontal">
          <button
            testID={`${p}security-${activeRt.security}`}
            iconName={SECURITY_ICON[activeRt.security]}
            tooltip={SECURITY_TOOLTIP[activeRt.security]}
            cssClasses={["flat"]}
            onClick={() => (siteInfoOpen ? setSiteInfoOpen(false) : openPanel("siteInfo"))}
          />
          <popover testID={`${p}site-info-popover`} open={siteInfoOpen} position="top" onClosed={closeSiteInfo}>
            {siteInfoPanel()}
          </popover>
        </box>
      </>
    );
  }

  function windowMenu(slot?: "end"): React.ReactNode {
    return (
      <>
        {/* The menu bar lives in the first window. Every other window
            carries its own menu for what acts on THAT window, moving
            its tab above all, which a drag must never be the only way
            to do. */}
        {!first && (
          <menubutton slot={slot} testID={`${p}window-menu`} iconName="open-menu-symbolic" tooltip="Main Menu">
            <menuitem testID={`${p}menu-new-tab`} label="New Tab" onSelect={() => openPalette("", "new-tab")} />
            <menuitem testID={`${p}menu-new-window`} label="New Window" onSelect={ctx.newWindow} />
            <menuitem testID={`${p}menu-close-tab`} label="Close Tab" onSelect={() => ctx.closeTab(active.id)} />
            <menuitem
              testID={`${p}menu-sleep-tab`}
              label="Put Tab to Sleep"
              enabled={ctx.canSleep(active.id)}
              onSelect={() => ctx.sleepTab(active.id)}
            />
            <menuitem role="separator" testID={`${p}menu-sep-move`} />
            {moveItems(`${p}menu-`, win, targets)}
            <menuitem role="separator" testID={`${p}menu-sep`} />
            <menuitem testID={`${p}menu-find`} label="Find in Page" onSelect={() => ctx.openFind(active.id)} />
            <menuitem testID={`${p}menu-downloads`} label="Downloads" onSelect={() => openPanel("downloads")} />
            <menuitem testID={`${p}menu-settings`} label="Settings" onSelect={ctx.openSettings} />
          </menubutton>
        )}
      </>
    );
  }

  function extensionControls(slot?: "end"): React.ReactNode {
    return (
      <>
        {/* Chrome's extensions area: the pinned actions, then the puzzle
            piece that lists everything installed. Each pinned action is
            boxed with its own popover so the popup opens under the button
            that was clicked; an unpinned one opens under the puzzle. */}
        {chromium &&
          pinnedActions.map((row) => {
            const live = actionState(row.id);
            return (
              <box slot={slot} key={row.id} testID={`${p}ext-pin-${row.id}`} orientation="horizontal">
                {/* The badge floats over the icon's top corner, where
                    Chrome draws it, rather than widening the button. */}
                <overlay testID={`${p}ext-action-stack-${row.id}`}>
                  <button
                    testID={`${p}ext-action-${row.id}`}
                    iconData={row.iconData || undefined}
                    iconName="application-x-addon-symbolic"
                    tooltip={popupTooltip(row)}
                    cssClasses={["flat"]}
                    enabled={row.enabled && row.popupUrl !== "" && ctx.checkingAction !== row.id}
                    onClick={() => openExtensionPopup(row)}
                  />
                  {live?.badgeText ? (
                    <badge
                      testID={`${p}ext-badge-${row.id}`}
                      label={live.badgeText}
                      variant={badgeVariant(live.badgeColor)}
                      style={{ halign: "end", valign: "start" }}
                    />
                  ) : null}
                </overlay>
                <popover
                  testID={`${p}ext-popup-${row.id}`}
                  open={popupId === row.id}
                  position={slot ? "bottom" : "top"}
                  onClosed={closeExtensionPopup}
                >
                  {popupId === row.id ? extensionPopup(row) : <box orientation="horizontal" />}
                </popover>
              </box>
            );
          })}
        {chromium && (
          <box slot={slot} testID={`${p}extensions-anchor`} orientation="horizontal">
            <button
              testID={`${p}extensions-button`}
              iconName="application-x-addon-symbolic"
              tooltip="Extensions"
              cssClasses={["flat"]}
              onClick={() => (extensionsOpen ? setExtensionsOpen(false) : openExtensionsList())}
            />
            <popover
              testID={`${p}extensions-popover`}
              open={extensionsOpen}
              position={slot ? "bottom" : "top"}
              onClosed={() => setExtensionsOpen(false)}
            >
              <box
                testID={`${p}extensions-panel`}
                orientation="vertical"
                spacing={Spacing.sm}
                style={{ padding: Spacing.sm, minWidth: EXTENSIONS_PANEL_WIDTH }}
              >
                <label text="Extensions" cssClasses={["heading"]} style={{ halign: "start" }} />
                {rows.length === 0 ? (
                  <label
                    testID={`${p}extensions-empty`}
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
                        testID={`${p}ext-row-${row.id}`}
                        label={row.name}
                        iconData={row.iconData || undefined}
                        iconName="application-x-addon-symbolic"
                        labelAlign="start"
                        ellipsize
                        tooltip={popupTooltip(row)}
                        cssClasses={["flat"]}
                        enabled={row.enabled && row.popupUrl !== ""}
                        style={{ hexpand: true }}
                        onClick={() => openExtensionPopup(row)}
                      />
                      <togglebutton
                        testID={`${p}ext-pin-toggle-${row.id}`}
                        iconName="view-pin-symbolic"
                        tooltip={prefs.pinnedExtensions.includes(row.id) ? "Unpin from toolbar" : "Pin to toolbar"}
                        active={prefs.pinnedExtensions.includes(row.id)}
                        cssClasses={["flat"]}
                        style={{ valign: "center" }}
                        onToggled={() => ctx.pinExtension(row.id)}
                      />
                    </box>
                  ))
                )}
                <button
                  testID={`${p}extensions-manage`}
                  label="Manage Extensions"
                  cssClasses={["flat"]}
                  onClick={() => {
                    setExtensionsOpen(false);
                    ctx.openTab(win.id, "chrome://extensions");
                  }}
                />
                {/* Test-only: the drive has no other way in. `nd dev` and
                    a packaged run both take extensions from the Web Store
                    or the command line, and launchApp passes no argv. */}
                {TEST_HOOKS && (
                  <button
                    testID={`${p}extensions-install-test`}
                    label="Install the test extension"
                    cssClasses={["flat"]}
                    onClick={() => ctx.installTestExtension(process.env.NB_TEST_EXT)}
                  />
                )}
                {TEST_HOOKS && (
                  <button
                    testID={`${p}extensions-install-action-test`}
                    label="Install the action test extension"
                    cssClasses={["flat"]}
                    onClick={() => ctx.installTestExtension(process.env.NB_TEST_EXT_ACTION)}
                  />
                )}
              </box>
            </popover>
            {/* An unpinned action has no button of its own, so its popup
                hangs off the puzzle piece it was opened from. */}
            <popover
              testID={`${p}ext-popup-unpinned`}
              open={unpinnedPopup !== null}
              position={slot ? "bottom" : "top"}
              onClosed={closeExtensionPopup}
            >
              {unpinnedPopup ? extensionPopup(unpinnedPopup) : <box orientation="horizontal" />}
            </popover>
          </box>
        )}
      </>
    );
  }

  function downloadsControl(slot?: "end"): React.ReactNode {
    return (
      <>
        {/* A popover anchors on its TREE parent on both backends, and a
            header bar's own handle never joins a view hierarchy, so the
            button it hangs off has to be boxed. */}
        <box slot={slot} testID={`${p}downloads-anchor`} orientation="horizontal">
          <button
            testID={`${p}downloads-button`}
            iconName="folder-download-symbolic"
            tooltip="Downloads"
            cssClasses={["flat"]}
            onClick={() => (downloadsOpen ? setDownloadsOpen(false) : openPanel("downloads"))}
          />
          <popover
            testID={`${p}downloads-popover`}
            open={downloadsOpen}
            position={slot ? "bottom" : "top"}
            onClosed={() => setDownloadsOpen(false)}
          >
            {/* Stacked boxes rather than a list widget: a popover sizes
                itself from what it contains, and every list widget here
                is a scroll view, which contributes no height at all. */}
            <box
              testID={`${p}downloads-panel`}
              orientation="vertical"
              spacing={Spacing.sm}
              style={{ padding: Spacing.sm, minWidth: DOWNLOADS_PANEL_WIDTH }}
            >
              <label text="Downloads" cssClasses={["heading"]} style={{ halign: "start" }} />
              {recentDownloads.length === 0 ? (
                <label
                  testID={`${p}downloads-empty`}
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
                        testID={`${p}downloads-item-${d.id}`}
                        text={d.name}
                        ellipsize
                        // Filled, not started: an ellipsizing label asks for
                        // one character on GTK and takes the row's width only
                        // when it is allowed to fill it.
                        style={{ halign: "fill" }}
                      />
                      <label
                        testID={`${p}downloads-status-${d.id}`}
                        text={downloadStatus(d)}
                        cssClasses={["dimmed", "caption"]}
                        style={{ halign: "start" }}
                      />
                    </box>
                    {/* Only once the transfer has produced a file. */}
                    {d.state === "done" && (
                      <button
                        testID={`${p}downloads-reveal-${d.id}`}
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
                testID={`${p}downloads-folder`}
                label="Open Downloads Folder"
                cssClasses={["flat"]}
                onClick={() => void openPath(downloadDir()).catch(() => {})}
              />
            </box>
          </popover>
        </box>
      </>
    );
  }

  // The menu bar acts on the FOCUSED window, whichever window draws it: its
  // accelerators are the app's, not this window's.
  const menuWin = ctx.session.windows.find((w) => w.id === ctx.focusedWindowId) ?? win;
  const menuActive = menuWin.tabs.find((t) => t.id === menuWin.activeId) ?? menuWin.tabs[0]!;
  const menuRt = ctx.rt(menuActive.id);
  const menuTarget = (): WindowController | undefined => ctx.controllerFor(menuWin.id);

  return (
    <window
      title={pageTitle}
      testID={first ? "main-window" : `${p}window`}
      defaultWidth={win.width}
      defaultHeight={win.height}
      onFocused={(e) => ctx.onWindowFocused(win.id, e.checked)}
      onClosed={() => ctx.onWindowClosed(win.id)}
      onSizeChanged={(e) => {
        const { width, height } = e.data as { width: number; height: number };
        ctx.onWindowSize(win.id, width, height);
      }}
    >
      {first && (
        <menubar defaults testID="menubar">
          <menu label="File" testID="menu-file">
            <menuitem
              testID="menu-new-tab"
              label="New Tab"
              accelerator={KEYS["new-tab"]}
              onSelect={() => menuTarget()?.openPalette("", "new-tab")}
            />
            <menuitem testID="menu-new-window" label="New Window" accelerator={KEYS["new-window"]} onSelect={ctx.newWindow} />
            <menuitem
              testID="menu-private-window"
              label="New Private Window"
              accelerator={KEYS.private}
              onSelect={ctx.openPrivate}
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
              onSelect={() => ctx.closeTab(menuActive.id)}
            />
            <menuitem
              testID="menu-reopen-tab"
              label="Reopen Closed Tab"
              accelerator={KEYS["reopen-tab"]}
              onSelect={() => ctx.reopenTab(menuWin.id)}
            />
            <menuitem role="separator" testID="menu-file-sep" />
            <menuitem testID="menu-settings" label="Settings" accelerator={KEYS.settings} onSelect={ctx.openSettings} />
          </menu>
          <menu label="Edit" testID="menu-edit">
            <menuitem
              testID="menu-find"
              label="Find in Page"
              accelerator={KEYS.find}
              onSelect={() => ctx.openFind(menuActive.id)}
            />
            <menuitem
              testID="menu-find-next"
              label="Find Next"
              accelerator={KEYS["find-next"]}
              onSelect={() => ctx.findCommand(menuActive.id, "findNext")}
            />
            <menuitem
              testID="menu-find-previous"
              label="Find Previous"
              accelerator={KEYS["find-previous"]}
              onSelect={() => ctx.findCommand(menuActive.id, "findPrevious")}
            />
          </menu>
          <menu label="View" testID="menu-view">
            <menuitem
              testID="menu-reload"
              label="Reload"
              accelerator={KEYS.reload}
              onSelect={() => ctx.command(menuActive.id, "reload")}
            />
            {!compact && (
              <menuitem
                testID="menu-toggle-sidebar"
                label={sidebarHidden && menuWin.id === win.id ? "Show Sidebar" : "Hide Sidebar"}
                accelerator={KEYS["toggle-sidebar"]}
                onSelect={() => menuTarget()?.toggleSidebar()}
              />
            )}
            {/* Chromium binds most ctrl and ctrl+shift letters, and password
                managers take ctrl+shift+l and ctrl+shift+x. primary+shift+comma
                never fired from the address field on X11, where GTK sees the
                key as less. */}
            <menuitem
              testID="menu-layout"
              label={compact ? "Use Sidebar Layout" : "Use Compact Layout"}
              accelerator={KEYS.layout}
              onSelect={() => ctx.setLayout(compact ? "sidebar" : "compact")}
            />
            <menuitem testID="menu-downloads" label="Downloads" onSelect={() => menuTarget()?.openDownloads()} />
            <menuitem role="separator" testID="menu-view-sep" />
            <menuitem
              testID="menu-zoom-in"
              label="Zoom In"
              accelerator={KEYS["zoom-in"]}
              onSelect={() => ctx.zoomStep(menuActive.id, 1)}
            />
            <menuitem
              testID="menu-zoom-out"
              label="Zoom Out"
              accelerator={KEYS["zoom-out"]}
              onSelect={() => ctx.zoomStep(menuActive.id, -1)}
            />
            <menuitem
              testID="menu-zoom-reset"
              label="Reset Zoom"
              accelerator={KEYS["zoom-reset"]}
              onSelect={() => ctx.zoomStep(menuActive.id, 0)}
            />
          </menu>
          <menu label="Tabs" testID="menu-tabs">
            <menuitem
              testID="menu-next-tab"
              label="Next Tab"
              accelerator={KEYS["next-tab"]}
              onSelect={() => ctx.cycleTab(menuWin.id, 1)}
            />
            <menuitem
              testID="menu-prev-tab"
              label="Previous Tab"
              accelerator={KEYS["prev-tab"]}
              onSelect={() => ctx.cycleTab(menuWin.id, -1)}
            />
            <menuitem
              testID="menu-pin-tab"
              label={menuActive.pinned ? "Unpin Tab" : "Pin Tab"}
              onSelect={() => ctx.setPinned(menuActive.id, !menuActive.pinned)}
            />
            <menuitem
              testID="menu-sleep-tab"
              label="Put Tab to Sleep"
              enabled={ctx.canSleep(menuActive.id)}
              onSelect={() => ctx.sleepTab(menuActive.id)}
            />
            {moveItems("menu-", menuWin, ctx.moveTargets(menuWin.id))}
            <menuitem role="separator" testID="menu-tabs-sep" />
            {menuWin.tabs.map((t, i) => (
              <menuitem key={t.id} testID={`menu-tab-${i}`} label={tabLabel(t)} onSelect={() => ctx.selectTab(t.id)} />
            ))}
          </menu>
          <menu label="Go" testID="menu-go">
            <menuitem
              testID="menu-back"
              label="Back"
              accelerator={KEYS.back}
              enabled={menuRt.canGoBack}
              onSelect={() => ctx.command(menuActive.id, "goBack")}
            />
            <menuitem
              testID="menu-forward"
              label="Forward"
              accelerator={KEYS.forward}
              enabled={menuRt.canGoForward}
              onSelect={() => ctx.command(menuActive.id, "goForward")}
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
                onSelect={() => ctx.runTestJs(menuActive.id)}
              />
              {/* Enter in the address field is a keystroke, and GTK synthesises
                  none (-32003). This runs the handler that keystroke runs, on
                  the text the field is actually holding. */}
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
              {/* The compact padlock is an icon inside the field, not a
                  widget automation can click; this fires it the way a
                  pointer press does. */}
              <menuitem
                testID="menu-site-info"
                label="Open site information"
                onSelect={() => menuTarget()?.pressPadlock()}
              />
              <menuitem
                testID="menu-commit-address"
                label="Commit the address field"
                onSelect={() => menuTarget()?.commitAddress()}
              />
              {/* Esc in the command bar, for the same reason. */}
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
                  ctx.onContextMenuItem(menuActive.id, {
                    id: "nb-search-selection",
                    pageUrl: menuActive.url,
                    selectionText: "selected words",
                    editable: false,
                  })
                }
              />
            </menu>
          )}
          {chromium && (
            <menu label="Extensions" testID="menu-extensions">
              <menuitem
                testID="menu-extensions-page"
                label="Extensions"
                onSelect={() => ctx.openTab(menuWin.id, "chrome://extensions")}
              />
              <menuitem
                testID="menu-webstore"
                label="Chrome Web Store"
                onSelect={() => ctx.openTab(menuWin.id, "https://chromewebstore.google.com")}
              />
            </menu>
          )}
          <menu label="History" testID="menu-history">
            {ctx.history.length === 0 ? (
              <menuitem testID="menu-history-empty" label="No History Yet" enabled={false} />
            ) : (
              ctx.history.map((v, i) => (
                <menuitem
                  key={v.url}
                  testID={`menu-history-${i}`}
                  label={v.title || displayUrl(v.url)}
                  onSelect={() => ctx.openTab(menuWin.id, v.url)}
                />
              ))
            )}
          </menu>
        </menubar>
      )}

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
          collapsed={!compact && sidebarHidden}
          edgeReveal={!compact}
          // AppKit's glass sidebar reflects the page beside it, so the page
          // runs to the window's edges there, as in Search; libadwaita keeps
          // it in an inset card on the sidebar's colour.
          contentStyle={compact || !gtk ? "plain" : "card"}
          testID={`${p}split`}
          onRevealChanged={(e) => setRevealed(e.checked)}
        >
          {!compact && (
            <Sidebar
              p={p}
              tabs={tabs}
              activeId={active.id}
              loading={activeRt.loading}
              labelFor={tabLabel}
              addressFor={(t) => displayUrl(t.url) || "New Tab"}
              iconFor={faviconFor}
              pinStyle={ctx.prefs.pinStyle}
              asleep={ctx.asleep}
              siteInfo={siteInfoControl()}
              zoom={
                <ZoomFootControl
                  open={zoomPopover.open && !sidebarHidden}
                  factor={zoomFactor}
                  prefix={p}
                  onToggle={zoomPopover.toggle}
                  onStep={(direction) => ctx.setZoom(active.id, stepZoom(zoomFactor, direction))}
                  onReset={() => ctx.setZoom(active.id, 1)}
                  onClosed={zoomPopover.close}
                />
              }
              extensions={extensionControls()}
              downloads={downloadsControl()}
              windowMenu={windowMenu()}
              onSelect={selectTab}
              onClose={ctx.closeTab}
              onNewTab={() => ctx.openTab(win.id, "")}
              onOpenAddress={openAddress}
              onOpenSettings={ctx.openSettings}
              dragPayload={(t) => tabPayload({ profile: "default", tabId: t.id, url: t.url })}
              dropIndex={dropIndex}
              onDragOverIndex={(index) => {
                if (TEST_HOOKS) console.error(`ND_APP DRAG over index=${index}`);
                ctx.setDropHint(win.id, index);
              }}
              onDropAt={(payload, index, pinned) => {
                if (TEST_HOOKS) console.error(`ND_APP DRAG drop index=${index} pinned=${pinned}`);
                const drag = parseTabPayload(payload);
                // Landing in the other section is what pins or unpins a tab.
                if (drag?.profile === "default") {
                  const tab = ctx.session.windows.flatMap((w) => w.tabs).find((t) => t.id === drag.tabId);
                  if (tab && tab.pinned !== pinned) ctx.setPinned(tab.id, pinned);
                }
                ctx.onTabDropped(win.id, payload, index);
              }}
              onDragStart={(payload) => {
                if (TEST_HOOKS) console.error("ND_APP DRAG start");
                ctx.onDragStart(payload);
              }}
              onDragEnd={ctx.onDragEnd}
            />
          )}

          {/* With the sidebar hidden the page is immersive: the strip slides
              away over it and comes back while the pointer is at the top
              edge, and the page never moves for it (topBarsAutoHide). */}
          <toolbarview
            ref={contentBars}
            slot="content"
            testID={`${p}content-toolbar`}
            topBarsAutoHide={!compact && gtk && sidebarHidden && trailingControls}
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
            {!compact && gtk && (
              <Activity mode={trailingControls ? "visible" : "hidden"}>
                <box slot="top" testID={`${p}controls-strip`} orientation="horizontal" windowHandle style={{ padding: INSET }}>
                  <box orientation="horizontal" style={{ hexpand: true }} />
                  <windowcontrols
                    testID={`${p}controls-end`}
                    side="end"
                    style={{ valign: "center" }}
                    onEmptyChanged={(e) => setTrailingControls(!e.checked)}
                  />
                </box>
              </Activity>
            )}
            {compact && (
            <headerbar
              testID={`${p}chrome`}
              title=""
              canGoBack={activeRt.canGoBack}
              canGoForward={activeRt.canGoForward}
              onBack={() => ctx.command(active.id, "goBack")}
              onForward={() => ctx.command(active.id, "goForward")}
            >
              {/* One icon for both directions: Adwaita's sidebar-hide glyph has
                  no SF Symbol behind it, so the state rides the tooltip. In
                  compact it joins the trailing controls, so the row starts
                  where the reference's does: back, forward, reload, tabs. */}
              <button
                slot="start"
                testID={`${p}reload`}
                iconName={activeRt.loading ? "process-stop-symbolic" : "view-refresh-symbolic"}
                tooltip={activeRt.loading ? "Stop" : "Reload"}
                cssClasses={["flat"]}
                onClick={() => ctx.command(active.id, activeRt.loading ? "stop" : "reload")}
              />

              {/* Compact puts the tabs in the row itself, between reload and
                  the address field, and nothing below it. */}
              {compact && (
                <CompactTabs
                  tabs={tabs}
                  activeId={active.id}
                  metrics={tabMetrics}
                  prefix={p}
                  iconFor={faviconFor}
                  labelFor={tabLabel}
                  addressFor={(t) => displayUrl(t.url) || "New Tab"}
                  asleep={ctx.asleep}
                  onSelect={selectTab}
                  onClose={ctx.closeTab}
                  dragPayload={(t) => tabPayload({ profile: "default", tabId: t.id, url: t.url })}
                  dropIndex={dropIndex}
                  onDragOverIndex={(index) => ctx.setDropHint(win.id, index)}
                  onDropAt={(payload, index) => ctx.onTabDropped(win.id, payload, index)}
                  onDragStart={ctx.onDragStart}
                  onDragEnd={ctx.onDragEnd}
                />
              )}
              {compact && (
                <button
                  slot="start"
                  testID={`${p}header-new-tab`}
                  // A bare plus, not the boxed tab glyph: in one row of tabs
                  // the boxed one reads as a sixth tab.
                  iconName="list-add-symbolic"
                  tooltip="New Tab"
                  cssClasses={["flat"]}
                  onClick={() => ctx.openTab(win.id, "")}
                />
              )}

              {/* Compact is a standard browser row: the address is an editable
                  field in it, and it takes whatever the row has left: the
                  host makes a search entry packed straight into a header bar
                  its title and fills the run between the start and end packs.
                  Wrapping it in a box loses that. Typing and Enter commit
                  from the field; ⌘L opens the command bar in both layouts.
                  The padlock is the field's own leading icon, Chrome's site
                  information button, and the panel hangs off the icon. */}
              <searchinput
                // The ref object itself, not a callback: React detaches and
                // re-attaches a fresh callback ref on every commit, and the
                // zoom popover's anchorRef reads this ref mid-commit.
                ref={addressField}
                testID={`${p}omnibox`}
                text={shownUrl}
                placeholder="Search or enter address"
                leadingIconName={SECURITY_ICON[activeRt.security]}
                leadingIconTooltip={SECURITY_TOOLTIP[activeRt.security]}
                leadingIconLabel="Site information"
                onLeadingIconClicked={() => (siteInfoOpen ? setSiteInfoOpen(false) : openPanel("siteInfo"))}
                style={{ hexpand: true, minWidth: ADDRESS_MIN_WIDTH }}
                // A ref, not state: feeding a keystroke back into the
                // controlled `text` prop makes the host's set_text race the
                // entry and blank it.
                onChanged={(e) => (typedAddress.current = e.text)}
                onActivate={(e) => commitQuery(e.text, "current")}
                {...zoomFieldProps(zoomFactor, zoomPopover.open, zoomPopover.toggle)}
              />
              <ZoomPopover
                anchor={addressField}
                open={zoomPopover.open}
                factor={zoomFactor}
                prefix={p}
                onStep={(direction) => ctx.setZoom(active.id, stepZoom(zoomFactor, direction))}
                onReset={() => ctx.setZoom(active.id, 1)}
                onClosed={zoomPopover.close}
              />
              {createPortal(
                <popover
                  testID={`${p}site-info-popover`}
                  anchorRef={addressField}
                  anchorSlot="leadingIcon"
                  open={siteInfoOpen}
                  position="bottom"
                  onClosed={closeSiteInfo}
                >
                  {siteInfoPanel()}
                </popover>,
              )}

              {/* A narrow row gives this one up first: the View menu and the
                  chord switch layouts too. */}
              {compact && win.width >= LAYOUT_BUTTON_WIDTH && (
                <button
                  slot="end"
                  testID={`${p}layout-toggle`}
                  iconName="sidebar-show-symbolic"
                  tooltip="Use Sidebar Layout"
                  cssClasses={["flat"]}
                  onClick={() => ctx.setLayout("sidebar")}
                />
              )}

              {extensionControls("end")}

              {downloadsControl("end")}

              {/* Last in the row, where the first window's menu bar puts its
                  own button. */}
              {windowMenu("end")}
            </headerbar>
            )}

            <box testID={`${p}content`} orientation="vertical" spacing={0} style={{ hexpand: true, vexpand: true }}>
              {/* Presents over the active window wherever it is mounted. */}
              <commandpalette
                testID={`${p}palette`}
                open={paletteOpen}
                placeholder={paletteMode === "switcher" ? "Switch to a tab or run a command" : "Search or enter address"}
                query={paletteSeed}
                items={paletteItems}
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
              <overlay testID={`${p}page-stack`} style={{ hexpand: true, vexpand: true }}>
                {/* Where this window's tabs' pages are shown. The root moves
                    each live `<webview>` in here (moveNode); nothing React
                    renders is a child of it, so no render of this window can
                    reorder or remove a page. Only the active tab's view is
                    visible. */}
                <box
                  ref={(node) => ctx.registerSlot(win.id, node as NdNodeRef<"box"> | null)}
                  testID={`${p}view-slot`}
                  orientation="vertical"
                  style={{ hexpand: true, vexpand: true }}
                />

                {activeRt.error !== null && (
                  <statuspage
                    testID={`${p}error-page`}
                    iconName="network-error-symbolic"
                    title="Unable to load this page"
                    description={`${displayUrl(activeRt.error.url)}: ${activeRt.error.error}`}
                    style={{ hexpand: true, vexpand: true }}
                  >
                    <button
                      testID={`${p}retry`}
                      label="Try Again"
                      cssClasses={["suggested-action", "pill"]}
                      onClick={() => ctx.retry(active.id)}
                    />
                  </statuspage>
                )}

                {/* A new tab has no webview at all, so this native page is
                    all the content area shows: a GTK widget cannot be seen
                    over the engine's own X11 child window, and there is none
                    here to be under. */}
                {active.url === "" && (
                  <box testID={`${p}new-tab-page`} orientation="vertical" style={{ hexpand: true, vexpand: true }}>
                    <box
                      orientation="vertical"
                      spacing={Spacing.sm}
                      style={{ halign: "center", valign: "center", vexpand: true }}
                    >
                      {/* Not a second address field: the command bar is the
                          only place an address is typed, and this opens it. */}
                      <button
                        testID={`${p}new-tab-search`}
                        label="Search or enter address"
                        iconName="system-search-symbolic"
                        cssClasses={["pill"]}
                        onClick={() => openPalette("", "current")}
                      />
                      <box orientation="horizontal" spacing={Spacing.xs} style={{ halign: "center" }}>
                        <image iconName="system-search-symbolic" symbolScale="small" cssClasses={["dimmed"]} />
                        <label
                          testID={`${p}new-tab-engine`}
                          text={`Search with ${engineOf(prefs.searchEngine).name}`}
                          cssClasses={["dimmed", "caption"]}
                        />
                      </box>
                    </box>
                  </box>
                )}

                {loadBar()}

                {first && ctx.hiddenViews}

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
                  testID={`${p}find-anchor`}
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
                    <popover testID={`${p}find-popover`} open position="bottom" onClosed={() => ctx.closeFind(active.id)}>
                      <box
                        testID={`${p}find-bar`}
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
                            if (!node) return;
                            if (findFocused.current === node.id) return;
                            findFocused.current = node.id;
                            sendCommand(node as NdNodeRef<"searchinput">, "focus");
                          }}
                          testID={`${p}find-query`}
                          placeholder="Find in Page"
                          cssClasses={findFailed(find) ? ["error"] : []}
                          style={{ hexpand: true }}
                          onChanged={(e) => ctx.runFind(active.id, e.text)}
                          onActivate={() => ctx.findCommand(active.id, "findNext")}
                        />
                        <label
                          key={`${find.query}:${find.count}:${find.found}`}
                          testID={`${p}find-count`}
                          text={findSummary(find)}
                          cssClasses={["dimmed", "numeric"]}
                        />
                        <button
                          testID={`${p}find-previous`}
                          iconName="go-up-symbolic"
                          tooltip="Previous match"
                          cssClasses={["flat"]}
                          onClick={() => ctx.findCommand(active.id, "findPrevious")}
                        />
                        <button
                          testID={`${p}find-next`}
                          iconName="go-down-symbolic"
                          tooltip="Next match"
                          cssClasses={["flat"]}
                          onClick={() => ctx.findCommand(active.id, "findNext")}
                        />
                        {/* Escape closes the popover, which is what fires
                            onClosed; the button is the same exit for a
                            pointer. */}
                        <button
                          testID={`${p}find-close`}
                          iconName="window-close-symbolic"
                          tooltip="Close"
                          cssClasses={["flat"]}
                          onClick={() => ctx.closeFind(active.id)}
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
  );
}
