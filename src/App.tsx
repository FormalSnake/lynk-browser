import {
  Activity,
  Portal,
  acceptExtensionInstall,
  executeJavaScript,
  installExtension,
  listExtensionActions,
  listExtensions,
  moveNode,
  newWindowRequest,
  nextCommit,
  onExtensionActions,
  onExtensionsChanged,
  onExtensionsList,
  onJavaScriptResult,
  openPath,
  pauseDownload,
  readExtensionAction,
  respondDownload,
  resumeDownload,
  revealPath,
  cancelDownload,
  startDownload as engineStartDownload,
  dialog,
  sendCommand,
  triggerExtensionAction,
  uninstallExtension as removeExtension,
  setContextMenuItems,
  watchExtensions,
  useStoreValue,
  Spacing,
  system,
} from "@nativedesktop/react";
import type {
  ContextMenuItem,
  ContextMenuItemClick,
  DownloadRequest,
  DownloadUpdate,
  ExtensionAction,
  ExtensionsChange,
  ExtensionActionState,
  InstalledExtension,
  NdNodeRef,
} from "@nativedesktop/react";
import { For, Show, createEffect, createMemo, createSignal, createStore, onSettled } from "solid-js";

import {
  BrowserWindow,
  TEST_HOOKS,
  type BrowserContext,
  type MoveTarget,
  type WindowController,
} from "./BrowserWindow.tsx";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type DownloadActions } from "./Downloads.tsx";
import {
  addDownload,
  clearDownloads,
  discardDangerous,
  downloadDir,
  downloadName,
  downloads,
  ensureDir,
  fetchToFile,
  isActive,
  isDangerous,
  keepDangerous,
  newDownloadId,
  patchDownload,
  removeDownload,
  reservedPaths,
  uniquePath,
  type DownloadItem,
} from "./lib/downloads.ts";
import { nativePage } from "./lib/pages.ts";
import { extensionRows, pinnedRows, probeUrl, togglePinned, type ExtensionRow } from "./lib/extensions.ts";
import { faviconAppearance, faviconFor, fetchFavicon, rememberFavicon, setFaviconAppearance } from "./lib/favicons.ts";
import { FLOAT_SCRIPT, floatState } from "./lib/float.ts";
import { clearVisits, recentVisits, recordTitle, recordVisit, type Visit } from "./lib/history.ts";
import { trackStore } from "./lib/live.ts";
import {
  forgetOrigin,
  normalizeOrigin,
  rememberDecision,
  rememberedDecision,
  splitTypes,
  type PermissionDecision,
  type PermissionPrompt,
  type PermissionResult,
} from "./lib/permissions.ts";
import {
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  blankTab,
  moveTabIn,
  placeOpenedTab,
  session,
  windowOfTab,
  type SessionState,
  type SessionTab,
} from "./lib/session.ts";
import { LAYOUTS, PIN_STYLES, SEARCH_ENGINES, engineOf, settings, type Layout } from "./lib/settings.ts";
import { STORE_CHANNEL, STORE_ORIGINS, STORE_SCRIPT, fixWebStore, parseStoreRequest, permissionLines, storeAnswerScript } from "./lib/webstore.ts";
import {
  READER_BRIDGE_SCRIPT,
  READER_CHANNEL,
  READER_WORLD,
  leaveReaderScript,
  readerSchemeScript,
  readerState,
  toggleReaderScript,
} from "./lib/reader.ts";
import { parseTabPayload } from "./lib/tabdrag.ts";
import {
  IDLE,
  NO_FIND,
  createAtUrl,
  securityOf,
  windowLabel,
  type FindState,
  type Runtime,
} from "./lib/tabstate.ts";
import { LAYOUT_SEGMENT_WIDTH } from "./lib/metrics.ts";
import { fileNameFromUrl, hostOf, toUrl } from "./lib/url.ts";
import { clampZoom, stepZoom } from "./lib/zoom.ts";
import {
  blocking,
  blockingOn,
  hiddenOn,
  hide,
  refresh,
  restoreHidden,
  setBlockingOn,
  siteOf,
  startContentBlocking,
} from "./lib/adblock.ts";
import { HIDER_CHANNEL, HIDER_SOURCE, HIDER_WORLD, type HiderMessage } from "./lib/hider.ts";
import { PrivateWindow, type PrivateBridge } from "./PrivateWindow.tsx";

/// A window with no tabs left is closed, not kept around empty.
function withoutEmptyWindows(s: SessionState): SessionState {
  return s.windows.every((w) => w.tabs.length > 0) ? s : { ...s, windows: s.windows.filter((w) => w.tabs.length > 0) };
}

function tabNumber(id: string): number {
  return Number(id.slice(1)) || 0;
}

export interface AppProps {
  initialHistory: Visit[];
}

