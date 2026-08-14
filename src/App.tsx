import {
  Platform,
  Spacing,
  clipboard,
  dialog,
  executeJavaScript,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  sendCommand,
  showToast,
  useMountEffect,
  useRef,
  useState,
  useStoreValue,
  webviewEngine,
} from "@nativedesktop/react";
import type { NdNodeRef, SourceTreeAction, SourceTreeNode } from "@nativedesktop/react";
// <Activity mode="hidden"> is React's own keep-mounted-but-hidden primitive; it
// drives the renderer's hideInstance/unhideInstance hooks, which the host turns
// into gtk_widget_set_visible. That is what lets every tab keep a LIVE webview:
// switching tabs hides a widget instead of unmounting a subtree, so the page,
// its scroll position and its JS state all survive. @nativedesktop/react does
// not re-export it, hence the direct react import.
import { Activity } from "react";

import { contentWorld, toNdAccelerator, type ExtensionHost } from "./extensions/host.ts";
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
import { runDownload } from "./lib/downloads.ts";
import { faviconFor, fetchFavicon, rememberFavicon } from "./lib/favicons.ts";
import { recentVisits, recordTitle, recordVisit, searchHistory, type Visit } from "./lib/history.ts";
import { session } from "./lib/session.ts";
import { SEARCH_ENGINES, settings } from "./lib/settings.ts";
import { displayUrl, fileNameFromUrl, hostOf, isSearch, toUrl } from "./lib/url.ts";
import { PrivateWindow } from "./PrivateWindow.tsx";

const TAB_ACTIONS: SourceTreeAction[] = [
  { id: "close", iconName: "window-close-symbolic", tooltip: "Close Tab" },
];

/// AppKit promotes a titled `<button>` in a header bar to a viewless
/// NSToolbarItem, which hugs its label at 120pt whatever `hexpand` says. A
/// `<searchinput>` is the widget NSToolbar stretches across the free run, so
/// the address display is a field there and a button on GTK, where a flat
/// button in an AdwHeaderBar expands correctly and reads as GNOME chrome.
///
/// Read per render, never captured at module scope: `Platform.backend` is
/// "unknown" until render()'s handshake completes, which is after this module
/// is evaluated.
function addressIsField(): boolean {
  return Platform.backend === "appkit";
}

const TEST_HOOKS = process.env.NB_TEST_HOOKS === "1";

/// A script message from a tab arrives tagged with the world it came from,
/// which is the only thing identifying which extension sent it.
function extensionOfWorld(world: string): string | null {
  const prefix = contentWorld("");
  return world.startsWith(prefix) ? world.slice(prefix.length) : null;
}

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
  { id: "downloads", title: "Downloads", hint: "Sidebar", iconName: "folder-download-symbolic" },
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

