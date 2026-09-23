// One normal browser window: its toolbar, its tab list and the slot its tabs'
// pages are shown in. The pages themselves are not children of this tree: the
// app root keeps every tab's `<webview>` in the framework's off-window pool and
// moves the live widget into whichever window's slot shows it, which is what
// lets a tab change windows without its page reloading. Everything keyed by
// tab lives at the root for the same reason; what lives here is the state of
// this window's own chrome (palette, popovers, the popup an action opened).
import {
  Spacing,
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
import type {
  ContextMenuItemClick,
  ExtensionActionState,
  NdNodeRef,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";

import { ADDRESS_MIN_WIDTH, CompactTabs, tabRunMetrics } from "./CompactTabs.tsx";
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
import { searchHistory, type Visit } from "./lib/history.ts";
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
import { SEARCH_ENGINES, engineOf, type Layout, type SettingsState } from "./lib/settings.ts";
import { tabPayload } from "./lib/tabdrag.ts";
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
import { displayUrl, hostOf, isSearch, toUrl } from "./lib/url.ts";

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

export const TEST_HOOKS = process.env.NB_TEST_HOOKS === "1";

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
  { id: "new-window", title: "New Window", hint: "Ctrl+N", iconName: "window-new-symbolic" },
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

/// The extensions panel. Wide enough for a name beside its pin toggle, and
/// fixed so the panel does not resize as extensions come and go.
const EXTENSIONS_PANEL_WIDTH = 300;

/// The site-info panel, sized for a permission sentence rather than for the
/// shortest thing it ever holds.
const SITE_PANEL_WIDTH = 320;

/// The new tab page's field. Wide enough to read a long address back in,
/// narrow enough to stay a field rather than a banner across the window.
const NEW_TAB_FIELD_WIDTH = 480;

/// What the root asks of a window's own chrome. The menu bar belongs to one
/// window and acts on whichever window is focused, so it reaches the others'
/// palette, address field and popovers through these.
export interface WindowController {
  openPalette(seed: string): void;
  openAddress(): void;
  /// Test-only: runs what Enter in the address field runs, on what the field
  /// is holding.
  commitAddress(): void;
  openDownloads(): void;
  openSiteInfo(): void;
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
  reopenTab(windowId: string): void;
  cycleTab(windowId: string, step: number): void;
  navigate(tabId: string, raw: string): void;
  retry(tabId: string): void;
  command(tabId: string, name: "goBack" | "goForward" | "reload" | "stop"): void;
  zoomFor(url: string): number;
  setZoom(tabId: string, next: number): void;
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
  /// The palette widget's key; see openPalette for why an unchanged seed has
  /// to rebuild the widget rather than re-apply a prop.
  const [paletteEpoch, setPaletteEpoch] = useState(0);
  const [historyHits, setHistoryHits] = useState<Visit[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  /// The action whose popup is open, "" for none, and the address it was
  /// mounted at: the one Chromium reported at the click, which an extension
  /// can change at runtime away from the manifest's.
  const [popupId, setPopupId] = useState("");
  const [popupUrl, setPopupUrl] = useState("");
  const [popupSize, setPopupSize] = useState({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });

  const toast = useRef<NdNodeRef<"toastoverlay">>(null);
  /// The find field the app has already put the caret in. An inline ref
  /// callback runs on every render, and focusing on each one would fight the
  /// user for the caret.
  const findFocused = useRef(0);
  /// The header's address field, so Ctrl+L can put the caret in it without a
  /// render-time focus that would fight the user for it every frame. Both
  /// backends select the contents on grab-focus, which is what Ctrl+L means.
  const omnibox = useRef<NdNodeRef<"searchinput"> | null>(null);
  /// What is in the address field right now. Only a test hook reads it: a
  /// person presses Enter, which carries the text with it.
  const typedAddress = useRef("");
  /// The new tab page's own field, guarded by widget id so the caret is placed
  /// once per field rather than on every render.
  const newTabFocused = useRef(0);
  /// The open popup's view, and the id of the one whose window.close the app
  /// has already hooked.
  const popupView = useRef<NdNodeRef<"webview"> | null>(null);
  const popupHooked = useRef(0);

  const activeRt = ctx.rt(active.id);
  const find = ctx.findFor(active.id);
  const compact = prefs.layout === "compact";

  ctx.registerController(win.id, {
    openPalette,
    openAddress,
    commitAddress: () => commitQuery(typedAddress.current),
    openDownloads: () => setDownloadsOpen(true),
    openSiteInfo: () => setSiteInfoOpen(true),
    showPopup: (id, url) => {
      setExtensionsOpen(false);
      setPopupSize({ width: POPUP_DEFAULT_WIDTH, height: POPUP_DEFAULT_HEIGHT });
      setPopupUrl(url);
      setPopupId(id);
    },
    toast: (title) => {
      if (toast.current) void showToast(toast.current, { title });
    },
  });

  function openPalette(seed: string): void {
    // Seeding "" over a seed that is already "" changes nothing, and the entry
    // keeps whatever was last typed into it, so the palette would come up
    // holding the last query. Bumping the key rebuilds the widget, which is
    // the only way an unchanged seed can still mean an empty field. It is
    // also what makes the palette present on AppKit: an `open` update on a
    // widget that already exists does nothing there, while one created open
    // presents (measured on the bundled CEF host, legs 2 to 4).
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

  /// Ctrl+L, and the padlock's "type an address" path. Grab-focus selects the
  /// contents on both backends, so the URL comes up ready to be typed over.
  function openAddress(): void {
    const node = omnibox.current;
    if (!node) return;
    sendCommand(node, "focus");
    if (TEST_HOOKS) console.error("ND_APP FOCUS target=omnibox");
  }

  function commitQuery(raw: string): void {
    closePalette();
    ctx.navigate(active.id, raw);
  }

  function selectTab(id: string): void {
    setSiteInfoOpen(false);
    ctx.selectTab(id);
  }

  function runPaletteItem(id: string): void {
    closePalette();
    if (id === "url") return commitQuery(paletteQuery);
    if (id.startsWith("tab:")) return selectTab(id.slice(4));
    if (id.startsWith("hist:")) return ctx.navigate(active.id, id.slice(5));
    switch (id.slice(4)) {
      case "new-tab":
        ctx.openTab(win.id, "");
        return;
      case "new-window":
        return ctx.newWindow();
      case "close-tab":
        return ctx.closeTab(active.id);
      case "reopen-tab":
        return ctx.reopenTab(win.id);
      case "reload":
        return ctx.command(active.id, "reload");
      case "find":
        return ctx.openFind(active.id);
      case "downloads":
        return setDownloadsOpen(true);
      case "layout":
        return ctx.setLayout(compact ? "sidebar" : "compact");
      case "private":
        return ctx.openPrivate();
      case "settings":
        return ctx.openSettings();
      case "zoom-in":
        return ctx.setZoom(active.id, ctx.zoomFor(active.url) + 0.1);
      case "zoom-out":
        return ctx.setZoom(active.id, ctx.zoomFor(active.url) - 0.1);
      case "zoom-reset":
        return ctx.setZoom(active.id, 1);
      case "extensions":
        ctx.openTab(win.id, "chrome://extensions");
        return;
      case "webstore":
        ctx.openTab(win.id, "https://chromewebstore.google.com");
        return;
    }
  }

  // ------------------------------------------------------ extensions ---

  function openExtensionsList(): void {
    ctx.refreshExtensions();
    setExtensionsOpen(true);
  }

  /// A second click on the action that is already open closes it, which is
  /// what Chrome's own toolbar button does. Anything else is decided at the
  /// root, on the action's live state.
  function openExtensionPopup(row: ExtensionRow): void {
    setExtensionsOpen(false);
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
  const tabMetrics = tabRunMetrics(win.width, tabs, pinnedActions.length);
  const targets = ctx.moveTargets(win.id);
  const dropIndex = ctx.dropHint?.windowId === win.id ? ctx.dropHint.index : null;

  void ctx.iconEpoch;
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
      testID: `${p}tab-${t.id}`,
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
    const label = tabLabel(t);
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
    if (!chromium && (c.id === "extensions" || c.id === "webstore")) continue;
    if (lowered && !c.title.toLowerCase().includes(lowered)) continue;
    paletteItems.push({ id: `cmd:${c.id}`, title: c.title, subtitle: c.hint, iconName: c.iconName });
  }

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
        <menubar defaults>
          <menu label="File" testID="menu-file">
            <menuitem
              testID="menu-new-tab"
              label="New Tab"
              accelerator="primary+t"
              onSelect={() => ctx.openTab(menuWin.id, "")}
            />
            <menuitem testID="menu-new-window" label="New Window" accelerator="primary+n" onSelect={ctx.newWindow} />
            <menuitem
              testID="menu-private-window"
              label="New Private Window"
              accelerator="primary+shift+p"
              onSelect={ctx.openPrivate}
            />
            <menuitem
              testID="menu-address"
              label="Open Address Bar"
              accelerator="primary+l"
              onSelect={() => menuTarget()?.openAddress()}
            />
            <menuitem
              testID="menu-palette"
              label="Command Palette"
              accelerator="primary+k"
              onSelect={() => menuTarget()?.openPalette("")}
            />
            <menuitem
              testID="menu-close-tab"
              label="Close Tab"
              accelerator="primary+w"
              onSelect={() => ctx.closeTab(menuActive.id)}
            />
            <menuitem
              testID="menu-reopen-tab"
              label="Reopen Closed Tab"
              accelerator="primary+shift+t"
              onSelect={() => ctx.reopenTab(menuWin.id)}
            />
            <menuitem role="separator" testID="menu-file-sep" />
            <menuitem testID="menu-settings" label="Settings" accelerator="primary+comma" onSelect={ctx.openSettings} />
          </menu>
          <menu label="Edit" testID="menu-edit">
            <menuitem
              testID="menu-find"
              label="Find in Page"
              accelerator="primary+f"
              onSelect={() => ctx.openFind(menuActive.id)}
            />
            <menuitem
              testID="menu-find-next"
              label="Find Next"
              accelerator="primary+g"
              onSelect={() => ctx.findCommand(menuActive.id, "findNext")}
            />
            <menuitem
              testID="menu-find-previous"
              label="Find Previous"
              accelerator="primary+shift+g"
              onSelect={() => ctx.findCommand(menuActive.id, "findPrevious")}
            />
          </menu>
          <menu label="View" testID="menu-view">
            <menuitem
              testID="menu-reload"
              label="Reload"
              accelerator="primary+r"
              onSelect={() => ctx.command(menuActive.id, "reload")}
            />
            <menuitem
              testID="menu-layout"
              label={compact ? "Use Sidebar Layout" : "Use Compact Layout"}
              accelerator="primary+shift+s"
              onSelect={() => ctx.setLayout(compact ? "sidebar" : "compact")}
            />
            <menuitem testID="menu-downloads" label="Downloads" onSelect={() => menuTarget()?.openDownloads()} />
            <menuitem role="separator" testID="menu-view-sep" />
            <menuitem
              testID="menu-zoom-in"
              label="Zoom In"
              accelerator="primary+plus"
              onSelect={() => ctx.setZoom(menuActive.id, ctx.zoomFor(menuActive.url) + 0.1)}
            />
            <menuitem
              testID="menu-zoom-out"
              label="Zoom Out"
              accelerator="primary+minus"
              onSelect={() => ctx.setZoom(menuActive.id, ctx.zoomFor(menuActive.url) - 0.1)}
            />
            <menuitem
              testID="menu-zoom-reset"
              label="Reset Zoom"
              accelerator="primary+0"
              onSelect={() => ctx.setZoom(menuActive.id, 1)}
            />
          </menu>
          <menu label="Tabs" testID="menu-tabs">
            <menuitem
              testID="menu-next-tab"
              label="Next Tab"
              accelerator="primary+tab"
              onSelect={() => ctx.cycleTab(menuWin.id, 1)}
            />
            <menuitem
              testID="menu-prev-tab"
              label="Previous Tab"
              accelerator="primary+shift+tab"
              onSelect={() => ctx.cycleTab(menuWin.id, -1)}
            />
            <menuitem
              testID="menu-pin-tab"
              label={menuActive.pinned ? "Unpin Tab" : "Pin Tab"}
              onSelect={() => ctx.setPinned(menuActive.id, !menuActive.pinned)}
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
              enabled={menuRt.canGoBack}
              onSelect={() => ctx.command(menuActive.id, "goBack")}
            />
            <menuitem
              testID="menu-forward"
              label="Forward"
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
                testID="menu-commit-address"
                label="Commit the address field"
                onSelect={() => menuTarget()?.commitAddress()}
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
                  ctx.onContextMenuItem(menuActive.id, {
                    id: "nb-open-link",
                    pageUrl: menuActive.url,
                    linkUrl: `${menuActive.url || "https://example.com/"}#link`,
                    editable: false,
                  })
                }
              />
              <menuitem
                testID="menu-ctx-save-image"
                label="Context: save image"
                onSelect={() =>
                  ctx.onContextMenuItem(menuActive.id, {
                    id: "nb-save-image",
                    pageUrl: menuActive.url,
                    imageUrl: process.env.NB_TEST_IMAGE || `${menuActive.url || "https://example.com/"}#image`,
                    editable: false,
                  })
                }
              />
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
        <splitview sidebarWidth={0.24} testID={`${p}split`}>
          {/* Compact drops the sidebar child on both backends. The content
              pane stays this splitview's second child either way, so the page
              slot never moves and no page reloads. */}
          {!compact && (
            <toolbarview slot="sidebar" testID={`${p}sidebar-toolbar`}>
              <headerbar testID={`${p}sidebar-header`} title="NativeBrowser" />
              {/* No horizontal padding: a source-list row insets its own
                  content, so every point the container takes comes straight
                  off the tab title. */}
              <box
                testID={`${p}sidebar`}
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
                    testID={`${p}new-tab`}
                    label="New Tab"
                    iconName="tab-new-symbolic"
                    labelAlign="start"
                    cssClasses={["flat"]}
                    style={{ hexpand: true }}
                    onClick={() => ctx.openTab(win.id, "")}
                  />
                </box>
                <sourcetree
                  testID={`${p}tab-list`}
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
                    if (nodeId && tabs.some((t) => t.id === nodeId)) ctx.closeTab(nodeId);
                  }}
                  onActionClicked={(e) => {
                    const { nodeId, actionId } = e.data as { nodeId: string; actionId: string };
                    if (actionId === "close") ctx.closeTab(nodeId);
                    if (actionId === "pin") ctx.setPinned(nodeId, true);
                    if (actionId === "unpin") ctx.setPinned(nodeId, false);
                  }}
                />
              </box>
            </toolbarview>
          )}

          <toolbarview slot="content" testID={`${p}content-toolbar`}>
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
              {!compact && (
                <button
                  slot="start"
                  testID={`${p}layout-toggle`}
                  iconName="sidebar-show-symbolic"
                  tooltip="Use Compact Layout"
                  cssClasses={["flat"]}
                  onClick={() => ctx.setLayout("compact")}
                />
              )}
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
              <box slot="start" testID={`${p}site-info-anchor`} orientation="horizontal">
                <button
                  testID={`${p}security-${activeRt.security}`}
                  iconName={SECURITY_ICON[activeRt.security]}
                  tooltip={SECURITY_TOOLTIP[activeRt.security]}
                  cssClasses={["flat"]}
                  onClick={() => setSiteInfoOpen(!siteInfoOpen)}
                />
                <popover
                  testID={`${p}site-info-popover`}
                  open={siteInfoOpen}
                  position="bottom"
                  onClosed={() => {
                    setSiteInfoOpen(false);
                    // Escape and a click outside are a dismissal, and a
                    // dismissed request is denied rather than left pending.
                    ctx.denyPromptsFor(active.id);
                  }}
                >
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
                </popover>
              </box>
              {/* One address widget on both backends and in both layouts, and
                  it takes whatever the row has left: the host promotes a
                  search entry packed straight into a header bar to the title
                  widget with hexpand, which is the centre run. Wrapping it in
                  a box loses that and leaves it at its floor. Typing and Enter
                  commit from the field; Ctrl+L puts the caret in it.

                  The padlock stays a separate button to its left: the widget
                  has no leading-icon prop on either backend, so putting the
                  security state inside the field would need a framework arm
                  (LEDGER). */}
              <searchinput
                slot="start"
                ref={(node) => {
                  omnibox.current = node as NdNodeRef<"searchinput"> | null;
                }}
                testID={`${p}omnibox`}
                text={shownUrl}
                placeholder="Search or enter address"
                // Set, not expanded: see TabRunMetrics.addressWidth for why
                // hexpand alone leaves the field at its floor.
                style={{ hexpand: true, minWidth: compact ? tabMetrics.addressWidth : ADDRESS_MIN_WIDTH }}
                // A ref, not state: feeding a keystroke back into the
                // controlled `text` prop makes the host's set_text race the
                // entry and blank it.
                onChanged={(e) => (typedAddress.current = e.text)}
                onActivate={(e) => commitQuery(e.text)}
              />

              {compact && (
                <button
                  slot="end"
                  testID={`${p}layout-toggle`}
                  iconName="sidebar-show-symbolic"
                  tooltip="Use Sidebar Layout"
                  cssClasses={["flat"]}
                  onClick={() => ctx.setLayout("sidebar")}
                />
              )}

              {/* Chrome's extensions area: the pinned actions, then the puzzle
                  piece that lists everything installed. Each pinned action is
                  boxed with its own popover so the popup opens under the button
                  that was clicked; an unpinned one opens under the puzzle. */}
              {chromium &&
                pinnedActions.map((row) => {
                  const live = actionState(row.id);
                  return (
                    <box slot="end" key={row.id} testID={`${p}ext-pin-${row.id}`} orientation="horizontal">
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
                        position="bottom"
                        onClosed={closeExtensionPopup}
                      >
                        {popupId === row.id ? extensionPopup(row) : <box orientation="horizontal" />}
                      </popover>
                    </box>
                  );
                })}
              {chromium && (
                <box slot="end" testID={`${p}extensions-anchor`} orientation="horizontal">
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
                    position="bottom"
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
                    position="bottom"
                    onClosed={closeExtensionPopup}
                  >
                    {unpinnedPopup ? extensionPopup(unpinnedPopup) : <box orientation="horizontal" />}
                  </popover>
                </box>
              )}

              {/* A popover anchors on its TREE parent on both backends, and a
                  header bar's own handle never joins a view hierarchy, so the
                  button it hangs off has to be boxed. */}
              <box slot="end" testID={`${p}downloads-anchor`} orientation="horizontal">
                <button
                  testID={`${p}downloads-button`}
                  iconName="folder-download-symbolic"
                  tooltip="Downloads"
                  cssClasses={["flat"]}
                  onClick={() => setDownloadsOpen(!downloadsOpen)}
                />
                <popover
                  testID={`${p}downloads-popover`}
                  open={downloadsOpen}
                  position="bottom"
                  onClosed={() => setDownloadsOpen(false)}
                >
                  {/* Stacked boxes rather than a list widget: a popover sizes
                      itself from what it contains, and every list widget here
                      is a scroll view, which contributes no height at all. */}
                  <box
                    testID={`${p}downloads-panel`}
                    orientation="vertical"
                    spacing={Spacing.sm}
                    style={{ padding: Spacing.sm }}
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
                              style={{ halign: "start" }}
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

              {/* The menu bar lives in the first window. Every other window
                  carries its own menu for what acts on THAT window, moving
                  its tab above all, which a drag must never be the only way
                  to do. Last in the row, where the
                  first window's menu bar puts its own button. */}
              {!first && (
                <menubutton slot="end" testID={`${p}window-menu`} iconName="open-menu-symbolic" tooltip="Main Menu">
                  <menuitem testID={`${p}menu-new-tab`} label="New Tab" onSelect={() => ctx.openTab(win.id, "")} />
                  <menuitem testID={`${p}menu-new-window`} label="New Window" onSelect={ctx.newWindow} />
                  <menuitem testID={`${p}menu-close-tab`} label="Close Tab" onSelect={() => ctx.closeTab(active.id)} />
                  <menuitem role="separator" testID={`${p}menu-sep-move`} />
                  {moveItems(`${p}menu-`, win, targets)}
                  <menuitem role="separator" testID={`${p}menu-sep`} />
                  <menuitem testID={`${p}menu-find`} label="Find in Page" onSelect={() => ctx.openFind(active.id)} />
                  <menuitem testID={`${p}menu-downloads`} label="Downloads" onSelect={() => setDownloadsOpen(true)} />
                  <menuitem testID={`${p}menu-settings`} label="Settings" onSelect={ctx.openSettings} />
                </menubutton>
              )}
            </headerbar>

            <box testID={`${p}content`} orientation="vertical" style={{ hexpand: true, vexpand: true }}>
              {/* Presents over the active window wherever it is mounted. */}
              <commandpalette
                key={paletteEpoch}
                testID={`${p}palette`}
                open={paletteOpen}
                placeholder="Search tabs, history and commands"
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
                      <searchinput
                        // Keyed on the tab, so opening a second new tab
                        // builds a new field and the caret lands in it
                        // again.
                        key={active.id}
                        ref={(node) => {
                          if (!node) {
                            newTabFocused.current = 0;
                            return;
                          }
                          if (newTabFocused.current === node.id) return;
                          newTabFocused.current = node.id;
                          sendCommand(node as NdNodeRef<"searchinput">, "focus");
                        }}
                        testID={`${p}new-tab-search`}
                        placeholder="Search or enter address"
                        style={{ minWidth: NEW_TAB_FIELD_WIDTH }}
                        onActivate={(e) => commitQuery(e.text)}
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

                {activeRt.loading && (
                  <progressbar
                    testID={`${p}progress`}
                    fraction={activeRt.progress}
                    cssClasses={["osd"]}
                    style={{ valign: "start", hexpand: true }}
                  />
                )}

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
                            if (!node) {
                              findFocused.current = 0;
                              return;
                            }
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
