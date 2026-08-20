import {
  Spacing,
  dialog,
  executeJavaScript,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  openPath,
  revealPath,
  sendCommand,
  setContextMenuItems,
  showToast,
  useMountEffect,
  useRef,
  useState,
  useStoreValue,
  webviewEngine,
} from "@nativedesktop/react";
import type {
  ContextMenuItem,
  ContextMenuItemClick,
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

import { bridgeSurface } from "./extensions/bootstrap.ts";
import { toNdAccelerator, type ExtensionHost } from "./extensions/host.ts";
import {
  ExtensionActionButtons,
  ExtensionBackgrounds,
  ExtensionPermissionPrompt,
  ExtensionPopupWindow,
  ExtensionStoreDialog,
  ExtensionsManagerWindow,
  useExtensionState,
} from "./extensions/ui.tsx";
import type { DownloadItem } from "./lib/downloads.ts";
import { downloadDir, runDownload } from "./lib/downloads.ts";
import { faviconFor, fetchFavicon, rememberFavicon } from "./lib/favicons.ts";
import { recentVisits, recordTitle, recordVisit, searchHistory, type Visit } from "./lib/history.ts";
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

/// Menu labels for extension commands. The manifest description is the
/// extension's own wording; the command name is the fallback when it has none.
function commandLabel(extensionName: string, command: string, description: string): string {
  return `${extensionName}: ${description || command}`;
}

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
];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

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
/// chrome-extension://, about:) is not "insecure", it is simply not a site.
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
  extensions: ExtensionHost;
}