/// The app root. It owns everything keyed by tab (the live pages, their
/// runtime state, find, permission prompts, context menus) and the session
/// store, and draws one BrowserWindow per window in it. A tab moving between
/// windows therefore changes which window LISTS it and which window's slot
/// its page is shown in, and nothing else.
export function App(props: AppProps) {
  const state = trackStore(session);
  const prefs = trackStore(settings);
  const blockingState = useStoreValue(blocking);
  const windows = createMemo(() => state.windows.filter((w) => w.tabs.length > 0));
  const allTabs = createMemo(() => windows().flatMap((w) => w.tabs));
  /// Resolves once the first CommitBatch is on its way, the earliest the host
  /// takes system calls. Asked for before anything renders, so it cannot miss it.
  const firstCommit = nextCommit();

  /// Per tab, per field: a load-progress tick writes `progress` on its own tab
  /// and reaches only what reads it, the load bar.
  const [runtime, setRuntime] = createStore<Record<string, Runtime>>({});
  const [history, setHistory] = createSignal<Visit[]>(props.initialHistory);
  const [finds, setFinds] = createStore<Record<string, FindState>>({});
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /// Permission requests waiting for an answer, oldest first. A request is
  /// per tab and per id: concurrent ones queue, and a background tab's waits
  /// until that tab is active.
  const [prompts, setPrompts] = createSignal<PermissionPrompt[]>([]);
  /// The queue the handlers act on; `prompts` is its rendered copy.
  let pending: PermissionPrompt[] = [];
  /// The two halves of an extension row, each from its own framework call.
  const [registry, setRegistry] = createSignal<InstalledExtension[]>([]);
  /// The ids the last registry read listed, to see which one went.
  let knownExtensions: string[] = [];
  const [extActions, setExtActions] = createSignal<ExtensionAction[]>([]);
  /// The action a click is being decided for. Nothing opens until its live
  /// state is in, because the manifest's popup may be one the extension has
  /// switched off.
  const [checkingAction, setCheckingAction] = createSignal("");
  let checking = "";
  /// Each action's live state, as last read for a tab some window is showing.
  const [actionStates, setActionStates] = createSignal<Record<string, ExtensionActionState>>({});
  /// Each action's state as read on its probe's own tab: its defaults.
  const [actionDefaults, setActionDefaults] = createSignal<Record<string, ExtensionActionState>>({});
  /// Hidden views on a page of each extension whose state the toolbar needs.
  /// Chromium answers an action's live state to its own extension's pages and
  /// to nothing else, so these are the only way to read it.
  const probes = new Map<string, NdNodeRef<"webview">>();
  const [privateOpen, setPrivateOpen] = createSignal(false);
  /// Bumped when a favicon lands. The cache lives outside the reactive graph,
  /// so this is what tells the windows to re-read it.
  const [iconEpoch, setIconEpoch] = createSignal(0);
  /// The window the menu bar and its accelerators act on.
  const [focusedId, setFocusedId] = createSignal(windows()[0]?.id ?? "");
  const focusedWindowId = createMemo(() => {
    const id = focusedId();
    return windows().some((w) => w.id === id) ? id : (windows()[0]?.id ?? "");
  });
  const [dropHint, setDropHintState] = createSignal<{ windowId: string; index: number } | null>(null);

  const closed: { url: string; title: string }[] = [];
  /// Tabs that have a browser. A tab gets one the first time it is shown and
  /// keeps it until it is put to sleep or closed: a restored tab, one opened
  /// behind the page and a sleeping one all wait to be looked at.
  const [live, setLive] = createStore<Record<string, true>>({});
  /// Tabs put to sleep, which their rows draw dimmed until they wake.
  const [asleep, setAsleep] = createStore<Record<string, true>>({});
  /// Where a sleeping page was scrolled to, put back once it has loaded again.
  const scrollMemory = new Map<string, [number, number]>();
  /// Last URL the engine actually committed per tab, so a download can put the
  /// tab back where it was.
  const committed = new Map<string, string>();
  /// Each tab's mounted view and each window's page slot, set once the native
  /// node exists. `placed` is the slot each tab's view was last moved into, as
  /// "view id>slot id": a remounted view or a rebuilt window both change it,
  /// and either means the view has to be moved again.
  const views = new Map<string, NdNodeRef<"webview">>();
  const slots = new Map<string, NdNodeRef<"box">>();
  const placed = new Map<string, string>();
  /// The zoom factor each view was last set to or reported at.
  const viewZoom = new WeakMap<NdNodeRef<"webview">, number>();
  /// Bumped whenever a view or a slot comes or goes, which is what runs the
  /// placement again.
  const [mounts, setMounts] = createSignal(0);
  const remounted = (): void => void setMounts((n) => n + 1);
  const controllers = new Map<string, WindowController>();
  const privateBridge: { current: PrivateBridge | null } = { current: null };
  /// Last context-menu tree sent to each tab's view, so an unchanged one is
  /// never re-sent.
  const sentMenus = new Map<string, string>();
  /// The hidden `chrome://extensions` view. Chromium exposes its extension
  /// registry to that page and nowhere else, so every list and every install
  /// goes through this one rather than through a tab the user can navigate.
  let extRegistry: NdNodeRef<"webview"> | null = null;
  /// Set once the engine probe has an answer, so no retry outlives it.
  let engineProbed = false;
  /// Which engine actually drew a page, read off the first one this app put
  /// up. Not the config and not the platform: `ND_WEBVIEW_ENGINE=chromium`
  /// against a host that cannot start CEF falls back to the system engine and
  /// says so only on stderr, and everything chrome:// is a dead end there.
  const [engine, setEngine] = createSignal<"unknown" | "chromium" | "system">("unknown");
  /// The engine's id for a download, per run, to the app's own, which lasts.
  const engineDownloads = new Map<string, string>();
  /// A tab a page opened, to the tab that opened it: where the next one it
  /// opens behind it goes.
  const openers = new Map<string, string>();
  /// A retry restarts the download from its URL; the request that comes back
  /// for that URL takes over the row it came from.
  const retrying = new Map<string, string>();
  /// Tabs left on a download's address until it ends, by engine id.
  const downloadTabs = new Map<string, string[]>();

  const rt = (id: string): Runtime => runtime[id] ?? IDLE;
  /// An event that changes nothing writes nothing: every page event lands
  /// here, and only the fields that moved notify their readers.
  const patch = (id: string, part: Partial<Runtime>): void => {
    const now = runtime[id] ?? IDLE;
    let changed = false;
    for (const k in part) {
      const key = k as keyof Runtime;
      if (!Object.is(now[key], part[key])) changed = true;
    }
    if (!changed) return;
    setRuntime((r) => {
      const cur = r[id];
      if (!cur) {
        r[id] = { ...IDLE, ...part };
        return;
      }
      Object.assign(cur, part);
    });
  };
  const view = (id: string): NdNodeRef<"webview"> | null => views.get(id) ?? null;
  const tabOf = (id: string): SessionTab | null =>
    session
      .get()
      .windows.flatMap((w) => w.tabs)
      .find((t) => t.id === id) ?? null;
  /// Whether a tab is the one its window is showing.
  const isShown = (id: string): boolean => session.get().windows.some((w) => w.activeId === id);
  const toast = (title: string): void => controllers.get(focusedWindowId())?.toast(title);
  /// Extensions are Chromium's. On the system engine there is no registry to
  /// list, no popup to open and no chrome:// page to reach, so the toolbar
  /// does not offer any of it rather than offering a dead button.
  const chromium = (): boolean => engine() === "chromium";

  /// Whether a tab has, or is about to get, a browser: every tab a window is
  /// showing does.
  const isLive = (id: string): boolean => live[id] === true || windows().some((w) => w.activeId === id);

  // A tab on show keeps its browser once it is shown elsewhere. Every path
  // that changes the tab on show (a click, a close landing on a neighbour, a
  // move, a new window) ends here, so none of them has to remember to.
  createEffect(
    () => windows().map((w) => w.activeId).filter((id) => id !== "" && live[id] !== true),
    (woken) => {
      if (woken.length === 0) return;
      setLive((l) => {
        for (const id of woken) l[id] = true;
      });
      setAsleep((a) => {
        for (const id of woken) delete a[id];
      });
      if (TEST_HOOKS) for (const id of woken) console.error(`ND_APP WAKE tab=${id}`);
    },
  );

  // Every live view is shown in the slot of the window that lists its tab:
  // a tab moving windows, a view being created or remounted and a window
  // being rebuilt all land here, once the view and the slot it belongs in
  // both exist.
  createEffect(
    () => {
      mounts();
      return windows().map((w) => ({ id: w.id, tabs: w.tabs.map((t) => t.id) }));
    },
    (layout) => {
      for (const w of layout) {
        const slot = slots.get(w.id);
        if (!slot) continue;
        for (const id of w.tabs) {
          const node = views.get(id);
          if (!node) continue;
          const where = `${node.id}>${slot.id}`;
          if (placed.get(id) === where) continue;
          moveNode(node, slot);
          placed.set(id, where);
          if (TEST_HOOKS) console.error(`ND_APP PLACE tab=${id} window=${w.id}`);
        }
      }
    },
  );

  // A new search engine changes what a right-click should show; a view that
  // mounts pushes its own. The push is skipped when the tree is unchanged.
  createEffect(
    () => [JSON.stringify(appContextMenuItems()), mounts()] as const,
    () => syncContextMenus(),
  );

  function refreshHistory(): void {
    // Unchanged rows keep the old list, so a title or visit that does not move
    // the recent list renders nothing.
    void recentVisits().then((next) =>
      setHistory((h) =>
        h.length === next.length && h.every((v, i) => v.url === next[i]!.url && v.title === next[i]!.title && v.ts === next[i]!.ts) ? h : next,
      ),
    );
  }

  // ---------------------------------------------------------------- tabs ---

  /// Returns the new tab's id: chrome.tabs.create has to answer with a tab.
  function openTab(windowId: string, rawUrl: string, background = false, index?: number): string {
    const page = nativePage(rawUrl);
    if (page && page !== "newtab") {
      openNativePage(page);
      return "";
    }
    const url = page === "newtab" ? "" : rawUrl;
    if (url !== "" && !reachable(url)) return "";
    let created = "";
    session.update((s) => {
      const id = `t${s.nextTabId}`;
      created = id;
      const target = s.windows.some((w) => w.id === windowId && w.tabs.length > 0) ? windowId : s.windows[0]!.id;
      return {
        ...s,
        nextTabId: s.nextTabId + 1,
        windows: s.windows.map((w) => {
          if (w.id !== target) return w;
          const at = Math.max(0, Math.min(w.tabs.length, index ?? w.tabs.length));
          const tabs = [...w.tabs.slice(0, at), { ...blankTab(id), url }, ...w.tabs.slice(at)];
          return { ...w, tabs, activeId: background ? w.activeId : id };
        }),
      };
    });
    return created;
  }

  /// A tab a PAGE asked for: `window.open`, target=_blank, a ctrl- or
  /// middle-click, and an extension's `chrome.tabs.create`. An empty or
  /// about:blank URL is not a tab worth opening, it is a dead one; 0.4.10
  /// carries the real URL, so a blank one means the route had nothing to say.
  /// It lands where Chrome puts it (`placeOpenedTab`), in the opener's window;
  /// a background one loads when it is first shown.
  function openTabFromPage(fromTab: string, e: { text: string }): void {
    const request = newWindowRequest(e);
    const target = request.url.trim();
    if (!target || target === "about:blank") return;
    if (TEST_HOOKS) console.error(`ND_APP NEW_WINDOW from=${fromTab} how=${request.disposition ?? "-"} gesture=${request.userGesture ?? "-"} extension=${request.fromExtension ?? false} ${target}`);
    if (request.disposition === "window") {
      newWindow(target);
      return;
    }
    const win = windowOfTab(session.get(), fromTab) ?? session.get().windows.find((w) => w.id === focusedWindowId());
    if (!win) return;
    // A tab Chrome made on its own has no opener: Chrome adds it at the end.
    const opener = request.fromExtension ? "" : fromTab;
    const place = placeOpenedTab(win.tabs, opener, openers, request.disposition);
    const id = openTab(win.id, target, !place.foreground, place.index);
    if (id && opener) openers.set(id, opener);
  }

  /// Where a native page's routes land: its panel in the focused window, the
  /// command bar for tab search. The new tab page is a tab with no address,
  /// so its routes never reach here.
  function openNativePage(page: "downloads" | "history" | "bookmarks" | "tabSearch"): void {
    const controller = controllers.get(focusedWindowId());
    if (page === "tabSearch") controller?.openSwitcher();
    else controller?.openPanel(page);
  }

  /// A Chrome shortcut the page had the keyboard for (cmd+shift+N, cmd+Y, …).
  /// The engine refuses Chromium's own window or panel for it and names the
  /// command instead; this runs the app's equivalent, and drops the ones the
  /// app has none for.
  function onBrowserCommand(fromTab: string, name: string): void {
    const windowId = windowOfTab(session.get(), fromTab)?.id ?? focusedWindowId();
    const controller = controllers.get(windowId);
    switch (name) {
      case "newWindow":
        return newWindow();
      case "newPrivateWindow":
        return void setPrivateOpen(true);
      case "newTab":
        openTab(windowId, "");
        return;
      case "reopenClosedTab":
        return reopenTab(windowId);
      case "closeTab":
        return requestCloseTab(fromTab);
      case "nextTab":
        return cycleTab(windowId, 1);
      case "previousTab":
        return cycleTab(windowId, -1);
      case "downloads":
      case "history":
      case "bookmarks":
        return controller?.openPanel(name);
      case "bookmarkPage":
        return controller?.bookmarkPage();
      case "settings":
        return void setSettingsOpen(true);
      case "extensions":
        openTab(windowId, "chrome://extensions");
        return;
      case "find":
        return setFind(fromTab, (f) => ({ ...f, open: true }));
      case "findNext":
        return findCommand(fromTab, "findNext");
      case "findPrevious":
        return findCommand(fromTab, "findPrevious");
      case "focusAddress":
        return controller?.openAddress();
      case "fullscreen":
        return controller?.toggleFullscreen();
      case "print": {
        // The page's own print, which opens the system print panel.
        const node = view(fromTab);
        if (node) void executeJavaScript(node, "window.print()").catch(() => {});
        return;
      }
    }
  }

  /// Everything a tab leaves behind at the root, for a tab that is gone.
  function forgetTab(id: string): void {
    dismissPromptsFor(id);
    views.delete(id);
    placed.delete(id);
    sentMenus.delete(id);
    scrollMemory.delete(id);
    setLive((l) => void delete l[id]);
    setAsleep((a) => void delete a[id]);
    setFinds((f) => void delete f[id]);
  }

  /// The last tab takes its window with it. When that is the last window the
  /// app has, the host quits once the window is gone, as it does when that
  /// window is closed.
  function closeTab(id: string): void {
    const gone = tabOf(id);
    if (!gone) return;
    closed.push({ url: gone.url, title: gone.title });
    forgetTab(id);
    session.update((s) =>
      withoutEmptyWindows({
        ...s,
        windows: s.windows.map((w) => {
          const index = w.tabs.findIndex((t) => t.id === id);
          if (index < 0) return w;
          const rest = w.tabs.filter((t) => t.id !== id);
          const activeId = w.activeId === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? "") : w.activeId;
          return { ...w, tabs: rest, activeId };
        }),
      }),
    );
  }

  /// Tabs whose page is being asked whether it may go.
  const closing = new Set<string>();

  /// A close the user asked for. The page's beforeunload is asked first, as in
  /// Chrome, and the tab goes once it agrees ("Leave site?" answered Leave, or
  /// nothing to ask). A tab with no page has nothing to ask.
  function requestCloseTab(id: string): void {
    const node = view(id);
    if (!node || !isLive(id)) return closeTab(id);
    closing.add(id);
    sendCommand(node, "requestClose");
  }

  /// A window the user closed. Its tabs go with it, the way closing a window
  /// in any browser does. The last one is left in the session as it stands:
  /// the app is quitting, and that window is what a relaunch restores.
  function onWindowClosed(windowId: string): void {
    const s = session.get();
    const w = s.windows.find((x) => x.id === windowId);
    if (!w || windows().length <= 1) return;
    for (const t of w.tabs) {
      closed.push({ url: t.url, title: t.title });
      forgetTab(t.id);
    }
    session.update((x) => ({ ...x, windows: x.windows.filter((y) => y.id !== windowId) }));
  }

  /// Pinning moves the tab to the end of the pinned block and unpinning moves
  /// it to the head of the rest, which is the same index either way. Keeping
  /// the array in sidebar order is what lets Ctrl+Tab and the Tabs menu walk
  /// the tabs in the order they are drawn.
  function setPinned(id: string, pinned: boolean): void {
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) => {
        const tab = w.tabs.find((t) => t.id === id);
        if (!tab || tab.pinned === pinned) return w;
        const rest = w.tabs.filter((t) => t.id !== id);
        const boundary = rest.filter((t) => t.pinned).length;
        const pinnedUrl = pinned ? tab.url : undefined;
        return { ...w, tabs: [...rest.slice(0, boundary), { ...tab, pinned, pinnedUrl }, ...rest.slice(boundary)] };
      }),
    }));
  }

  /// A tab with a page to let go of. The one on show can sleep only when its
  /// window has another tab to show instead.
  function canSleep(id: string): boolean {
    const w = windowOfTab(session.get(), id);
    const tab = w?.tabs.find((t) => t.id === id);
    if (!w || !tab || tab.url === "" || !isLive(id)) return false;
    return w.activeId !== id || w.tabs.length > 1;
  }

  /// Put to Sleep: the tab's browser is closed, which is what gives its
  /// renderer's memory back, and the tab keeps its place, title, icon and
  /// address, and loads again when it is next shown. The tab on show hands
  /// the window to the nearest tab that is still awake, so sleeping one page
  /// does not load another.
  async function sleepTab(id: string): Promise<void> {
    if (!canSleep(id)) return;
    const node = view(id);
    if (node) {
      // The engine answers with the result's string rendering.
      const answer = await Promise.race([
        executeJavaScript(node, "Math.round(scrollX) + ',' + Math.round(scrollY)").catch(() => null),
        Bun.sleep(500).then(() => null),
      ]);
      const [x, y] = String(answer ?? "").split(",").map(Number);
      if ((x || y) && Number.isFinite(x) && Number.isFinite(y)) scrollMemory.set(id, [x!, y!]);
    }
    // The page may have been closed or shown while its scroll was read.
    if (!canSleep(id)) return;
    const w = windowOfTab(session.get(), id)!;
    if (w.activeId === id) {
      const at = w.tabs.findIndex((t) => t.id === id);
      const others = w.tabs
        .map((t, i) => ({ t, d: Math.abs(i - at) * 2 + (i < at ? 1 : 0) }))
        .filter(({ t }) => t.id !== id)
        .sort((a, b) => Number(!isLive(a.t.id)) - Number(!isLive(b.t.id)) || a.d - b.d);
      selectTab(others[0]!.t.id);
    }
    dismissPromptsFor(id);
    views.delete(id);
    placed.delete(id);
    sentMenus.delete(id);
    committed.delete(id);
    setFinds((f) => void delete f[id]);
    setLive((l) => void delete l[id]);
    setAsleep((a) => void (a[id] = true));
    patch(id, { loading: false, progress: 0, canGoBack: false, canGoForward: false, error: null });
    if (TEST_HOOKS) console.error(`ND_APP SLEEP tab=${id} scroll=${scrollMemory.get(id)?.join(",") ?? "top"}`);
  }

  /// A woken page is put back where it was scrolled to once it has loaded.
  function onLoading(id: string, loading: boolean): void {
    // A new document has no reader over it, whatever the last one had.
    patch(id, loading ? { loading, reading: false } : { loading });
    const at = scrollMemory.get(id);
    const node = view(id);
    // Until the page has committed, the view is still on the blank page it
    // was created with.
    if (loading || !at || !node || !committed.has(id)) return;
    scrollMemory.delete(id);
    void executeJavaScript(node, `window.scrollTo(${at[0]}, ${at[1]})`).catch(() => {});
    if (TEST_HOOKS) console.error(`ND_APP SCROLLBACK tab=${id} to=${at[0]},${at[1]}`);
  }

  /// Every other tab in the window that is not pinned: pinned tabs are the
  /// ones kept on purpose.
  function closeOtherTabs(id: string): void {
    const w = session.get().windows.find((x) => x.tabs.some((t) => t.id === id));
    if (!w) return;
    for (const t of w.tabs) if (t.id !== id && !t.pinned) requestCloseTab(t.id);
  }

  function resetPinned(id: string): void {
    const tab = tabOf(id);
    if (tab?.pinned && tab.pinnedUrl && tab.pinnedUrl !== tab.url) navigate(id, tab.pinnedUrl);
  }

  function reopenTab(windowId: string): void {
    const last = closed.pop();
    if (last) openTab(windowId, last.url);
  }

  function selectTab(id: string): void {
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) => (w.tabs.some((t) => t.id === id) && w.activeId !== id ? { ...w, activeId: id } : w)),
    }));
    applyZoom(id, tabOf(id)?.url ?? "", true);
    refreshActionStates();
  }

  function cycleTab(windowId: string, step: number): void {
    const w = session.get().windows.find((x) => x.id === windowId && x.tabs.length > 0);
    if (!w || w.tabs.length < 2) return;
    const at = w.tabs.findIndex((t) => t.id === w.activeId);
    selectTab(w.tabs[(at + step + w.tabs.length) % w.tabs.length]!.id);
  }

  function setTabUrl(id: string, url: string): void {
    if (tabOf(id)?.url === url) return;
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) =>
        w.tabs.some((t) => t.id === id) ? { ...w, tabs: w.tabs.map((t) => (t.id === id ? { ...t, url } : t)) } : w,
      ),
    }));
  }

  function navigate(id: string, raw: string): void {
    const target = toUrl(raw);
    if (!target) return;
    const page = nativePage(target);
    if (page === "newtab") return setTabUrl(id, "");
    if (page) return openNativePage(page);
    if (!reachable(target)) return;
    patch(id, { error: null });
    // Entering the address you are already on reloads, like every browser. The
    // url prop alone cannot express that: it is unchanged, so nothing commits.
    if (tabOf(id)?.url === target) {
      const node = view(id);
      if (node) sendCommand(node, "reload");
      return;
    }
    setTabUrl(id, target);
    // A view already showing a page cannot walk to one of these (see
    // createAtUrl), so the address bar builds the view again at the address
    // instead of sending the existing one to it. `attempt` keys the view, so
    // a new one is a new view.
    if (createAtUrl(target)) patch(id, { attempt: rt(id).attempt + 1 });
  }

  /// chrome:// and chrome-extension:// exist only under Chromium. The system
  /// engine hands an address it does not know to the OS, which is where the
  /// macOS "no application set to open the URL" dialog came from.
  function reachable(url: string): boolean {
    if (!createAtUrl(url)) return true;
    if (chromium()) return true;
    toast("This address needs the Chromium engine");
    return false;
  }

  function onNavigated(id: string, url: string): void {
    // A view the engine refused to move, or one still holding the blank page
    // it was created with, reports about:blank. That is the engine saying
    // nothing happened, not the user going somewhere, and writing it into the
    // tab would put about:blank in the restored session.
    if (url === "about:blank" && (tabOf(id)?.url ?? "") !== "") return;
    // A link, a redirect or a restored tab reaching one of Chromium's pages the
    // app draws itself: the tab goes back to what it was showing (the new tab
    // page when that is nothing) and the native surface opens instead.
    const page = nativePage(url);
    if (page) {
      if (page !== "newtab") openNativePage(page);
      const back = committed.get(id);
      if (page !== "newtab" && rt(id).canGoBack && back) command(id, "goBack");
      else setTabUrl(id, "");
      return;
    }
    // A page that navigated away is not waiting for its own answer any more,
    // and the id would otherwise stay in the queue for ever.
    dismissPromptsFor(id);
    // Somewhere else now, however it got there: a link, a redirect, back or
    // forward. Chromium's own error page for the failed address reports that
    // same address, which keeps the error up.
    const failed = rt(id).error;
    if (failed && failed.url !== url) patch(id, { error: null });
    // A page that changes its address without loading a new document keeps
    // the reader up over an article it no longer shows.
    const before = committed.get(id);
    if (rt(id).reading && before !== url) {
      patch(id, { reading: false });
      const node = view(id);
      if (node) void executeJavaScript(node, leaveReaderScript()).catch(() => {});
    }
    committed.set(id, url);
    setTabUrl(id, url);
    applyZoom(id, url);
    if (isShown(id)) refreshActionStates();
    void recordVisit(url, "").then(refreshHistory);
  }

  function onTitled(id: string, title: string): void {
    const url = tabOf(id)?.url ?? "";
    // A restored tab that has not been looked at yet still shows the blank
    // page its view was created with, and the engine reports that page's title
    // for it. Taking it would relabel a real tab "about:blank" in the row and
    // in the restored session, which is what the owner saw.
    if (title === "about:blank" && url !== "") return;
    if (tabOf(id)?.title !== title)
      session.update((s) => ({
        ...s,
        windows: s.windows.map((w) =>
          w.tabs.some((t) => t.id === id) ? { ...w, tabs: w.tabs.map((t) => (t.id === id ? { ...t, title } : t)) } : w,
        ),
      }));
    void recordTitle(url, title).then(refreshHistory);
  }

  function zoomFor(url: string): number {
    return state.zoomByHost[hostOf(url)] ?? 1;
  }

  /// `unlessSet`: a view already at its host's factor, as last sent or last
  /// reported by the engine, is left alone. A tab switch passes it, so the
  /// switch's commit is not queued behind a command that changes nothing.
  function applyZoom(id: string, url: string, unlessSet = false): void {
    const node = view(id);
    if (!node) return;
    const factor = session.get().zoomByHost[hostOf(url)] ?? 1;
    if (unlessSet && viewZoom.get(node) === factor) return;
    viewZoom.set(node, factor);
    sendCommand(node, "setZoom", factor);
  }

  function setZoom(tabId: string, next: number): void {
    if (!rememberZoom(tabId, next)) return;
    const node = view(tabId);
    if (!node) return;
    viewZoom.set(node, clampZoom(next));
    sendCommand(node, "setZoom", clampZoom(next));
  }

  /// A step from the menu, the palette or the zoom popover. The popover shows
  /// for a moment so the new value is visible, as it is after a chord.
  function zoomStep(tabId: string, direction: 1 | -1 | 0): void {
    const current = session.get().zoomByHost[hostOf(tabOf(tabId)?.url ?? "")] ?? 1;
    setZoom(tabId, direction === 0 ? 1 : stepZoom(current, direction));
    bumpZoomNotice(tabId);
  }

  function bumpZoomNotice(tabId: string): void {
    setRuntime((r) => {
      const cur = r[tabId];
      if (cur) cur.zoomNotice += 1;
      else r[tabId] = { ...IDLE, zoomNotice: 1 };
    });
  }

  function rememberZoom(tabId: string, factor: number): boolean {
    const host = hostOf(tabOf(tabId)?.url ?? "");
    if (!host) return false;
    const clamped = clampZoom(factor);
    session.update((s) => ({ ...s, zoomByHost: { ...s.zoomByHost, [host]: clamped } }));
    return true;
  }

  /// The engine serves a zoom chord and ctrl+wheel inside the page itself; the
  /// app keeps the factor for the host and shows the popover. Changes the app
  /// made, and a level Chromium restored on navigation, need nothing here.
  function onZoomChanged(tabId: string, data: unknown): void {
    const change = data as { factor: number; source: string };
    const node = view(tabId);
    if (node) viewZoom.set(node, change.factor);
    if (change.source !== "page") return;
    if (!rememberZoom(tabId, change.factor)) return;
    bumpZoomNotice(tabId);
  }

  function command(tabId: string, name: "goBack" | "goForward" | "reload" | "stop" | "exitFullscreen"): void {
    // Reloading the address that failed is Try Again by another name.
    if (name === "reload") patch(tabId, { error: null });
    const node = view(tabId);
    if (node) sendCommand(node, name);
  }

  // ------------------------------------------------ reading and floating ---

  /// The app's own light or dark, which the reader follows. The app has no
  /// appearance setting of its own: it is the system's.
  let appearance: "light" | "dark" = "light";
  onSettled(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void firstCommit.then(() => {
      if (gone) return;
      void system
        .getAppearance()
        .then((a) => {
          appearance = a.appearance;
          if (setFaviconAppearance(a.appearance)) setIconEpoch((n) => n + 1);
        })
        .catch(() => {});
      stop = system.onAppearanceChange((a) => {
        appearance = a.appearance;
        if (setFaviconAppearance(a.appearance)) setIconEpoch((n) => n + 1);
        for (const [id, node] of views) {
          if (runtime[id]?.reading) void executeJavaScript(node, readerSchemeScript(a.appearance)).catch(() => {});
        }
      });
      // The lists reach the host while Chromium is still starting, and the
      // window never waits on them.
      startContentBlocking();
    });
    return () => {
      gone = true;
      stop?.();
    };
  });

  function toggleReader(tabId: string): void {
    const node = view(tabId);
    if (!node || !chromium()) return;
    void executeJavaScript(node, toggleReaderScript(appearance))
      .then((answer) => {
        const state = readerState(answer);
        if (TEST_HOOKS) console.error(`ND_APP READER ${tabId} ${state}`);
        patch(tabId, { reading: state === "on" });
        if (state === "none") toast("No article to read on this page");
        if (state === "on") {
          hearReaderEscape(node);
          // The keyboard goes to the reader, wherever it was: Space and Page
          // Down scroll it and Escape leaves.
          sendCommand(node, "focus");
        }
      })
      .catch((e: unknown) => {
        console.error(`ND_APP READER failed ${String(e)}`);
        toast("This page cannot be shown in reading mode");
      });
  }

  // ----------------------------------------------------------- blocking ---

  /// The ⇧⌘H picker, asleep in an isolated world of each tab's main frame.
  /// Guarded by widget id: a view is armed once.
  const hiderArmed = new Set<number>();
  function armHider(node: NdNodeRef<"webview">): void {
    if (!chromium() || hiderArmed.has(node.id)) return;
    hiderArmed.add(node.id);
    sendCommand(node, "addUserScript", { id: "nb-hide", source: HIDER_SOURCE, injectionTime: "start", world: HIDER_WORLD });
    sendCommand(node, "registerScriptMessage", { name: HIDER_CHANNEL, world: HIDER_WORLD });
  }

  function toggleHiding(tabId: string): void {
    const node = view(tabId);
    if (!node || !chromium() || !siteOf(tabOf(tabId)?.url ?? "")) return;
    void executeJavaScript(node, "window.__nbHide && window.__nbHide.toggle()", HIDER_WORLD).catch(() => {});
  }

  function onHiderMessage(tabId: string, m: HiderMessage): void {
    if ("off" in m) return;
    if ("trouble" in m) {
      toast("Unable to hide that element");
      return;
    }
    if (TEST_HOOKS) console.error(`ND_APP HIDDEN ${tabId} ${m.pick.selector}`);
    void hide(siteOf(tabOf(tabId)?.url ?? ""), m.pick);
  }

  async function toggleBlocking(tabId: string): Promise<void> {
    const site = siteOf(tabOf(tabId)?.url ?? "");
    if (TEST_HOOKS) console.error(`ND_APP BLOCKING toggle ${tabId} site=${site}`);
    if (!site) return;
    const on = !blockingOn(site);
    await setBlockingOn(site, on);
    if (TEST_HOOKS) console.error(`ND_APP BLOCKING ${site} ${on ? "on" : "off"}`);
    toast(on ? `Blocking ads on ${site}` : `Allowing ads on ${site}`);
    command(tabId, "reload");
  }

  async function restoreHiddenOn(tabId: string): Promise<void> {
    const site = siteOf(tabOf(tabId)?.url ?? "");
    if (!site) return;
    await restoreHidden(site);
    command(tabId, "reload");
  }

  async function updateLists(): Promise<void> {
    toast("Updating filter lists");
    const changed = await refresh(true);
    toast(changed ? "Filter lists updated" : "Filter lists are up to date");
  }

  function blockingFor(tabId: string): { site: string; on: boolean; hidden: number; blocked: number } {
    const site = siteOf(tabOf(tabId)?.url ?? "");
    return {
      site,
      on: blockingOn(site, blockingState()),
      hidden: hiddenOn(site, blockingState()).length,
      blocked: rt(tabId).blocked,
    };
  }

  /// Views whose reader channel is registered; one registration serves every
  /// document the view loads.
  const readerChannels = new Set<number>();
  function hearReaderEscape(node: NdNodeRef<"webview">): void {
    if (!readerChannels.has(node.id)) {
      readerChannels.add(node.id);
      sendCommand(node, "registerScriptMessage", { name: READER_CHANNEL, world: READER_WORLD });
    }
    void executeJavaScript(node, READER_BRIDGE_SCRIPT, READER_WORLD).catch(() => {});
  }

  function toggleFloat(tabId: string): void {
    const node = view(tabId);
    if (!node || !chromium()) return;
    void executeJavaScript(node, FLOAT_SCRIPT, undefined, { userGesture: true })
      .then((answer) => {
        const state = floatState(answer);
        if (TEST_HOOKS) console.error(`ND_APP FLOAT ${tabId} ${state}`);
        if (state === "none") toast("No video on this page");
        else if (state.startsWith("error:")) toast("This video cannot float");
      })
      .catch((e: unknown) => console.error(`ND_APP FLOAT failed ${String(e)}`));
  }

  /// A floating window (a video, or a page's own picture in picture) is the
  /// engine's; back to tab from it brings its tab forward.
  function onPictureInPicture(tabId: string, data: unknown): void {
    const { state, kind } = data as { state: string; kind: string };
    if (TEST_HOOKS) console.error(`ND_APP PIP ${tabId} ${kind} ${state}`);
    if (state === "returnToTab") selectTab(tabId);
  }

  /// The sidebar pane is the only thing the two layouts disagree about, and it
  /// is a SIBLING of the content pane rather than its ancestor: dropping it
  /// leaves every window's page slot at the same place in the tree, so the
  /// live pages survive the switch instead of remounting.
  function setLayout(next: Layout): void {
    settings.update((s) => (s.layout === next ? s : { ...s, layout: next }));
  }

  // ------------------------------------------------------------- windows ---

  function newWindow(url = ""): void {
    let created = "";
    session.update((s) => {
      created = `w${s.nextWindowId}`;
      const tab = { ...blankTab(`t${s.nextTabId}`), url };
      return {
        ...s,
        nextWindowId: s.nextWindowId + 1,
        nextTabId: s.nextTabId + 1,
        windows: [...s.windows, { id: created, tabs: [tab], activeId: tab.id, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }],
      };
    });
    setFocusedId(created);
  }

  /// The one path every tab move takes: a drop, a menu item and a keyboard
  /// shortcut all end here. Within a window it is a reorder; into another it
  /// moves the LIVE page, which the placement effect above carries over with
  /// moveNode, so the page is not reloaded. A window left with no tabs closes.
  function moveTab(tabId: string, toWindowId: string, index: number): void {
    const s = session.get();
    const from = windowOfTab(s, tabId);
    if (!from) return;
    // Into a window that already exists, the view moves NOW, before the
    // session changes: a window its last tab left is taken down in the very
    // commit that lists the tab elsewhere, and the host would take the live
    // view down with it before the placement effect ran.
    const node = views.get(tabId);
    const slot = slots.get(toWindowId);
    if (node && slot && from.id !== toWindowId) {
      moveNode(node, slot);
      placed.set(tabId, `${node.id}>${slot.id}`);
    }
    session.set(withoutEmptyWindows(moveTabIn(s, tabId, toWindowId, index)));
    setFocusedId(toWindowId);
    if (TEST_HOOKS) console.error(`ND_APP MOVE tab=${tabId} from=${from.id} to=${toWindowId} index=${index}`);
    // A request the page is still waiting on is answered from the window it
    // is in now.
    if (pending.some((q) => q.tabId === tabId)) controllers.get(toWindowId)?.openSiteInfo();
  }

  function moveTabBy(tabId: string, step: number): void {
    const w = windowOfTab(session.get(), tabId);
    if (!w) return;
    const at = w.tabs.findIndex((t) => t.id === tabId);
    moveTab(tabId, w.id, at + step);
  }

  /// "new" is a new window, "private" the private window, anything else a
  /// normal window's id. A private window's pages live on a profile of their
  /// own, so a tab crossing into one is reopened there at its address and
  /// closed here: its live page cannot come along.
  function moveTabTo(tabId: string, target: string): void {
    if (target === "private") {
      const tab = tabOf(tabId);
      if (!tab || !privateBridge.current) return;
      privateBridge.current.open(tab.url, Number.MAX_SAFE_INTEGER);
      if (TEST_HOOKS) console.error(`ND_APP MOVE tab=${tabId} to=private reopened`);
      closeTab(tabId);
      return;
    }
    if (target === "new") {
      // A window's only tab is already in a window of its own.
      if ((windowOfTab(session.get(), tabId)?.tabs.length ?? 0) < 2) return;
      let created = "";
      session.update((s) => {
        created = `w${s.nextWindowId}`;
        return {
          ...s,
          nextWindowId: s.nextWindowId + 1,
          windows: [...s.windows, { id: created, tabs: [], activeId: "", width: WINDOW_WIDTH, height: WINDOW_HEIGHT }],
        };
      });
      moveTab(tabId, created, 0);
      return;
    }
    moveTab(tabId, target, Number.MAX_SAFE_INTEGER);
  }

  function onTabDropped(windowId: string, payload: string, index: number): void {
    setDropHintState(null);
    const drag = parseTabPayload(payload);
    if (!drag) return;
    if (drag.profile === "private") {
      openTab(windowId, drag.url, false, index);
      privateBridge.current?.close(drag.tabId);
      return;
    }
    const from = windowOfTab(session.get(), drag.tabId);
    if (!from) return;
    // The slot was counted with the dragged tab still in the row.
    const at = from.tabs.findIndex((t) => t.id === drag.tabId);
    moveTab(drag.tabId, windowId, from.id === windowId && at < index ? index - 1 : index);
  }

  function moveTargets(fromWindowId: string): MoveTarget[] {
    const targets: MoveTarget[] = windows()
      .filter((w) => w.id !== fromWindowId)
      .map((w) => ({
        id: w.id,
        label: windowLabel(w.tabs.find((t) => t.id === w.activeId) ?? w.tabs[0]!, w.tabs.length),
      }));
    if (privateOpen()) targets.push({ id: "private", label: "Private Browsing" });
    return targets;
  }

  // ---------------------------------------------------------------- find ---

  const findFor = (tabId: string): FindState => finds[tabId] ?? NO_FIND;
  const setFind = (tabId: string, next: (f: FindState) => FindState): void =>
    void setFinds((all) => {
      all[tabId] = next(all[tabId] ?? NO_FIND);
    });

  /// Find is per tab: a search runs on that tab's page and stays with it,
  /// whichever window the tab is in.
  function findCommand(tabId: string, name: "findStart" | "findNext" | "findPrevious" | "findStop", arg?: unknown): void {
    const node = view(tabId);
    if (node) sendCommand(node, name, arg);
  }

  function closeFind(tabId: string): void {
    findCommand(tabId, "findStop");
    setFind(tabId, () => NO_FIND);
    const node = view(tabId);
    if (node) sendCommand(node, "focus");
  }

  function runFind(tabId: string, text: string): void {
    setFind(tabId, (f) => ({ ...f, open: true, query: text, count: null }));
    if (text) findCommand(tabId, "findStart", { text });
    else findCommand(tabId, "findStop");
  }

  // ---------------------------------------------------- permissions ---

  /// The queue is a plain array with the signal mirroring it, because the two
  /// exits from it can happen in one turn: answering the prompt on show closes
  /// the popover, and the close handler must then find the queue already
  /// short of it rather than answer the same id twice.
  function setQueue(next: PermissionPrompt[]): void {
    pending = next;
    setPrompts(next);
  }

  function respond(tabId: string, id: string, result: PermissionResult): void {
    const node = view(tabId);
    if (node) sendCommand(node, "respondPermission", { id, result });
    if (TEST_HOOKS) console.error(`ND_APP PERMISSION id=${id} result=${result}`);
  }

  function answerPrompt(prompt: PermissionPrompt, result: PermissionResult): void {
    respond(prompt.tabId, prompt.id, result);
    setQueue(pending.filter((q) => q.id !== prompt.id));
  }

  /// Everything that takes a prompt away without the user choosing: escape, a
  /// click outside the popover, the tab navigating, the tab closing. The page
  /// hears a refusal and nothing is remembered, which is what Chrome does with
  /// a dismissed bubble; a `deny` here would have Chromium record a block. An
  /// id left unanswered would leave the page waiting for ever.
  function dismissPromptsFor(tabId: string): void {
    const doomed = pending.filter((q) => q.tabId === tabId);
    if (doomed.length === 0) return;
    for (const prompt of doomed) respond(tabId, prompt.id, "dismiss");
    setQueue(pending.filter((q) => q.tabId !== tabId));
  }

  function onPermissionRequest(tabId: string, data: unknown): void {
    const request = (data ?? {}) as { id?: string; origin?: string; types?: string };
    if (!request.id) return;
    const types = splitTypes(request.types ?? "");
    const origin = request.origin ?? "";
    const decided = rememberedDecision(settings.get().sitePermissions, origin, types);
    if (decided) {
      respond(tabId, request.id, decided === "allow" ? "allow" : "deny");
      return;
    }
    setQueue([...pending, { id: request.id, tabId, origin, types }]);
    // The bubble opens itself for a tab being looked at, the way Chrome's
    // does; a background tab's request waits for the tab.
    const w = windowOfTab(session.get(), tabId);
    if (w && w.activeId === tabId) controllers.get(w.id)?.openSiteInfo();
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
    answerPrompt(prompt, decision === "allow" ? "allow" : "deny");
  }

  /// Chromium holds the decisions that pages actually see, so a reset takes
  /// them out of it as well as out of the list the site-info panel shows.
  function resetSiteDecisions(tabId: string, origin: string): void {
    const types = Object.keys(settings.get().sitePermissions[normalizeOrigin(origin)] ?? {});
    const node = view(tabId);
    if (node && types.length > 0) sendCommand(node, "resetPermissions", { origin, types });
    settings.update((s) => ({ ...s, sitePermissions: forgetOrigin(s.sitePermissions, origin) }));
  }

  // ------------------------------------------------------ extensions ---

  /// Chromium's user agent is the one runtime fact that separates the engines
  /// without asking for a page either of them would refuse. WebKitGTK and
  /// WKWebView both report AppleWebKit and Safari and neither reports Chrome.
  function probeEngine(node: NdNodeRef<"webview">, attempt = 0): void {
    // One chain, and none once the answer is in. A retry that outlived the
    // answer would keep evaluating against a view the registry key has
    // already rebuilt, and an executeJavaScript aimed at a widget that is
    // gone stops the host answering anything at all.
    if (engineProbed || extRegistry !== node) return;
    if (attempt > 0 && TEST_HOOKS) console.error(`ND_APP ENGINE retry=${attempt}`);
    void executeJavaScript(node, "navigator.userAgent")
      .then((ua) => {
        if (engineProbed) return;
        const agent = String(ua ?? "");
        // A view that has not committed a document yet answers with nothing,
        // which is not an answer about the engine.
        if (!agent) {
          if (attempt < 20) setTimeout(() => probeEngine(node, attempt + 1), 400);
          return;
        }
        const found = /Chrome\//.test(agent) ? "chromium" : "system";
        engineProbed = true;
        if (TEST_HOOKS) console.error(`ND_APP ENGINE ${found}`);
        setEngine(found);
      })
      .catch((e: unknown) => {
        if (engineProbed) return;
        if (TEST_HOOKS) console.error(`ND_APP ENGINE failed=${String(e)}`);
        if (attempt < 20) setTimeout(() => probeEngine(node, attempt + 1), 400);
      });
  }

  /// Both halves of the list, from the one view Chromium answers on. The
  /// registry reports its own changes now (`watchExtensions`), so this runs on
  /// what that reports, plus once when the panel is opened: a list nobody is
  /// watching is worse than one read a moment too often.
  function refreshExtensions(): void {
    const node = extRegistry;
    if (!node) return;
    void listExtensions(node)
      .then((list) => {
        for (const gone of knownExtensions) {
          if (!list.some((e) => e.id === gone)) closeExtensionTabs(gone);
        }
        knownExtensions = list.map((e) => e.id);
        setRegistry(list);
        // Chrome's "added" bubble hangs off a toolbar the app never shows.
        for (const [id, name] of storeInstalls) {
          const added = list.find((e) => e.id === id);
          if (!added) continue;
          storeInstalls.delete(id);
          if (TEST_HOOKS) console.error(`ND_APP STORE_ADDED id=${id}`);
          toast(`Added “${added.name || name}”`);
        }
      })
      .catch(() => {});
    void listExtensionActions(node).then(setExtActions).catch(() => {});
  }

  /// Store installs the user said yes to, by id, until they show up in the
  /// registry.
  const storeInstalls = new Map<string, string>();
  /// Views the store hook is installed on; one install serves every document
  /// the view loads.
  const storeHooked = new Set<number>();
  function hookStore(node: NdNodeRef<"webview">): void {
    if (storeHooked.has(node.id)) return;
    storeHooked.add(node.id);
    sendCommand(node, "addUserScript", { id: "nb-store", source: STORE_SCRIPT, injectionTime: "start", allowList: STORE_ORIGINS });
    sendCommand(node, "registerScriptMessage", { name: STORE_CHANNEL });
  }

  /// "Add to Chrome" on a store page: asked in the window's own dialog. A no
  /// never reaches Chromium; a yes goes on to Chromium with its own prompt
  /// answered by the engine.
  async function onStoreRequest(tabId: string, body: unknown): Promise<void> {
    const node = view(tabId);
    const request = parseStoreRequest(body);
    if (!node || !request) return;
    const fromStore = (committed.get(tabId) ?? "").startsWith("https://chromewebstore.google.com/");
    const win = windowOfTab(session.get(), tabId);
    if (TEST_HOOKS) console.error(`ND_APP STORE_ASK id=${request.id} name=${JSON.stringify(request.name)} store=${fromStore}`);
    const yes = fromStore && win
      ? ((await controllers.get(win.id)?.confirmInstall(request.name, permissionLines(request.manifest))) ?? false)
      : false;
    if (TEST_HOOKS) console.error(`ND_APP STORE_ANSWER id=${request.id} ${yes ? "add" : "cancel"}`);
    if (yes) {
      storeInstalls.set(request.id, request.name);
      acceptExtensionInstall(node);
    }
    void executeJavaScript(node, storeAnswerScript(request.id, yes)).catch(() => {});
  }

  function pinExtension(id: string): void {
    settings.update((s) => ({ ...s, pinnedExtensions: togglePinned(s.pinnedExtensions, id) }));
  }

  /// One read of an action's live state, retried while the probe's page is
  /// still loading and while the answer is for some other tab: with no view
  /// focused Chromium answers for a browser it keeps for itself, which says
  /// nothing about a tab on show. An answer for the probe's OWN tab is
  /// different: nothing sets per-tab state on a tab the app keeps hidden, so
  /// it carries the extension's defaults, which are what every tab without
  /// an override of its own shows. Resolves with the last answer either way,
  /// and `matched` says whether it was for the tab `windowId` is showing.
  async function readActionFor(
    id: string,
    windowId: string,
    tries: number,
  ): Promise<{ state: ExtensionActionState; matched: boolean } | null> {
    let last: ExtensionActionState | null = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await Bun.sleep(400);
      const node = probes.get(id);
      if (!node) continue;
      const state = await readExtensionAction(node).catch(() => null);
      if (!state) continue;
      last = state;
      const w = session.get().windows.find((x) => x.id === windowId);
      const shownUrl = w?.tabs.find((t) => t.id === w.activeId)?.url ?? "";
      if (TEST_HOOKS) console.error(`ND_APP ACTIONSTATE ${JSON.stringify(state)} shown=${shownUrl}`);
      if (state.tabUrl === shownUrl) {
        setActionStates((m) => ({ ...m, [id]: state }));
        return { state, matched: true };
      }
      if (state.tabUrl.startsWith(`chrome-extension://${id}/`)) {
        setActionDefaults((m) => ({ ...m, [id]: state }));
      }
    }
    return last ? { state: last, matched: false } : null;
  }

  /// Badges and titles are per tab, so every change of the tab on show and
  /// every change the registry reports reads them again, for the window in
  /// front.
  function refreshActionStates(only?: ReadonlySet<string>): void {
    for (const id of probes.keys()) {
      if (!only || only.has(id)) void readActionFor(id, focusedWindowId(), 4);
    }
  }

  /// The registry view's first reads can reach it before chrome://extensions
  /// has committed, and a watch that failed then was never attached again: the
  /// toolbar stayed empty for the whole session. So the watch is retried until
  /// it attaches, and the list is read once it has.
  function watchRegistry(node: NdNodeRef<"webview">, attempt: number): void {
    void watchExtensions(node, onRegistryChange)
      .then((watched) => {
        // An empty answer means the watcher attached to nothing, and a Web
        // Store install would then never show up until the panel was opened
        // by hand.
        if (watched.length === 0) console.error("ND_APP EXTWATCH attached to nothing");
        else if (TEST_HOOKS) console.error(`ND_APP EXTWATCH watching ${watched.length}`);
        refreshExtensions();
      })
      .catch((e: unknown) => {
        if (attempt < 20 && extRegistry === node) {
          setTimeout(() => watchRegistry(node, attempt + 1), 250);
          return;
        }
        console.error(`ND_APP EXTWATCH failed ${String(e)}`);
      });
  }

  /// The registry reports in bursts: a service worker starting and stopping,
  /// every page an extension opens, an install's loaded, installed and prefs
  /// events. One registry read and one badge read per extension named, ~100 ms
  /// after the burst, instead of a full re-read of everything per event.
  const registryBurst: { timer: ReturnType<typeof setTimeout> | null; ids: Set<string>; all: boolean } = {
    timer: null,
    ids: new Set(),
    all: false,
  };
  function onRegistryChange(change: ExtensionsChange): void {
    const burst = registryBurst;
    if (change.extensionId) burst.ids.add(change.extensionId);
    else burst.all = true;
    if (burst.timer) return;
    burst.timer = setTimeout(() => {
      const ids = burst.all ? undefined : new Set(burst.ids);
      burst.timer = null;
      burst.ids.clear();
      burst.all = false;
      refreshExtensions();
      refreshActionStates(ids);
    }, 100);
  }

  async function probeFor(id: string): Promise<NdNodeRef<"webview"> | null> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const node = probes.get(id);
      if (node) return node;
      await Bun.sleep(100);
    }
    return null;
  }

  /// A click on an action is decided on its live state: an extension that
  /// switched its popup off wants the click to reach `chrome.action.onClicked`,
  /// which cannot fire without a Chromium toolbar, so the nearest thing it
  /// would do is open its own setup page.
  function clickAction(windowId: string, row: ExtensionRow): void {
    if (checking === row.id) return;
    checking = row.id;
    setCheckingAction(row.id);
    void decideAction(windowId, row);
  }

  async function decideAction(windowId: string, row: ExtensionRow): Promise<void> {
    await probeFor(row.id);
    const read = await readActionFor(row.id, windowId, 6);
    if (checking !== row.id) return;
    checking = "";
    setCheckingAction("");
    // No answer at all is an engine that cannot say, not an extension that
    // switched its popup off: the manifest is all there is to go on. An
    // answer for another tab still carries the extension's own default,
    // which is what a tab with no override of its own gets.
    const live = read ? read.state.popupUrl : row.popupUrl;
    if (TEST_HOOKS) console.error(`ND_APP ACTION id=${row.id} matched=${read?.matched ?? false} popup=${JSON.stringify(live)}`);
    if (live === "") {
      await runAction(windowId, row);
      return;
    }
    controllers.get(windowId)?.showPopup(row.id, live);
  }

  /// An action with no popup is Chromium's to run: `onClicked` with the tab on
  /// show and an `activeTab` grant on it. Where the engine cannot run it (the
  /// GTK embedding, for now), the extension's own page is the closest thing.
  function shownView(windowId: string): NdNodeRef<"webview"> | null {
    const w = session.get().windows.find((x) => x.id === windowId);
    const tab = w?.tabs.find((t) => t.id === w.activeId);
    return tab && tab.url ? view(tab.id) : null;
  }

  async function runAction(windowId: string, row: ExtensionRow): Promise<void> {
    const page = shownView(windowId);
    const error = page
      ? await triggerExtensionAction(page, row.id).then(() => null, (e: Error) => e.message)
      : "no page on show";
    if (TEST_HOOKS) console.error(`ND_APP ACTION_TRIGGER id=${row.id} ${error ?? "ok"}`);
    if (error === null) {
      if (probes.has(row.id)) void readActionFor(row.id, windowId, 2);
      return;
    }
    if (row.optionsUrl) openTab(windowId, row.optionsUrl);
  }

  /// Test-only: `launchApp` passes no argv, so a drive cannot hand the host a
  /// `--load-extension`, and the Web Store needs the network. The app's own
  /// install API is the one route left.
  function installTestExtension(dir: string | undefined): void {
    const node = extRegistry;
    if (!node || !dir) return;
    void installExtension(node, dir)
      .then(() => refreshExtensions())
      .catch(() => {});
  }

  /// Chrome closes an extension's own pages with it. A window left with no
  /// tab gets an empty one, so removing an extension never quits the app.
  function closeExtensionTabs(id: string): void {
    const prefix = `chrome-extension://${id}/`;
    for (const w of session.get().windows) {
      const doomed = w.tabs.filter((t) => t.url.startsWith(prefix));
      if (doomed.length === 0) continue;
      if (doomed.length === w.tabs.length) openTab(w.id, "");
      for (const t of doomed) closeTab(t.id);
    }
  }

  function uninstallExtension(id: string): void {
    const node = extRegistry;
    if (!node) return;
    // Before the extension goes: once it is unloaded its pages navigate
    // away from its address and can no longer be told apart.
    closeExtensionTabs(id);
    void removeExtension(node, id)
      .then(() => {
        if (TEST_HOOKS) console.error(`ND_APP EXT_REMOVED id=${id}`);
        settings.update((s) => ({ ...s, pinnedExtensions: s.pinnedExtensions.filter((p) => p !== id) }));
        refreshExtensions();
      })
      .catch((e: unknown) => console.error(`ND_APP EXT_REMOVE failed id=${id} ${String(e)}`));
  }

  // ------------------------------------------------------- context menu ---

  /// The engine draws the menu: Back/Forward/Reload, Open Link in New Tab and
  /// Save Image As are its own and always there, and an item added beside
  /// them showed up twice. What is left to add is the search engine the user
  /// picked. Inspect is Chromium's own item, which opens the docked inspector
  /// on the element.
  function appContextMenuItems(): ContextMenuItem[] {
    return [
      { id: "nb-search-selection", label: `Search with ${engineOf(prefs.searchEngine).name}`, contexts: ["selection"] },
    ];
  }

  /// Pushes each tab's menu to its own view. Sent only when the tree actually
  /// changes, which is what makes calling it on every mount safe. Keyed by tab
  /// and by view, not by window: a view that moved windows keeps its menu.
  function syncContextMenus(only?: string): void {
    // One tree for every tab, built once per call rather than once per tab.
    const items = appContextMenuItems();
    const shape = JSON.stringify(items);
    for (const [id, node] of views) {
      if (only !== undefined && id !== only) continue;
      // Keyed on the widget as well as the tree: a remounted view (Try Again
      // gives the tab a new view) starts with no items of its own.
      const stamp = `${node.id}|${shape}`;
      if (sentMenus.get(id) === stamp) continue;
      sentMenus.set(id, stamp);
      setContextMenuItems(node, items);
      if (TEST_HOOKS) console.error(`ND_APP CTXMENU tab=${id} ${shape}`);
    }
  }

  /// An item the user chose in a page's context menu: one of the three above.
  function onContextMenuItem(tabId: string, click: ContextMenuItemClick): void {
    const windowId = windowOfTab(session.get(), tabId)?.id ?? focusedWindowId();
    switch (click.id) {
      case "nb-search-selection":
        if (click.selectionText) openTab(windowId, toUrl(click.selectionText) ?? "", true);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ favicon ---

  function onFavicon(tabUrl: string, data: { dataUrl?: string; iconUrl?: string }): void {
    // The page named this icon for the appearance it is showing now; the
    // fetch below can land after a switch.
    const shownIn = faviconAppearance();
    if (data.dataUrl) {
      if (rememberFavicon(tabUrl, data.dataUrl, shownIn)) setIconEpoch((n) => n + 1);
      return;
    }
    // macOS reports the icon's ADDRESS rather than its bytes, so it has to be
    // fetched before it can go in a row.
    if (data.iconUrl) {
      void fetchFavicon(tabUrl, data.iconUrl, shownIn).then((changed) => {
        if (changed) setIconEpoch((n) => n + 1);
      });
    }
  }

  // ----------------------------------------------------------- downloads ---
  //
  // Chromium runs every download: the page's cookies, POST bodies, blob: URLs
  // and the download attribute all behave as they do in Chrome. The app
  // decides where each one goes, draws every surface for it and keeps the
  // list. On the system engine the transfer is Bun's instead (fetchToFile).

  /// Any live Chromium view carries a download command: a download is the
  /// engine's, not the tab's.
  function engineView(): NdNodeRef<"webview"> | null {
    for (const node of views.values()) return node;
    return extRegistry;
  }

  function showDownloads(): void {
    controllers.get(focusedWindowId())?.openDownloads();
  }

  /// A download is not a navigation: whichever tab aimed at its URL goes back
  /// to the page it was showing, so the restored session never points at it.
  /// A tab with no page to go back to keeps its view until the download ends
  /// (`settleDownloadTabs`): its view is the browser Chromium runs the
  /// transfer in, and emptying the tab would remove it.
  function leaveDownloadTab(url: string, engineId?: string): void {
    const waiting: string[] = [];
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) => ({
        ...w,
        tabs: w.tabs.map((t) => {
          if (t.url !== url) return t;
          const back = committed.get(t.id);
          if (back === undefined && engineId) {
            waiting.push(t.id);
            return t;
          }
          return { ...t, url: back ?? "" };
        }),
      })),
    }));
    if (engineId && waiting.length) downloadTabs.set(engineId, waiting);
  }

  function settleDownloadTabs(engineId: string): void {
    const ids = downloadTabs.get(engineId);
    if (!ids) return;
    downloadTabs.delete(engineId);
    for (const id of ids) setTabUrl(id, committed.get(id) ?? "");
  }

  async function onDownloadRequested(node: NdNodeRef<"webview"> | null, req: DownloadRequest): Promise<void> {
    // One answer per download: a request can reach the app on more than one
    // view's handler, and a second answer would cancel the first.
    if (TEST_HOOKS) console.error(`ND_APP DL request ${req.id ?? "-"} ${req.url} known=${req.id ? engineDownloads.has(req.id) : false}`);
    if (req.id && engineDownloads.has(req.id)) return;
    leaveDownloadTab(req.url, req.id);
    if (!req.id) {
      void fetchDownload(req.url, req.suggestedFilename);
      return;
    }
    const engineId = req.id;
    const retryOf = retrying.get(req.url);
    retrying.delete(req.url);
    const id = retryOf ?? newDownloadId();
    engineDownloads.set(engineId, id);
    const name = downloadName(req.url, req.suggestedFilename);
    const fresh: DownloadItem = {
      id,
      engineId,
      url: req.url,
      name,
      path: "",
      state: "pending",
      received: 0,
      total: 0,
      speed: 0,
      startedAt: Date.now(),
    };
    if (retryOf) patchDownload(id, { ...fresh, reason: undefined, endedAt: undefined, partPath: undefined });
    else addDownload(fresh);
    showDownloads();

    const prefsNow = settings.get();
    const dir = ensureDir(downloadDir(prefsNow.downloadDir));
    let path = uniquePath(dir, name, reservedPaths(downloads.get().items));
    if (prefsNow.askWhereToSave) {
      const chosen = await dialog.saveFile({ defaultPath: path }).catch(() => null);
      if (!chosen) {
        const target = engineView() ?? node;
        if (target) respondDownload(target, engineId);
        settleDownloadTabs(engineId);
        engineDownloads.delete(engineId);
        removeDownload(id);
        return;
      }
      path = chosen;
    }
    // A file that runs code lands under Chrome's "Unconfirmed" name and only
    // takes its own once the user keeps it.
    const partPath = isDangerous(basename(path))
      ? join(dirname(path), `Unconfirmed ${100000 + Math.floor(Math.random() * 900000)}.crdownload`)
      : undefined;
    patchDownload(id, { path, name: basename(path), partPath, state: "inProgress" });
    // Any live view carries the answer. The one that asked can be gone by now:
    // a tab that only held the download went back to the new tab page, which
    // has no view, while the save panel was up.
    const target = engineView() ?? node;
    if (target) respondDownload(target, engineId, partPath ?? path);
  }

  function onDownloadUpdated(u: DownloadUpdate): void {
    const id = engineDownloads.get(u.id);
    if (TEST_HOOKS && u.state !== "running") console.error(`ND_APP DL update ${u.id} ${u.state} row=${id ?? "-"}`);
    if (!id) return;
    const d = downloads.get().items.find((x) => x.id === id);
    if (!d) return;
    const total = u.total > 0 ? u.total : 0;
    switch (u.state) {
      case "running": {
        const state = u.paused ? "paused" : "inProgress";
        const speed = u.paused ? 0 : (u.speed ?? 0);
        if (d.state === state && d.received === u.received && d.speed === speed && d.total === total) return;
        patchDownload(id, { received: u.received, total, speed, state });
        return;
      }
      case "failed":
        if (d.state !== "interrupted") toast(`Unable to download ${d.name}`);
        patchDownload(id, { received: u.received, total, speed: 0, state: "interrupted", reason: undefined });
        return;
      case "cancelled":
        settleDownloadTabs(u.id);
        engineDownloads.delete(u.id);
        patchDownload(id, { speed: 0, state: "cancelled", engineId: undefined, endedAt: Date.now() });
        return;
      case "done":
        settleDownloadTabs(u.id);
        engineDownloads.delete(u.id);
        patchDownload(id, {
          received: u.received,
          total: total || u.received,
          speed: 0,
          state: d.partPath ? "dangerous" : "complete",
          path: d.partPath ? d.path : u.path || d.path,
          engineId: undefined,
          endedAt: Date.now(),
        });
        if (d.partPath) showDownloads();
        else toast(`Saved ${d.name}`);
        return;
    }
  }

  async function fetchDownload(url: string, suggested?: string, retryOf?: string): Promise<void> {
    const dir = ensureDir(downloadDir(settings.get().downloadDir));
    const name = downloadName(url, suggested);
    const path = uniquePath(dir, name, reservedPaths(downloads.get().items));
    const id = retryOf ?? newDownloadId();
    const item: DownloadItem = {
      id,
      url,
      name: basename(path),
      path,
      state: "inProgress",
      received: 0,
      total: 0,
      speed: 0,
      startedAt: Date.now(),
    };
    if (retryOf) patchDownload(id, item);
    else addDownload(item);
    showDownloads();
    let last = 0;
    try {
      const received = await fetchToFile(url, path, (r, total) => {
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        patchDownload(id, { received: r, total });
      });
      patchDownload(id, { received, total: received, state: "complete", endedAt: Date.now() });
      toast(`Saved ${item.name}`);
    } catch {
      patchDownload(id, { state: "interrupted", reason: "network" });
      toast(`Unable to download ${item.name}`);
    }
  }

  const downloadActions: DownloadActions = {
    pause: (d) => {
      const node = engineView();
      if (node && d.engineId) pauseDownload(node, d.engineId);
    },
    resume: (d) => {
      const node = engineView();
      if (node && d.engineId) resumeDownload(node, d.engineId);
    },
    cancel: (d) => {
      const node = engineView();
      if (node && d.engineId) cancelDownload(node, d.engineId);
    },
    retry: (d) => {
      // Chromium resumes an interrupted download it still has from where it
      // stopped; anything else starts over from the URL.
      const node = chromium() ? engineView() : null;
      if (node && d.engineId && engineDownloads.has(d.engineId) && d.state === "interrupted") {
        resumeDownload(node, d.engineId);
        return;
      }
      if (node) {
        retrying.set(d.url, d.id);
        patchDownload(d.id, { state: "pending", received: 0, speed: 0, reason: undefined });
        engineStartDownload(node, d.url);
        return;
      }
      void fetchDownload(d.url, d.name, d.id);
    },
    open: (d) => {
      // A drive proves the open without handing its fixture to another app.
      if (TEST_HOOKS) return void console.error(`ND_APP DL open ${d.path}`);
      void openPath(d.path).catch(() => toast(`Unable to open ${d.name}`));
    },
    reveal: (d) => void revealPath(d.path).catch(() => {}),
    remove: (d) => {
      const node = engineView();
      if (isActive(d) && node && d.engineId) cancelDownload(node, d.engineId);
      removeDownload(d.id);
    },
    keep: (d) => {
      try {
        const kept = keepDangerous(d);
        patchDownload(d.id, kept);
      } catch {
        toast(`Unable to keep ${d.name}`);
      }
    },
    discard: (d) => discardDangerous(d),
    clear: clearDownloads,
    openFolder: () => void openPath(ensureDir(downloadDir(settings.get().downloadDir))).catch(() => {}),
    showAll: () => openNativePage("downloads"),
  };

  /// Spread on every view the app has: the engine raises a download on the
  /// view it came from while that view lives, and on any other after.
  const downloadHandlers = (node: () => NdNodeRef<"webview"> | null) => ({
    onDownloadRequested: (e: { data: unknown }) => void onDownloadRequested(node(), e.data as DownloadRequest),
    onDownloadUpdated: (e: { data: unknown }) => onDownloadUpdated(e.data as DownloadUpdate),
  });

  // ------------------------------------------------------------- render ---

  /// A second view on chrome://extensions wedges the GTK host (getTree stops
  /// answering), so the hidden registry view stands down while a TAB is
  /// showing that page. The tab is the one the user asked for; the registry
  /// comes back when it closes.
  const registryYields = createMemo(() => allTabs().some((t) => t.url.startsWith("chrome://extensions")));
  const rows = createMemo(() => extensionRows(registry(), extActions()));
  const pinnedActions = createMemo(() => pinnedRows(rows(), prefs.pinnedExtensions));
  /// The actions whose live state is wanted: every toolbar button, for its
  /// badge, and the one a click is being decided for.
  const probeRows = createMemo(() =>
    chromium() ? rows().filter((r) => r.enabled && (prefs.pinnedExtensions.includes(r.id) || r.id === checkingAction())) : [],
  );

  /// The registry view. It starts on about:blank and only becomes the
  /// registry once the page it is showing has said which engine drew it. A
  /// host that fell back to WebKit hands chrome:// to the OS, which puts up
  /// "There is no application set to open the URL chrome://extensions" on
  /// macOS. A new engine or a change of `registryYields` is a new view:
  /// Chromium refuses to walk to the registry address from about:blank.
  function RegistryView() {
    let node!: NdNodeRef<"webview">;
    const at = untrackedRegistryUrl();
    onSettled(() => {
      extRegistry = node;
      if (engine() === "unknown") probeEngine(node);
      else if (chromium() && !registryYields()) watchRegistry(node, 0);
      return () => {
        if (extRegistry === node) extRegistry = null;
      };
    });
    return (
      <webview
        ref={node}
        url={at}
        testID="extensions-registry-view"
        style={{ minWidth: 2, minHeight: 2 }}
        // Without this the engine's answer has nowhere to land and every
        // executeJavaScript on this view hangs, which is how the engine
        // probe came back with nothing.
        onJavaScriptResult={onJavaScriptResult}
        onExtensionsList={onExtensionsList}
        onExtensionActions={onExtensionActions}
        onExtensionsChanged={onExtensionsChanged}
        {...downloadHandlers(() => extRegistry)}
      />
    );
  }
  const untrackedRegistryUrl = (): string => (chromium() && !registryYields() ? "chrome://extensions" : "about:blank");

  /// One hidden view per action whose live state is wanted, created at a page
  /// of that extension (see probes). A new probe address is a new view.
  function ProbeView(p: { row: ExtensionRow }) {
    let node!: NdNodeRef<"webview">;
    const id = p.row.id;
    const at = probeUrl(p.row);
    onSettled(() => {
      probes.set(id, node);
      void readActionFor(id, focusedWindowId(), 10);
      return () => {
        if (probes.get(id) === node) probes.delete(id);
      };
    });
    return (
      <webview
        ref={node}
        url={at}
        testID={`ext-probe-view-${id}`}
        style={{ minWidth: 2, minHeight: 2 }}
        onJavaScriptResult={onJavaScriptResult}
        onExtensionActions={onExtensionActions}
        {...downloadHandlers(() => probes.get(id) ?? null)}
      />
    );
  }

  /// Chromium answers listExtensions and listExtensionActions on a view
  /// showing chrome://extensions and nowhere else, so the toolbar keeps one of
  /// its own. It is a floating layer of the first window's overlay rather
  /// than a row, so it takes no layout, and it is where the app's own installs
  /// go too. 2px, not 1: the engine holds a browser back while its view is
  /// 1px or less on a side, and only gives up waiting after 20 s.
  const hiddenViews = () => (
    <>
      <box
        testID="extensions-registry"
        orientation="horizontal"
        style={{ halign: "start", valign: "end", minWidth: 2, minHeight: 2 }}
      >
        <Show when={`${engine()}:${registryYields()}`} keyed>
          {(_engine) => <RegistryView />}
        </Show>
      </box>
      <For each={probeRows()} keyed={(r) => r.id}>
        {(row) => (
          <box
            testID={`ext-probe-${row().id}`}
            orientation="horizontal"
            style={{ halign: "start", valign: "end", minWidth: 2, minHeight: 2 }}
          >
            <Show when={probeUrl(row())} keyed>
              {(_url) => <ProbeView row={row()} />}
            </Show>
          </box>
        )}
      </For>
    </>
  );

  /// A tab's page. Created with no address and given it once the view
  /// exists, so the user scripts below are in place before its first
  /// document starts. A view that has to be created AT its address
  /// (createAtUrl) is the exception.
  function PageView(p: { tab: SessionTab }) {
    const id = p.tab.id;
    let node!: NdNodeRef<"webview">;
    const [armed, setArmed] = createSignal(false);
    onSettled(() => {
      views.set(id, node);
      fixWebStore(node);
      if (chromium()) hookStore(node);
      // The menu can be pushed now that the view exists.
      syncContextMenus(id);
      armHider(node);
      setArmed(true);
      remounted();
      return () => {
        if (views.get(id) === node) views.delete(id);
        remounted();
      };
    });
    // The engine is known a moment after the first pages mount; their hooks
    // go in then. Both are guarded by widget id, so a view armed above is not
    // armed twice.
    createEffect(chromium, (on) => {
      if (!on || views.get(id) !== node) return;
      hookStore(node);
      armHider(node);
    });
    return (
      <webview
        ref={node}
        url={armed() || createAtUrl(p.tab.url) ? p.tab.url : ""}
        testID={`page-${id}`}
        style={{ hexpand: true, vexpand: true }}
        onNavigate={(e) => onNavigated(id, e.text)}
        onTitleChanged={(e) => onTitled(id, e.text)}
        onLoadingChanged={(e) => onLoading(id, e.checked)}
        onLoadProgress={(e) => patch(id, { progress: e.value })}
        onBackAvailable={(e) => patch(id, { canGoBack: e.checked })}
        onForwardAvailable={(e) => patch(id, { canGoForward: e.checked })}
        onLoadFailed={(e) => patch(id, { error: e.data as { url: string; error: string } })}
        onCloseApproved={() => {
          if (closing.delete(id)) closeTab(id);
        }}
        onNewWindow={(e) => openTabFromPage(id, e)}
        onBrowserCommand={(e) => onBrowserCommand(id, e.text)}
        onJavaScriptResult={onJavaScriptResult}
        // triggerExtensionAction answers on the tab it clicked for.
        onExtensionActions={onExtensionActions}
        onPermissionRequest={(e) => onPermissionRequest(id, e.data)}
        onFaviconChanged={(e) => onFavicon(p.tab.url, e.data as { dataUrl?: string; iconUrl?: string })}
        onSecurityChanged={(e) => patch(id, { security: securityOf(p.tab.url, e.data) })}
        onZoomChanged={(e) => onZoomChanged(id, e.data)}
        onPictureInPicture={(e) => onPictureInPicture(id, e.data)}
        onFullscreenChanged={(e) => {
          const win = windowOfTab(session.get(), id);
          if (win) controllers.get(win.id)?.setPageFullscreen(id, e.checked);
        }}
        onContentBlocked={(e) => {
          const count = (e.data as { count: number }).count;
          patch(id, { blocked: count });
          if (TEST_HOOKS) console.error(`ND_APP BLOCKED ${id} ${count}`);
        }}
        onScriptMessage={(e) => {
          const message = e.data as { name?: string; body?: unknown };
          if (message.name === STORE_CHANNEL) {
            void onStoreRequest(id, message.body);
            return;
          }
          if (message.name === HIDER_CHANNEL && message.body) return onHiderMessage(id, message.body as HiderMessage);
          if (message.name !== READER_CHANNEL) return;
          if (TEST_HOOKS) console.error(`ND_APP READER ${id} off`);
          patch(id, { reading: false });
        }}
        onFindResult={(e) => {
          // Two events per search on GTK: `done` carries the outcome,
          // `done: false` carries the total from the separate counting pass,
          // which AppKit never sends.
          const r = e.data as { matchFound: boolean; matchCount?: number; done: boolean };
          setFind(id, (f) => (r.done ? { ...f, found: r.matchFound } : { ...f, count: r.matchCount ?? null }));
        }}
        onContextMenuItemClicked={(e) => onContextMenuItem(id, e.data as ContextMenuItemClick)}
        {...downloadHandlers(() => view(id))}
      />
    );
  }

  const iconFor = (url: string): string | undefined => {
    iconEpoch();
    return faviconFor(url);
  };

  const ctx: BrowserContext = {
    get session() {
      return state;
    },
    get prefs() {
      return prefs;
    },
    get chromium() {
      return chromium();
    },
    get history() {
      return history();
    },
    downloadActions,
    clearHistory: () => clearVisits().then(refreshHistory),
    get prompts() {
      return prompts();
    },
    get rows() {
      return rows();
    },
    get pinnedActions() {
      return pinnedActions();
    },
    get checkingAction() {
      return checkingAction();
    },
    get privateOpen() {
      return privateOpen();
    },
    get focusedWindowId() {
      return focusedWindowId();
    },
    get dropHint() {
      return dropHint();
    },
    iconFor,
    hiddenViews,
    rt,
    findFor,
    get actionStates() {
      return actionStates();
    },
    get actionDefaults() {
      return actionDefaults();
    },
    moveTargets,
    openTab,
    closeTab: requestCloseTab,
    selectTab,
    setPinned,
    canSleep,
    sleepTab: (id) => void sleepTab(id),
    asleep: (id) => asleep[id] === true && !isLive(id),
    closeOtherTabs,
    resetPinned,
    reopenTab,
    cycleTab,
    navigate,
    retry: (tabId) => patch(tabId, { error: null, attempt: rt(tabId).attempt + 1 }),
    command,
    toggleReader,
    toggleFloat,
    blockingFor,
    toggleBlocking: (tabId) => void toggleBlocking(tabId),
    toggleHiding,
    restoreHidden: (tabId) => void restoreHiddenOn(tabId),
    updateLists: () => void updateLists(),
    zoomFor,
    setZoom,
    zoomStep,
    setLayout,
    openFind: (tabId) => setFind(tabId, (f) => ({ ...f, open: true })),
    closeFind,
    runFind,
    findCommand,
    decidePrompt,
    dismissPromptsFor,
    resetSiteDecisions,
    refreshExtensions,
    pinExtension,
    clickAction,
    installTestExtension,
    uninstallExtension,
    newWindow: () => newWindow(),
    openPrivate: () => void setPrivateOpen(true),
    openSettings: () => void setSettingsOpen(true),
    moveTab,
    moveTabBy,
    moveTabTo,
    onTabDropped,
    setDropHint: (windowId, index) =>
      void setDropHintState((h) => (h && h.windowId === windowId && h.index === index ? h : { windowId, index })),
    onDragStart: () => {},
    onDragEnd: () => void setDropHintState(null),
    onWindowFocused: (windowId, focused) => {
      if (focused) setFocusedId(windowId);
    },
    onWindowClosed,
    onWindowSize: (windowId, width, height) =>
      session.update((s) => ({
        ...s,
        windows: s.windows.map((w) => (w.id === windowId ? { ...w, width, height } : w)),
      })),
    registerSlot: (windowId, node) => {
      if (node) slots.set(windowId, node);
      else slots.delete(windowId);
      remounted();
    },
    registerController: (windowId, controller) => void controllers.set(windowId, controller),
    controllerFor: (windowId) => controllers.get(windowId),
    runTestJs: (tabId) => {
      const node = view(tabId);
      const code = process.env.NB_TEST_JS;
      if (node && code) void executeJavaScript(node, code).catch(() => {});
    },
    onContextMenuItem,
  };

  /// The tabs that have a page, in id order, so no reorder of the tabs ever
  /// reorders their views. Whether a tab is live reads the tab on show, so
  /// this runs on every switch; the same rows again notify nobody.
  const liveTabs = createMemo(
    () =>
      allTabs()
        .filter((t) => t.url !== "" && isLive(t.id))
        .sort((a, b) => tabNumber(a.id) - tabNumber(b.id)),
    { equals: (a, b) => a.length === b.length && a.every((t, i) => t === b[i]) },
  );

  return (
    <>
      {/* Every tab's page, in the framework's off-window pool. The portal
          keeps each view's owner here whichever window lists the tab, so
          moving a tab never disposes its page; the placement effect shows it
          in its window's slot. They come before the windows so that a closing
          window's pages are taken down before the window is. Keyed by tab id:
          a tab that moves to another window's list is the same page. */}
      <Portal>
        <For each={liveTabs()} keyed={(t) => t.id}>
          {(t) => {
            const id = t().id;
            // A memo, so a switch re-runs the two pages it changes, not all.
            const shown = createMemo(() => windows().some((w) => w.activeId === id) && rt(id).error === null);
            return (
              <Activity mode={shown() ? "visible" : "hidden"}>
                {/* `attempt` is the view's identity: Try Again and an address
                    that needs a fresh view both bump it. */}
                <Show when={rt(id).attempt + 1} keyed>
                  {(_attempt) => <PageView tab={t()} />}
                </Show>
              </Activity>
            );
          }}
        </For>
      </Portal>

      <For each={windows()} keyed={(w) => w.id}>
        {(w, i) => <BrowserWindow win={w()} first={i() === 0} ctx={ctx} />}
      </For>

      <Show when={settingsOpen()}>
        <SettingsWindow onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={privateOpen()}>
        <PrivateWindow
          onClose={() => setPrivateOpen(false)}
          onSettings={() => setSettingsOpen(true)}
          onDownloads={() => controllers.get(focusedWindowId())?.openDownloads()}
          downloadHandlers={downloadHandlers}
          moveTargets={moveTargets("private").filter((t) => t.id !== "private")}
          onMoveOut={(url, windowId, index) => openTab(windowId, url, false, index)}
          onAdopt={closeTab}
          bridge={privateBridge}
        />
      </Show>
    </>
  );
}