/// The page context menu's items, built from the hit test WebKit reports.
interface PageMenu {
  tabId: string;
  link?: string;
  image?: string;
  selection?: string;
  hasSelection: boolean;
}

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
  const [pageMenu, setPageMenu] = useState<PageMenu | null>(null);
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
  const toast = useRef<NdNodeRef<"toastoverlay">>(null);

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
        tabs: [...s.tabs, { id, url, title: "" }],
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
        return { ...s, tabs: [{ id: fresh, url: "", title: "" }], activeId: fresh, nextTabId: s.nextTabId + 1 };
      }
      const nextActive = s.activeId === id ? rest[Math.min(index, rest.length - 1)]!.id : s.activeId;
      return { ...s, tabs: rest, activeId: nextActive };
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

  function closePageMenu(): void {
    setPageMenu(null);
  }

  /// A page-menu action runs against the tab the menu was opened on, not
  /// whatever is active by the time it is clicked.
  function runPageMenu(run: () => void): void {
    closePageMenu();
    run();
  }

  function copyText(text: string): void {
    void clipboard.writeText(text).catch(() => {});
  }

  function saveImage(url: string): void {
    startDownload(url);
  }

  /// The menu the hit test earns, plus whatever the enabled extensions have
  /// registered through `chrome.contextMenus`. Order follows Chrome: what you
  /// clicked first, page navigation last.
  function pageMenuItems(menu: PageMenu | null): { id: string; label: string; run: () => void }[] {
    if (!menu) return [];
    const items: { id: string; label: string; run: () => void }[] = [];
    if (menu.link) {
      const link = menu.link;
      items.push({ id: "open-link", label: "Open Link in New Tab", run: () => openTab(link, true) });
      items.push({ id: "copy-link", label: "Copy Link", run: () => copyText(link) });
    }
    if (menu.image) {
      const image = menu.image;
      items.push({ id: "copy-image", label: "Copy Image Address", run: () => copyText(image) });
      items.push({ id: "save-image", label: "Save Image", run: () => saveImage(image) });
    }
    if (menu.hasSelection) {
      const selection = menu.selection ?? "";
      // WebKitGTK's hit test reports THAT there is a selection but never its
      // text, so Copy runs through the page's own clipboard command there.
      items.push({
        id: "copy",
        label: "Copy",
        run: () => {
          if (selection) copyText(selection);
          else {
            const node = view(menu.tabId);
            if (node) void executeJavaScript(node, "document.execCommand('copy')").catch(() => {});
          }
        },
      });
      if (selection) {
        items.push({
          id: "search-selection",
          label: `Search for "${selection.slice(0, 24)}"`,
          run: () => openTab(toUrl(selection) ?? "", true),
        });
      }
    }
    items.push({ id: "back", label: "Back", run: () => command("goBack") });
    items.push({ id: "forward", label: "Forward", run: () => command("goForward") });
    items.push({ id: "reload", label: "Reload", run: () => command("reload") });
    for (const item of extensions.extensionMenuItems()) {
      items.push({
        id: `ext-${item.extensionId}-${item.id}`,
        label: item.title,
        run: () => extensions.clickContextMenuItem(item.extensionId, item.id),
      });
    }
    return items;
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
    const now = Date.now();
    // A download is not a navigation: whichever tab aimed at this URL goes back
    // to the page it was showing, so the restored session never points at it.
    session.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.url === url ? { ...t, url: committed.current.get(t.id) ?? "" } : t)),
    }));

    const id = `d${downloads.length}-${now}`;
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
  const shownUrl = displayUrl(active.url);
  const pageTitle = active.title || (active.url ? displayUrl(active.url) : "New Tab");

  // Two tabs on the same host produce identical captions, which is exactly the
  // case where the path is the only thing telling them apart.
  const hostCounts = new Map<string, number>();
  for (const t of tabs) {
    const host = hostOf(t.url);
    if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }

  void iconEpoch;
  const nodes: SourceTreeNode[] = tabs.map((t) => {
    const host = hostOf(t.url);
    const repeated = host !== "" && (hostCounts.get(host) ?? 0) > 1;
    return {
      id: t.id,
      title: t.title || (t.url ? displayUrl(t.url) : "New Tab"),
      caption: (repeated ? displayUrl(t.url) : host) || undefined,
      // The site's own icon when it has been seen, the generic page glyph
      // until then. iconData wins over iconName when both are set.
      iconData: faviconFor(t.url),
      iconName: "web-browser-symbolic",
      actionIds: ["close"],
      testID: `tab-${t.id}`,
    };
  });

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
            {/* GTK4 synthesises no pointer input, so a right-click inside page
                content is unreachable from a drive and WebKit's own
                `context-menu` signal never fires headlessly. This opens the
                same menu off a synthetic hit test, which exercises everything
                the app owns: what the menu contains and what its items do. */}
            <menuitem
              testID="menu-open-page-menu"
              label="Open page menu"
              onSelect={() =>
                setPageMenu({
                  tabId: active.id,
                  link: `${active.url || "https://example.com/"}#link`,
                  image: `${active.url || "https://example.com/"}#image`,
                  hasSelection: true,
                  selection: "selected words",
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
          <toolbarview slot="sidebar" testID="sidebar-toolbar">
            <headerbar testID="sidebar-header" title="NativeBrowser" />
            <box
              testID="sidebar"
              orientation="vertical"
              spacing={Spacing.xs}
              style={{ vexpand: true, padding: Spacing.xs }}
            >
              <button
                testID="new-tab"
                label="New Tab"
                iconName="tab-new-symbolic"
                labelAlign="start"
                cssClasses={["flat"]}
                onClick={newTab}
              />
              <sourcetree
                testID="tab-list"
                nodes={nodes}
                actions={TAB_ACTIONS}
                selectedId={active.id}
                style={{ vexpand: true }}
                onSelectionChanged={(e) => {
                  const { nodeId } = e.data as { nodeId: string | null };
                  if (nodeId) selectTab(nodeId);
                }}
                onActionClicked={(e) => {
                  const { nodeId, actionId } = e.data as { nodeId: string; actionId: string };
                  if (actionId === "close") closeTab(nodeId);
                }}
              />
              <separator orientation="horizontal" />
              <expander
                testID="downloads"
                label={downloads.length > 0 ? `Downloads (${downloads.length})` : "Downloads"}
                expanded={downloadsOpen}
                onToggled={(e) => setDownloadsOpen(e.checked)}
              >
                <box orientation="vertical" spacing={Spacing.xs}>
                  <sourcelist
                    testID="downloads-list"
                    items={downloads.map((d) => ({
                      title: d.name,
                      iconName: d.state === "failed" ? "dialog-warning-symbolic" : "folder-download-symbolic",
                      badge: d.state === "running" ? "…" : undefined,
                    }))}
                    emptyIconName="folder-download-symbolic"
                    emptyTitle="No Downloads Yet"
                    emptyDescription="Files you download appear here."
                  />
                </box>
              </expander>
            </box>
          </toolbarview>

          <toolbarview slot="content" testID="content-toolbar">
            <headerbar
              testID="chrome"
              title=""
              canGoBack={activeRt.canGoBack}
              canGoForward={activeRt.canGoForward}
              onBack={() => command("goBack")}
              onForward={() => command("goForward")}
            >
              <button
                slot="start"
                testID="reload"
                iconName={activeRt.loading ? "process-stop-symbolic" : "view-refresh-symbolic"}
                tooltip={activeRt.loading ? "Stop" : "Reload"}
                cssClasses={["flat"]}
                onClick={() => command(activeRt.loading ? "stop" : "reload")}
              />
              {/* The indicator's testID carries its state: getTree exposes a
                  node's text but never its icon name, so this is the only way
                  a drive can assert which padlock is drawn. */}
              <button
                slot="start"
                key={activeRt.security}
                testID={`security-${activeRt.security}`}
                iconName={SECURITY_ICON[activeRt.security]}
                tooltip={SECURITY_TOOLTIP[activeRt.security]}
                cssClasses={["flat"]}
                onClick={() => openPalette(active.url)}
              />
              {addressIsField() ? (
                <searchinput
                  slot="start"
                  testID="omnibox"
                  text={shownUrl}
                  placeholder="Search or Enter Address"
                  style={{ hexpand: true }}
                  onActivate={(e) => commitQuery(e.text)}
                />
              ) : (
                <button
                  slot="start"
                  testID="omnibox"
                  label={shownUrl || "Search or Enter Address"}
                  tooltip="Search or enter an address (Ctrl+L)"
                  ellipsize
                  cssClasses={["flat"]}
                  style={{ hexpand: true }}
                  onClick={() => openPalette(active.url)}
                />
              )}
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
                  <searchinput
                    testID="find-query"
                    placeholder="Find in Page"
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

              {/* The page context menu. WebKit reports the click position, but
                  neither backend exposes a point-anchored popup menu, so this
                  popover anchors to the content pane instead (framework ask).
                  Its rows are native buttons, so automation can click them. */}
              <popover testID="context-menu" open={pageMenu !== null} position="bottom" onClosed={closePageMenu}>
                <box orientation="vertical" spacing={0} style={{ padding: Spacing.xs }}>
                  {pageMenuItems(pageMenu).map((item) => (
                    <button
                      key={item.id}
                      testID={`context-menu-${item.id}`}
                      label={item.label}
                      labelAlign="start"
                      cssClasses={["flat"]}
                      onClick={() => runPageMenu(item.run)}
                    />
                  ))}
                </box>
              </popover>

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
                          setArmedTabs((a) => (a[t.id] ? a : { ...a, [t.id]: true }));
                        }}
                        url={armedTabs[t.id] && extensionsReady ? t.url : ""}
                        testID={`page-${t.id}`}
                        suppressContextMenu
                        style={{ hexpand: true, vexpand: true }}
                        onScriptMessage={(e) => {
                          const message = e.data as { name: string; world: string; body: unknown };
                          const extensionId = extensionOfWorld(message.world);
                          if (!extensionId) return;
                          extensions.handleScriptMessage({ kind: "content", tabId: t.id, extensionId }, message.body);
                        }}
                        onSchemeRequest={(e) => {
                          const node = view(t.id);
                          if (node) extensions.serveScheme(node, e.data as { id: string; url: string });
                        }}
                        onNavigate={(e) => onNavigated(t.id, e.text)}
                        onTitleChanged={(e) => onTitled(t.id, e.text)}
                        onLoadingChanged={(e) => patch(t.id, { loading: e.checked })}
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
                        onContextMenu={(e) => {
                          const hit = e.data as {
                            link?: string;
                            image?: string;
                            selection?: string;
                            hasSelection: boolean;
                          };
                          setPageMenu({ tabId: t.id, ...hit });
                        }}
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
    {privateOpen && schemeReady && <PrivateWindow onClose={() => setPrivateOpen(false)} />}

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

/// Settings. Three preferences, native rows, written straight through the
/// store: there is no Apply button because there is nothing to apply.
function SettingsWindow({ onClose }: { onClose: () => void }): React.ReactNode {
  const prefs = useStoreValue(settings);
  const engineIndex = Math.max(0, SEARCH_ENGINES.findIndex((e) => e.id === prefs.searchEngine));

  return (
    <window title="Settings" testID="settings-window" defaultWidth={560} defaultHeight={420} onClosed={onClose}>
      <toolbarview testID="settings-toolbar">
        <headerbar testID="settings-header" title="Settings" />
        <scrollview testID="settings-scroll" style={{ hexpand: true, vexpand: true }}>
          <clamp maximumSize={640}>
            <box orientation="vertical" spacing={Spacing.lg} style={{ padding: Spacing.lg, hexpand: true }}>
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
            </box>
          </clamp>
        </scrollview>
      </toolbarview>
    </window>
  );
}