export function App({ initialHistory, initialWidth, initialHeight, extensions }: AppProps): React.ReactNode {
  const state = useStoreValue(session);
  const { tabs, activeId } = state;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  // A tab's webview is created with no URL and navigates one render later, once
  // its content scripts are registered: a user script added after a load has
  // begun never sees document_start.
  const [armedTabs, setArmedTabs] = useState<Record<string, boolean>>({});
  const [storeDialogOpen, setStoreDialogOpen] = useState(false);
  // WebKit freezes its scheme handlers the moment the first <webview> exists,
  // and registering one needs a live host connection, so no webview may mount
  // until this resolves.
  const [schemeReady, setSchemeReady] = useState(false);
  const { views: extensionViews } = useExtensionState(extensions);
  // A content script that connects before its extension's background page can
  // answer gets one reply, the wrong one, and never asks again. Chrome starts
  // the background first by construction; here the tabs wait for it.
  const extensionsReady = extensions.backgroundsReady();

  useMountEffect(() => {
    webviewEngine
      // Chrome's extension origins are secure contexts and CORS-enabled: an
      // extension page that uses crypto.subtle or IndexedDB, or fetches its own
      // resources from a content script's world, depends on both. GTK honours
      // the flags; AppKit has no public API for them (documented asymmetry).
      .registerScheme("chrome-extension", { corsEnabled: true, secure: true })
      .catch((error: Error) => console.error(`[nativebrowser] chrome-extension:// unavailable: ${error.message}`))
      .finally(() => setSchemeReady(true));
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Two halves of one field. `paletteSeed` is the controlled `query` prop and
  // only ever changes when the app deliberately seeds or clears it; echoing
  // keystrokes back into it makes GTK's set_text race the entry and blank it.
  // `paletteQuery` is what the user actually typed, and only feeds ranking.
  const [paletteSeed, setPaletteSeed] = useState("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [historyHits, setHistoryHits] = useState<Visit[]>([]);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [history, setHistory] = useState<Visit[]>(initialHistory);
  const [find, setFind] = useState<FindState>(NO_FIND);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  /// Download ids only have to be unique within a run, and a short one keeps
  /// the panel's row testIDs readable.
  const downloadSeq = useRef(0);

  const rt = (id: string): Runtime => runtime[id] ?? IDLE;
  const patch = (id: string, part: Partial<Runtime>): void =>
    setRuntime((r) => ({ ...r, [id]: { ...(r[id] ?? IDLE), ...part } }));
  const view = (id: string): NdNodeRef<"webview"> | null => views.current.get(id) ?? null;

  // The broker has no view of the React tree, so it gets the tab list and the
  // four tab operations it can trigger. setTabs only emits when something
  // actually differs, which is what makes calling it per render safe.
  extensions.setTabs(tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === active.id })));
  extensions.appHooks = {
    openTab: (url, background) => openTab(url, background),
    closeTab: (id) => closeTab(id),
    reloadTab: (id) => {
      const node = view(id);
      if (node) sendCommand(node, "reload");
    },
    updateTab: (id, props) => {
      if (props.url) navigate(id, props.url);
      if (props.active) selectTab(id);
    },
  };
  // Same rule, same reason: an extension registering a menu, a tab navigating
  // or a new search engine all change what a right-click should show, and all
  // three land as a render. The push is skipped when the tree is unchanged.
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
    committed.current.set(id, url);
    setTabUrl(id, url);
    applyZoom(id, url);
    extensions.notifyNavigated(id, url);
    void recordVisit(url, "").then(refreshHistory);
  }

  /// A load that stopped, at whatever address it stopped on. Anything that has
  /// to re-navigate a tab belongs here rather than in `onNavigated`: that one
  /// reports the address the engine is still fetching, so acting on it cancels
  /// the fetch it is reporting.
  function onLoadSettled(id: string): void {
    extensions.notifyLoadSettled(id, committed.current.get(id) ?? "");
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
  }

  function runFind(text: string): void {
    setFind((f) => ({ ...f, open: true, query: text, count: null }));
    if (text) findCommand("findStart", { text });
    else findCommand("findStop");
  }

  // ------------------------------------------------------- context menu ---

  /// The engine draws the menu: Back/Forward/Reload, Open Link, Copy Image,
  /// Look Up and Inspect Element are WebKit's own and always there. These are
  /// the three things a browser has to add on top, because they act on the
  /// browser rather than on the page: a tab, this app's downloads, and the
  /// search engine the user picked.
  function appContextMenuItems(): ContextMenuItem[] {
    return [
      { id: "nb-open-link", label: "Open Link in New Tab", contexts: ["link"] },
      { id: "nb-save-image", label: "Save Image", contexts: ["image"] },
      { id: "nb-search-selection", label: `Search with ${engineOf(prefs.searchEngine).name}`, contexts: ["selection"] },
    ];
  }

  /// Pushes each tab's menu to its own view: the app's items plus whatever the
  /// enabled extensions have registered for THAT tab's URL. Sent only when the
  /// tree actually changes, which is what makes calling it per render safe (the
  /// `setTabs` idiom above).
  function syncContextMenus(only?: string): void {
    for (const tab of tabs) {
      if (only !== undefined && tab.id !== only) continue;
      const node = views.current.get(tab.id);
      if (!node) continue;
      const items = [...appContextMenuItems(), ...extensions.contextMenuItemsFor(tab.id)];
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

  /// An item the user chose in a page's context menu. Extension items are the
  /// broker's; the rest are the three above.
  function onContextMenuItem(tabId: string, click: ContextMenuItemClick): void {
    if (extensions.handleContextMenuClick(tabId, click)) return;
    switch (click.id) {
      case "nb-open-link":
        if (click.linkUrl) openTab(click.linkUrl, true);
        return;
      case "nb-save-image":
        if (click.imageUrl) startDownload(click.imageUrl);
        return;
      case "nb-search-selection":
        // WebKitGTK's hit test reports THAT there is a selection but never its
        // text, so on that backend the page is asked for it.
        if (click.selectionText) {
          openTab(toUrl(click.selectionText) ?? "", true);
          return;
        }
        {
          const node = view(tabId);
          if (!node) return;
          void executeJavaScript(node, "String(window.getSelection())")
            .then((raw) => {
              // The engines serialize the result as JSON; a string comes back
              // quoted, and an older host may answer it raw.
              const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
              if (text.trim()) openTab(toUrl(text) ?? "", true);
            })
            .catch(() => {});
        }
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

  function reportInstallFailure(reason: string): void {
    if (toast.current) void showToast(toast.current, { title: `Unable to add the extension: ${reason}` });
  }

  /// The two "Install from…" entries are the same flow with a different picker;
  /// only on Add does anything of the extension run.
  function stageFrom(options: { directories: boolean }): void {
    void dialog
      .openFile({
        title: options.directories ? "Choose an extension folder" : "Choose an extension file",
        directories: options.directories,
        filters: options.directories ? undefined : [{ name: "Extensions", extensions: ["crx", "zip"] }],
      })
      .then((paths) => (paths[0] ? extensions.stage(paths[0]) : null))
      .catch((error: Error) => reportInstallFailure(error.message));
  }

  const managerActions = {
    installFromFile: () => stageFrom({ directories: false }),
    installFromFolder: () => stageFrom({ directories: true }),
    installFromStore: () => setStoreDialogOpen(true),
  };

  function openPalette(seed: string): void {
    setPaletteSeed(seed);
    setPaletteQuery(seed);
    void searchHistory(seed).then(setHistoryHits);
    setPaletteOpen(true);
  }

  /// Clearing the seed on close is what lets the next open re-seed the same URL:
  /// an unchanged prop would leave the last query sitting in the field.
  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteSeed("");
    setPaletteQuery("");
  }

  /// New tab is Arc-shaped: the empty tab appears and the palette opens over it,
  /// so one keystroke gets you from "new tab" to "typing an address".
  function newTab(): void {
    openTab("");
    openPalette("");
  }

  function commitQuery(raw: string): void {
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
    }
  }

  const activeRt = rt(active.id);
  const compact = prefs.layout === "compact";
  const recentDownloads = downloads.slice(0, DOWNLOADS_SHOWN);
  const shownUrl = displayUrl(active.url);
  const pageTitle = active.title || (active.url ? displayUrl(active.url) : "New Tab");

  void iconEpoch;
  // One line per tab: favicon and title, nothing else. A second line of host
  // costs a third of the column's height and repeats what the address bar
  // already says about the tab you are looking at.
  function tabNode(t: (typeof tabs)[number]): SourceTreeNode {
    return {
      id: t.id,
      title: t.title || (t.url ? displayUrl(t.url) : "New Tab"),
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
            onSelect={() => openPalette(active.url)}
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
              label={t.title || (t.url ? displayUrl(t.url) : "New Tab")}
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
                open one: GTK4 synthesises no pointer input, and WebKit's
                `context-menu` signal never fires headlessly. These feed the
                app's own handler the payload a real click would carry, which
                is the half the app owns. What the menu CONTAINS is asserted
                from the ND_APP CTXMENU trace instead. */}
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
            testID="menu-extensions-manage"
            label="Manage Extensions"
            accelerator="primary+shift+e"
            onSelect={() => extensions.setManagerOpen(true)}
          />
          <menuitem role="separator" testID="menu-extensions-sep" />
          {extensionViews
            .filter((v) => v.enabled)
            .map((v) => (
              <menuitem
                key={v.id}
                testID={`menu-ext-open-${v.id}`}
                label={v.title}
                onSelect={() => extensions.openAction(v.id)}
              />
            ))}
          {/* Manifest commands, bound to the shortcut the extension asked for. */}
          {extensionViews
            .filter((v) => v.enabled)
            .flatMap((v) =>
              (extensions.extensions.get(v.id)?.manifest.commands ?? [])
                .filter((c) => c.suggestedKey !== null)
                .map((c) => (
                  <menuitem
                    key={`${v.id}-${c.name}`}
                    testID={`menu-ext-cmd-${v.id}-${c.name}`}
                    label={commandLabel(v.name, c.name, c.description)}
                    accelerator={toNdAccelerator(c.suggestedKey!) ?? undefined}
                    onSelect={() => extensions.runCommand(v.id, c.name)}
                  />
                )),
            )}
          {extensions.extensionMenuItems().map((item) => (
            <menuitem
              key={`${item.extensionId}-${item.id}`}
              testID={`menu-ext-menu-${item.extensionId}-${item.id}`}
              label={item.title}
              onSelect={() => extensions.clickContextMenuItem(item.extensionId, item.id)}
            />
          ))}
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
              <button
                slot="start"
                testID={`security-${activeRt.security}`}
                iconName={SECURITY_ICON[activeRt.security]}
                tooltip={SECURITY_TOOLTIP[activeRt.security]}
                cssClasses={["flat"]}
                onClick={() => openPalette(active.url)}
              />
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
              <searchinput
                slot="start"
                testID="omnibox"
                text={shownUrl}
                placeholder="Search or Enter Address"
                style={{ hexpand: true }}
                onActivate={(e) => commitQuery(e.text)}
              />

              {/* Compact has no sidebar, so the two things the column carried
                  move here: the tab list and the way to add one. */}
              {compact && (
                <menubutton slot="end" testID="tabs-menu" iconName="view-list-symbolic" tooltip="Tabs">
                  {tabs.map((t, i) => (
                    <menuitem
                      key={t.id}
                      testID={`tabs-menu-${i}`}
                      label={t.title || (t.url ? displayUrl(t.url) : "New Tab")}
                      onSelect={() => selectTab(t.id)}
                    />
                  ))}
                </menubutton>
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

              <ExtensionActionButtons host={extensions} />
            </headerbar>

            <box testID="content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
              {activeRt.loading && <progressbar testID="progress" fraction={activeRt.progress} />}

              {find.open && (
                <box
                  testID="find-bar"
                  orientation="horizontal"
                  spacing={Spacing.sm}
                  style={{ padding: Spacing.sm, hexpand: true }}
                >
                  {/* Adwaita's `.error` on the entry is what a search that
                      found nothing looks like in GNOME; the count label alone
                      leaves the field claiming everything is fine. Empty
                      rather than absent, so the class comes back off. */}
                  <searchinput
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
                  {/* No Escape binding: the framework surfaces no key events to
                      the app, and a bare `Escape` menu accelerator would be
                      global. Filed as a framework ask. */}
                  <button
                    testID="find-close"
                    iconName="window-close-symbolic"
                    tooltip="Close"
                    cssClasses={["flat"]}
                    onClick={closeFind}
                  />
                </box>
              )}

              {/* Presents over the active window wherever it is mounted. */}
              <commandpalette
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

              {tabs
                .filter((t) => t.url !== "" && schemeReady)
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
                          extensions.armTabView(t.id, node as NdNodeRef<"webview">);
                          // The view exists now, so its menu can be pushed; the
                          // render-time sync could only skip it.
                          syncContextMenus(t.id);
                          setArmedTabs((a) => (a[t.id] ? a : { ...a, [t.id]: true }));
                        }}
                        url={armedTabs[t.id] && extensionsReady ? t.url : ""}
                        testID={`page-${t.id}`}
                        style={{ hexpand: true, vexpand: true }}
                        onScriptMessage={(e) => {
                          // The handler NAME says who sent this, not the world:
                          // a name is what both engines route on, and a tab
                          // with two extensions in it has one per world.
                          const message = e.data as { name: string; world: string; body: unknown };
                          const extensionId = bridgeSurface(message.name);
                          if (!extensionId) return;
                          extensions.handleScriptMessage({ kind: "content", tabId: t.id, extensionId }, message.body);
                        }}
                        onSchemeRequest={(e) => {
                          const node = view(t.id);
                          if (node) extensions.serveScheme(node, e.data as { id: string; url: string });
                        }}
                        onNavigate={(e) => onNavigated(t.id, e.text)}
                        onTitleChanged={(e) => onTitled(t.id, e.text)}
                        onLoadingChanged={(e) => {
                          patch(t.id, { loading: e.checked });
                          if (!e.checked) onLoadSettled(t.id);
                        }}
                        onLoadProgress={(e) => patch(t.id, { progress: e.value })}
                        onBackAvailable={(e) => patch(t.id, { canGoBack: e.checked })}
                        onForwardAvailable={(e) => patch(t.id, { canGoForward: e.checked })}
                        onLoadFailed={(e) => patch(t.id, { error: e.data as { url: string; error: string } })}
                        onNewWindow={(e) => openTab(e.text, true)}
                        onJavaScriptResult={onJavaScriptResult}
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
                    onClick={() => openPalette("")}
                  />
                </statuspage>
              )}

              {/* Background pages live in the main window so Activity can keep
                  them running while they stay invisible. */}
              {schemeReady && <ExtensionBackgrounds host={extensions} />}
            </box>
          </toolbarview>
        </splitview>
      </toastoverlay>
    </window>

    {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
    {privateOpen && schemeReady && (
      <PrivateWindow
        onClose={() => setPrivateOpen(false)}
        onSettings={() => setSettingsOpen(true)}
        onExtensions={() => extensions.setManagerOpen(true)}
        onDownloads={() => setDownloadsOpen(true)}
        onDownload={startDownload}
      />
    )}

    <ExtensionPermissionPrompt host={extensions} />
    {schemeReady && <ExtensionPopupWindow host={extensions} />}
    <ExtensionsManagerWindow host={extensions} actions={managerActions} />
    <ExtensionStoreDialog
      host={extensions}
      open={storeDialogOpen}
      onClose={() => setStoreDialogOpen(false)}
      onFailure={reportInstallFailure}
    />
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