/// Settings. A handful of preferences, native rows, written straight through
/// the store: there is no Apply button because there is nothing to apply.
/// Grouped the way the window is used: how it looks, what it searches, what it
/// opens with, and where files land.
function SettingsWindow(props: { onClose: () => void }) {
  const prefs = trackStore(settings);
  const engineIndex = () => Math.max(0, SEARCH_ENGINES.findIndex((e) => e.id === prefs.searchEngine));
  const layoutIndex = () => Math.max(0, LAYOUTS.findIndex((l) => l.id === prefs.layout));
  const pinStyleIndex = () => Math.max(0, PIN_STYLES.findIndex((p) => p.id === prefs.pinStyle));

  return (
    <window title="Settings" testID="settings-window" defaultWidth={640} defaultHeight={620} onClosed={() => props.onClose()}>
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
                    // The row hands its suffix only its minimum once the
                    // subtitle wants the width, and a toggle group's minimum
                    // is two ellipsized labels: "Comp…" in the capture.
                    style={{ minWidth: LAYOUT_SEGMENT_WIDTH }}
                    options={LAYOUTS.map((l) => l.name)}
                    selectedIndex={layoutIndex()}
                    onSelectionChanged={(e) => {
                      const layout = LAYOUTS[e.index]?.id ?? "sidebar";
                      settings.update((s) => ({ ...s, layout }));
                    }}
                  />
                </row>
                <row testID="settings-pins-row" title="Pinned Tabs" subtitle="Icons show each site's favicon; letters are quieter">
                  <segmentedcontrol
                    slot="suffix"
                    testID="settings-pins"
                    options={PIN_STYLES.map((p) => p.name)}
                    selectedIndex={pinStyleIndex()}
                    onSelectionChanged={(e) => {
                      const pinStyle = PIN_STYLES[e.index]?.id ?? "icons";
                      settings.update((s) => ({ ...s, pinStyle }));
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
                    selectedIndex={engineIndex()}
                    onSelectionChanged={(e) => {
                      const engine = SEARCH_ENGINES[e.index]?.id ?? "duckduckgo";
                      settings.update((s) => ({ ...s, searchEngine: engine }));
                    }}
                  />
                </row>
              </settingsgroup>

              <settingsgroup testID="settings-startup" title="Startup">
                <row testID="settings-homepage-row" title="Homepage" subtitle="New windows open here, or on the new tab page">
                  <textinput
                    slot="suffix"
                    testID="settings-homepage"
                    placeholder="example.com"
                    text={prefs.homepage}
                    onChanged={(e) => settings.update((s) => ({ ...s, homepage: e.text }))}
                  />
                </row>
                <switchrow
                  testID="settings-fresh-window"
                  title="Start with a Fresh Window"
                  subtitle="Pinned tabs stay; the rest of last time's tabs don't come back"
                  checked={prefs.freshWindow}
                  onToggled={(e) => settings.update((s) => ({ ...s, freshWindow: e.checked }))}
                />
              </settingsgroup>

              <settingsgroup testID="settings-downloads" title="Downloads">
                <row testID="settings-download-dir-row" title="Save Files To" subtitle={downloadDir(prefs.downloadDir).replace(homedir(), "~")}>
                  <button
                    slot="suffix"
                    testID="settings-download-dir"
                    label="Change…"
                    style={{ halign: "end", valign: "center" }}
                    onClick={() =>
                      void dialog
                        .openFile({ directories: true, defaultPath: downloadDir(settings.get().downloadDir) })
                        .then((paths) => {
                          const dir = paths[0];
                          if (dir) settings.update((x) => ({ ...x, downloadDir: dir }));
                        })
                        .catch(() => {})
                    }
                  />
                </row>
                <switchrow
                  testID="settings-ask-where"
                  title="Ask Where to Save Each File"
                  subtitle="Choose a folder and name every time you download"
                  checked={prefs.askWhereToSave}
                  onToggled={(e) => settings.update((x) => ({ ...x, askWhereToSave: e.checked }))}
                />
              </settingsgroup>
            </box>
          </clamp>
        </scrollview>
      </toolbarview>
    </window>
  );
}
