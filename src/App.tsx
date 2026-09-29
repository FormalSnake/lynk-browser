import {
  createPortal,
  executeJavaScript,
  installExtension,
  listExtensionActions,
  listExtensions,
  moveNode,
  onExtensionActions,
  onExtensionsChanged,
  onExtensionsList,
  onJavaScriptResult,
  openPath,
  readExtensionAction,
  sendCommand,
  setContextMenuItems,
  useLayoutEffect,
  watchExtensions,
  useRef,
  useState,
  useStoreValue,
  Spacing,
} from "@nativedesktop/react";
import type {
  ContextMenuItem,
  ContextMenuItemClick,
  ExtensionAction,
  ExtensionActionState,
  InstalledExtension,
  NdNodeRef,
} from "@nativedesktop/react";
// <Activity mode="hidden"> is React's own keep-mounted-but-hidden primitive; it
// drives the renderer's hideInstance/unhideInstance hooks, which the host turns
// into gtk_widget_set_visible. That is what lets every tab keep a LIVE webview:
// switching tabs hides a widget instead of unmounting a subtree, so the page,
// its scroll position and its JS state all survive. @nativedesktop/react does
// not re-export it, hence the direct react import.
import { Activity, Fragment } from "react";

import {
  BrowserWindow,
  TEST_HOOKS,
  type BrowserContext,
  type MoveTarget,
  type WindowController,
} from "./BrowserWindow.tsx";
import type { DownloadItem, EngineDownload } from "./lib/downloads.ts";
import { downloadDir, downloadTarget, runDownload } from "./lib/downloads.ts";
import { extensionRows, pinnedRows, probeUrl, togglePinned, type ExtensionRow } from "./lib/extensions.ts";
import { fetchFavicon, rememberFavicon } from "./lib/favicons.ts";
import { recentVisits, recordTitle, recordVisit, type Visit } from "./lib/history.ts";
import {
  forgetOrigin,
  rememberDecision,
  rememberedDecision,
  splitTypes,
  type PermissionDecision,
  type PermissionPrompt,
} from "./lib/permissions.ts";
import {
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  blankTab,
  moveTabIn,
  session,
  windowOfTab,
  type SessionState,
  type SessionTab,
} from "./lib/session.ts";
import { LAYOUTS, PIN_STYLES, SEARCH_ENGINES, engineOf, settings, type Layout } from "./lib/settings.ts";
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
import { PrivateWindow, type PrivateBridge } from "./PrivateWindow.tsx";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/// A window with no tabs left is closed, not kept around empty.
function withoutEmptyWindows(s: SessionState): SessionState {
  return s.windows.every((w) => w.tabs.length > 0) ? s : { ...s, windows: s.windows.filter((w) => w.tabs.length > 0) };
}

function without<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const { [id]: _gone, ...rest } = map;
  return rest;
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
export function App({ initialHistory }: AppProps): React.ReactNode {
  const state = useStoreValue(session);
  const prefs = useStoreValue(settings);
  const windows = state.windows.filter((w) => w.tabs.length > 0);
  const allTabs = windows.flatMap((w) => w.tabs);

  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  // A tab's webview is created with no URL and navigates one render later: a
  // background tab mounted straight into a hidden Activity never attaches its
  // ref, so it "arms" visibly for one frame first (see the arming comment
  // below).
  const [armedTabs, setArmedTabs] = useState<Record<string, boolean>>({});
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [history, setHistory] = useState<Visit[]>(initialHistory);
  const [finds, setFinds] = useState<Record<string, FindState>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  /// Permission requests waiting for an answer, oldest first. A request is
  /// per tab and per id: concurrent ones queue, and a background tab's waits
  /// until that tab is active.
  const [prompts, setPrompts] = useState<PermissionPrompt[]>([]);
  /// The queue the handlers act on; `prompts` is its rendered copy.
  const pending = useRef<PermissionPrompt[]>([]);
  /// The two halves of an extension row, each from its own framework call.
  const [registry, setRegistry] = useState<InstalledExtension[]>([]);
  const [extActions, setExtActions] = useState<ExtensionAction[]>([]);
  /// The action a click is being decided for. Nothing opens until its live
  /// state is in, because the manifest's popup may be one the extension has
  /// switched off.
  const [checkingAction, setCheckingAction] = useState("");
  const checkingRef = useRef("");
  /// Each action's live state, as last read for a tab some window is showing.
  const [actionStates, setActionStates] = useState<Record<string, ExtensionActionState>>({});
  /// Each action's state as read on its probe's own tab: its defaults.
  const [actionDefaults, setActionDefaults] = useState<Record<string, ExtensionActionState>>({});
  /// Hidden views on a page of each extension whose state the toolbar needs.
  /// Chromium answers an action's live state to its own extension's pages and
  /// to nothing else, so these are the only way to read it.
  const probes = useRef(new Map<string, NdNodeRef<"webview">>());
  const probeArmed = useRef(new Map<string, number>());
  const [privateOpen, setPrivateOpen] = useState(false);
  /// Bumped when a favicon lands. The cache lives outside React, so this is
  /// what tells the windows to re-read it.
  const [iconEpoch, setIconEpoch] = useState(0);
  /// The window the menu bar and its accelerators act on.
  const [focusedId, setFocusedId] = useState(windows[0]?.id ?? "");
  const focusedWindowId = windows.some((w) => w.id === focusedId) ? focusedId : (windows[0]?.id ?? "");
  const [dropHint, setDropHintState] = useState<{ windowId: string; index: number } | null>(null);

  const closed = useRef<{ url: string; title: string }[]>([]);
  /// Tabs that have a browser. A tab gets one the first time it is shown and
  /// keeps it until it is put to sleep or closed: a restored tab, one opened
  /// behind the page and a sleeping one all wait to be looked at.
  const [live, setLive] = useState<Record<string, true>>({});
  /// Tabs put to sleep, which their rows draw dimmed until they wake.
  const [asleep, setAsleep] = useState<Record<string, true>>({});
  /// Where a sleeping page was scrolled to, put back once it has loaded again.
  const scrollMemory = useRef(new Map<string, [number, number]>());
  /// Last URL the engine actually committed per tab, so a download can put the
  /// tab back where it was.
  const committed = useRef(new Map<string, string>());
  const views = useRef(new Map<string, NdNodeRef<"webview"> | null>());
  /// Each window's page slot, and the slot each tab's view was last moved
  /// into, as "view id>slot id": a remounted view or a rebuilt window both
  /// change it, and either means the view has to be moved again.
  const slots = useRef(new Map<string, NdNodeRef<"box">>());
  const placed = useRef(new Map<string, string>());
  const controllers = useRef(new Map<string, WindowController>());
  const privateBridge = useRef<PrivateBridge | null>(null);
  /// Last context-menu tree sent to each tab's view, so an unchanged one is
  /// never re-sent.
  const sentMenus = useRef(new Map<string, string>());
  /// The hidden `chrome://extensions` view. Chromium exposes its extension
  /// registry to that page and nowhere else, so every list and every install
  /// goes through this one rather than through a tab the user can navigate.
  const extRegistry = useRef<NdNodeRef<"webview">>(null);
  const registryArmed = useRef(0);
  /// Set once the engine probe has an answer, so no retry outlives it.
  const engineProbed = useRef(false);
  /// Which engine actually drew a page, read off the first one this app put
  /// up. Not the config and not the platform: `ND_WEBVIEW_ENGINE=chromium`
  /// against a host that cannot start CEF falls back to the system engine and
  /// says so only on stderr, and everything chrome:// is a dead end there.
  const [engine, setEngine] = useState<"unknown" | "chromium" | "system">("unknown");
  /// Download ids only have to be unique within a run, and a short one keeps
  /// the panel's row testIDs readable.
  const downloadSeq = useRef(0);
  /// Engine download id to the app's own, while Chromium runs the transfer.
  const engineDownloads = useRef(new Map<string, string>());

  const rt = (id: string): Runtime => runtime[id] ?? IDLE;
  const patch = (id: string, part: Partial<Runtime>): void =>
    setRuntime((r) => ({ ...r, [id]: { ...(r[id] ?? IDLE), ...part } }));
  const view = (id: string): NdNodeRef<"webview"> | null => views.current.get(id) ?? null;
  const tabOf = (id: string): SessionTab | null =>
    session
      .get()
      .windows.flatMap((w) => w.tabs)
      .find((t) => t.id === id) ?? null;
  /// Whether a tab is the one its window is showing.
  const isShown = (id: string): boolean => session.get().windows.some((w) => w.activeId === id);
  const toast = (title: string): void => controllers.current.get(focusedWindowId)?.toast(title);
  /// Extensions are Chromium's. On the system engine there is no registry to
  /// list, no popup to open and no chrome:// page to reach, so the toolbar
  /// does not offer any of it rather than offering a dead button.
  const chromium = engine === "chromium";

  /// Whether a tab has, or is about to get, a browser: every tab a window is
  /// showing does.
  const isLive = (id: string): boolean => live[id] === true || windows.some((w) => w.activeId === id);

  // A tab on show keeps its browser once it is shown elsewhere. Every path
  // that changes the tab on show (a click, a close landing on a neighbour, a
  // move, a new window) ends here, so none of them has to remember to.
  useLayoutEffect(() => {
    const woken = windows.map((w) => w.activeId).filter((id) => id !== "" && live[id] !== true);
    if (woken.length === 0) return;
    setLive((l) => ({ ...l, ...Object.fromEntries(woken.map((id) => [id, true as const])) }));
    setAsleep((a) => {
      if (!woken.some((id) => id in a)) return a;
      const rest = { ...a };
      for (const id of woken) delete rest[id];
      return rest;
    });
    if (TEST_HOOKS) for (const id of woken) console.error(`ND_APP WAKE tab=${id}`);
  });

  // A tab navigating or a new search engine both change what a right-click
  // should show, and both land as a render. The push is skipped when the tree
  // is unchanged.
  syncContextMenus();

  // Every live view is shown in the slot of the window that lists its tab.
  // After every commit, because a tab moving windows, a view being created or
  // remounted and a window being rebuilt all land as one: the view and the
  // slot it belongs in are both known only once the commit has attached them.
  useLayoutEffect(() => {
    for (const w of windows) {
      const slot = slots.current.get(w.id);
      if (!slot) continue;
      for (const t of w.tabs) {
        const node = views.current.get(t.id);
        if (!node) continue;
        const where = `${node.id}>${slot.id}`;
        if (placed.current.get(t.id) === where) continue;
        moveNode(node, slot);
        placed.current.set(t.id, where);
        if (TEST_HOOKS) console.error(`ND_APP PLACE tab=${t.id} window=${w.id}`);
      }
    }
  });

  function refreshHistory(): void {
    void recentVisits().then(setHistory);
  }

  // ---------------------------------------------------------------- tabs ---

  /// Returns the new tab's id: chrome.tabs.create has to answer with a tab.
  function openTab(windowId: string, url: string, background = false, index?: number): string {
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

  /// A tab a PAGE asked for: `window.open`, target=_blank, and now an
  /// extension's `chrome.tabs.create`. An empty or about:blank URL is not a
  /// tab worth opening, it is a dead one; 0.4.10 carries the real URL, so a
  /// blank one means the route had nothing to say. It opens behind the page
  /// that asked, in that page's window, and loads when it is first shown.
  function openTabFromPage(fromTab: string, url: string): void {
    const target = url.trim();
    if (!target || target === "about:blank") return;
    openTab(windowOfTab(session.get(), fromTab)?.id ?? focusedWindowId, target, true);
  }

  /// A Chrome shortcut the page had the keyboard for (cmd+shift+N, cmd+Y, …).
  /// The engine refuses Chromium's own window or panel for it and names the
  /// command instead; this runs the app's equivalent, and drops the ones the
  /// app has none for.
  function onBrowserCommand(fromTab: string, name: string): void {
    const windowId = windowOfTab(session.get(), fromTab)?.id ?? focusedWindowId;
    const controller = controllers.current.get(windowId);
    switch (name) {
      case "newWindow":
        return newWindow();
      case "newPrivateWindow":
        return setPrivateOpen(true);
      case "newTab":
        openTab(windowId, "");
        return;
      case "reopenClosedTab":
        return reopenTab(windowId);
      case "closeTab":
        return closeTab(fromTab);
      case "nextTab":
        return cycleTab(windowId, 1);
      case "previousTab":
        return cycleTab(windowId, -1);
      case "downloads":
        return controller?.openDownloads();
      case "history":
        return controller?.openPalette("");
      case "settings":
        return setSettingsOpen(true);
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
    denyPromptsFor(id);
    views.current.delete(id);
    placed.current.delete(id);
    sentMenus.current.delete(id);
    scrollMemory.current.delete(id);
    setLive((l) => without(l, id));
    setAsleep((a) => without(a, id));
    setFinds((f) => {
      if (!(id in f)) return f;
      const { [id]: _gone, ...rest } = f;
      return rest;
    });
  }

  /// The last tab takes its window with it. When that is the last window the
  /// app has, the host quits once the window is gone, as it does when that
  /// window is closed.
  function closeTab(id: string): void {
    const gone = tabOf(id);
    if (!gone) return;
    closed.current.push({ url: gone.url, title: gone.title });
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

  /// A window the user closed. Its tabs go with it, the way closing a window
  /// in any browser does. The last one is left in the session as it stands:
  /// the app is quitting, and that window is what a relaunch restores.
  function onWindowClosed(windowId: string): void {
    const s = session.get();
    const w = s.windows.find((x) => x.id === windowId);
    if (!w || windows.length <= 1) return;
    for (const t of w.tabs) {
      closed.current.push({ url: t.url, title: t.title });
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
        return { ...w, tabs: [...rest.slice(0, boundary), { ...tab, pinned }, ...rest.slice(boundary)] };
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
      if ((x || y) && Number.isFinite(x) && Number.isFinite(y)) scrollMemory.current.set(id, [x!, y!]);
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
    denyPromptsFor(id);
    views.current.delete(id);
    placed.current.delete(id);
    sentMenus.current.delete(id);
    committed.current.delete(id);
    setFinds((f) => without(f, id));
    setArmedTabs((a) => without(a, id));
    setLive((l) => without(l, id));
    setAsleep((a) => ({ ...a, [id]: true }));
    patch(id, { loading: false, progress: 0, canGoBack: false, canGoForward: false, error: null });
    if (TEST_HOOKS) console.error(`ND_APP SLEEP tab=${id} scroll=${scrollMemory.current.get(id)?.join(",") ?? "top"}`);
  }

  /// A woken page is put back where it was scrolled to once it has loaded.
  function onLoading(id: string, loading: boolean): void {
    patch(id, { loading });
    const at = scrollMemory.current.get(id);
    const node = view(id);
    // Until the page has committed, the view is still on the blank page it
    // was created with.
    if (loading || !at || !node || !committed.current.has(id)) return;
    scrollMemory.current.delete(id);
    void executeJavaScript(node, `window.scrollTo(${at[0]}, ${at[1]})`).catch(() => {});
    if (TEST_HOOKS) console.error(`ND_APP SCROLLBACK tab=${id} to=${at[0]},${at[1]}`);
  }

  function reopenTab(windowId: string): void {
    const last = closed.current.pop();
    if (last) openTab(windowId, last.url);
  }

  function selectTab(id: string): void {
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) => (w.tabs.some((t) => t.id === id) && w.activeId !== id ? { ...w, activeId: id } : w)),
    }));
    applyZoom(id, tabOf(id)?.url ?? "");
    refreshActionStates();
  }

  function cycleTab(windowId: string, step: number): void {
    const w = windows.find((x) => x.id === windowId);
    if (!w || w.tabs.length < 2) return;
    const at = w.tabs.findIndex((t) => t.id === w.activeId);
    selectTab(w.tabs[(at + step + w.tabs.length) % w.tabs.length]!.id);
  }

  function setTabUrl(id: string, url: string): void {
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) =>
        w.tabs.some((t) => t.id === id) ? { ...w, tabs: w.tabs.map((t) => (t.id === id ? { ...t, url } : t)) } : w,
      ),
    }));
  }

  function navigate(id: string, raw: string): void {
    const target = toUrl(raw);
    if (!target || !reachable(target)) return;
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
    // instead of sending the existing one to it. `attempt` is the webview's
    // key, which is what remounts it.
    if (createAtUrl(target)) patch(id, { attempt: rt(id).attempt + 1 });
  }

  /// chrome:// and chrome-extension:// exist only under Chromium. The system
  /// engine hands an address it does not know to the OS, which is where the
  /// macOS "no application set to open the URL" dialog came from.
  function reachable(url: string): boolean {
    if (!createAtUrl(url)) return true;
    if (chromium) return true;
    toast("This address needs the Chromium engine");
    return false;
  }

  function onNavigated(id: string, url: string): void {
    // A view the engine refused to move, or one still holding the blank page
    // it was created with, reports about:blank. That is the engine saying
    // nothing happened, not the user going somewhere, and writing it into the
    // tab would put about:blank in the restored session.
    if (url === "about:blank" && (tabOf(id)?.url ?? "") !== "") return;
    // A page that navigated away is not waiting for its own answer any more,
    // and the id would otherwise stay in the queue for ever.
    denyPromptsFor(id);
    committed.current.set(id, url);
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
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) =>
        w.tabs.some((t) => t.id === id) ? { ...w, tabs: w.tabs.map((t) => (t.id === id ? { ...t, title } : t)) } : w,
      ),
    }));
    void recordTitle(url, title).then(refreshHistory);
  }

  function zoomFor(url: string): number {
    return session.get().zoomByHost[hostOf(url)] ?? 1;
  }

  function applyZoom(id: string, url: string): void {
    const node = view(id);
    if (node) sendCommand(node, "setZoom", zoomFor(url));
  }

  function setZoom(tabId: string, next: number): void {
    const host = hostOf(tabOf(tabId)?.url ?? "");
    if (!host) return;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
    session.update((s) => ({ ...s, zoomByHost: { ...s.zoomByHost, [host]: clamped } }));
    const node = view(tabId);
    if (node) sendCommand(node, "setZoom", clamped);
  }

  function command(tabId: string, name: "goBack" | "goForward" | "reload" | "stop"): void {
    const node = view(tabId);
    if (node) sendCommand(node, name);
  }

  /// The sidebar pane is the only thing the two layouts disagree about, and it
  /// is a SIBLING of the content pane rather than its ancestor: dropping it
  /// leaves every window's page slot at the same place in the tree, so the
  /// live pages survive the switch instead of remounting.
  function setLayout(next: Layout): void {
    settings.update((s) => (s.layout === next ? s : { ...s, layout: next }));
  }

  // ------------------------------------------------------------- windows ---

  function newWindow(): void {
    let created = "";
    session.update((s) => {
      created = `w${s.nextWindowId}`;
      const tab = blankTab(`t${s.nextTabId}`);
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
    const node = views.current.get(tabId);
    const slot = slots.current.get(toWindowId);
    if (node && slot && from.id !== toWindowId) {
      moveNode(node, slot);
      placed.current.set(tabId, `${node.id}>${slot.id}`);
    }
    session.set(withoutEmptyWindows(moveTabIn(s, tabId, toWindowId, index)));
    setFocusedId(toWindowId);
    if (TEST_HOOKS) console.error(`ND_APP MOVE tab=${tabId} from=${from.id} to=${toWindowId} index=${index}`);
    // A request the page is still waiting on is answered from the window it
    // is in now.
    if (pending.current.some((q) => q.tabId === tabId)) controllers.current.get(toWindowId)?.openSiteInfo();
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
    const targets: MoveTarget[] = windows
      .filter((w) => w.id !== fromWindowId)
      .map((w) => ({
        id: w.id,
        label: windowLabel(w.tabs.find((t) => t.id === w.activeId) ?? w.tabs[0]!, w.tabs.length),
      }));
    if (privateOpen) targets.push({ id: "private", label: "Private Browsing" });
    return targets;
  }

  // ---------------------------------------------------------------- find ---

  const findFor = (tabId: string): FindState => finds[tabId] ?? NO_FIND;
  const setFind = (tabId: string, next: (f: FindState) => FindState): void =>
    setFinds((all) => ({ ...all, [tabId]: next(all[tabId] ?? NO_FIND) }));

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
    setQueue(pending.current.filter((q) => q.id !== prompt.id));
  }

  /// Everything that takes a prompt away without the user choosing: escape, a
  /// click outside the popover, the tab navigating, the tab closing. Block is
  /// the safe answer and nothing is remembered, which is what Chrome does with
  /// a dismissed bubble. An id left unanswered would leave the page waiting
  /// for ever.
  function denyPromptsFor(tabId: string): void {
    const doomed = pending.current.filter((q) => q.tabId === tabId);
    if (doomed.length === 0) return;
    for (const prompt of doomed) respond(tabId, prompt.id, false);
    setQueue(pending.current.filter((q) => q.tabId !== tabId));
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
    // The bubble opens itself for a tab being looked at, the way Chrome's
    // does; a background tab's request waits for the tab.
    const w = windowOfTab(session.get(), tabId);
    if (w && w.activeId === tabId) controllers.current.get(w.id)?.openSiteInfo();
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
  }

  function resetSiteDecisions(origin: string): void {
    settings.update((s) => ({ ...s, sitePermissions: forgetOrigin(s.sitePermissions, origin) }));
  }

  // ------------------------------------------------------ extensions ---

  /// Chromium's user agent is the one runtime fact that separates the engines
  /// without asking for a page either of them would refuse. WebKitGTK and
  /// WKWebView both report AppleWebKit and Safari and neither reports Chrome.
  function probeEngine(node: NdNodeRef<"webview">, attempt = 0): void {
    // One chain, and none once the answer is in. A retry that outlived the
    // answer would keep evaluating against a view the `key` has already
    // rebuilt, and an executeJavaScript aimed at a widget that is gone stops
    // the host answering anything at all.
    if (engineProbed.current || extRegistry.current !== node) return;
    if (attempt > 0 && TEST_HOOKS) console.error(`ND_APP ENGINE retry=${attempt}`);
    void executeJavaScript(node, "navigator.userAgent")
      .then((ua) => {
        if (engineProbed.current) return;
        const agent = String(ua ?? "");
        // A view that has not committed a document yet answers with nothing,
        // which is not an answer about the engine.
        if (!agent) {
          if (attempt < 20) setTimeout(() => probeEngine(node, attempt + 1), 400);
          return;
        }
        const found = /Chrome\//.test(agent) ? "chromium" : "system";
        engineProbed.current = true;
        if (TEST_HOOKS) console.error(`ND_APP ENGINE ${found}`);
        setEngine(found);
      })
      .catch((e: unknown) => {
        if (engineProbed.current) return;
        if (TEST_HOOKS) console.error(`ND_APP ENGINE failed=${String(e)}`);
        if (attempt < 20) setTimeout(() => probeEngine(node, attempt + 1), 400);
      });
  }

  /// Both halves of the list, from the one view Chromium answers on. The
  /// registry reports its own changes now (`watchExtensions`), so this runs on
  /// what that reports, plus once when the panel is opened: a list nobody is
  /// watching is worse than one read a moment too often.
  function refreshExtensions(): void {
    const node = extRegistry.current;
    if (!node) return;
    void listExtensions(node).then(setRegistry).catch(() => {});
    void listExtensionActions(node).then(setExtActions).catch(() => {});
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
      const node = probes.current.get(id);
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
  function refreshActionStates(): void {
    for (const id of probes.current.keys()) void readActionFor(id, focusedWindowId, 4);
  }

  async function probeFor(id: string): Promise<NdNodeRef<"webview"> | null> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const node = probes.current.get(id);
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
    if (checkingRef.current === row.id) return;
    checkingRef.current = row.id;
    setCheckingAction(row.id);
    void decideAction(windowId, row);
  }

  async function decideAction(windowId: string, row: ExtensionRow): Promise<void> {
    await probeFor(row.id);
    const read = await readActionFor(row.id, windowId, 6);
    if (checkingRef.current !== row.id) return;
    checkingRef.current = "";
    setCheckingAction("");
    // No answer at all is an engine that cannot say, not an extension that
    // switched its popup off: the manifest is all there is to go on. An
    // answer for another tab still carries the extension's own default,
    // which is what a tab with no override of its own gets.
    const live = read ? read.state.popupUrl : row.popupUrl;
    if (TEST_HOOKS) console.error(`ND_APP ACTION id=${row.id} matched=${read?.matched ?? false} popup=${JSON.stringify(live)}`);
    if (live === "") {
      if (row.optionsUrl) openTab(windowId, row.optionsUrl);
      return;
    }
    controllers.current.get(windowId)?.showPopup(row.id, live);
  }

  /// Test-only: `launchApp` passes no argv, so a drive cannot hand the host a
  /// `--load-extension`, and the Web Store needs the network. The app's own
  /// install API is the one route left.
  function installTestExtension(dir: string | undefined): void {
    const node = extRegistry.current;
    if (!node || !dir) return;
    void installExtension(node, dir)
      .then(() => refreshExtensions())
      .catch(() => {});
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
  /// changes, which is what makes calling it per render safe. Keyed by tab and
  /// by view, not by window: a view that moved windows keeps its menu.
  function syncContextMenus(only?: string): void {
    for (const tab of allTabs) {
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
    const windowId = windowOfTab(session.get(), tabId)?.id ?? focusedWindowId;
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

  function startDownload(url: string, suggested?: string, engine?: EngineDownload): void {
    // A download is not a navigation: whichever tab aimed at this URL goes back
    // to the page it was showing, so the restored session never points at it.
    session.update((s) => ({
      ...s,
      windows: s.windows.map((w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.url === url ? { ...t, url: committed.current.get(t.id) ?? "" } : t)),
      })),
    }));

    const id = `d${downloadSeq.current++}`;
    const guess = suggested || fileNameFromUrl(url);
    if (engine) {
      const path = downloadTarget(guess);
      const name = path.slice(path.lastIndexOf("/") + 1);
      engineDownloads.current.set(engine.id, id);
      setDownloads((d) => [{ id, name, url, path, state: "running" }, ...d]);
      controllers.current.get(focusedWindowId)?.openDownloads();
      engine.respond(path);
      return;
    }
    setDownloads((d) => [{ id, name: guess, url, path: "", state: "running" }, ...d]);
    controllers.current.get(focusedWindowId)?.openDownloads();
    runDownload(url, suggested).then(
      (done) => {
        setDownloads((d) => d.map((x) => (x.id === id ? { ...x, ...done, state: "done" as const } : x)));
        toast(`Saved ${done.name}`);
      },
      () => {
        setDownloads((d) => d.map((x) => (x.id === id ? { ...x, state: "failed" as const } : x)));
        toast(`Unable to download ${guess}`);
      },
    );
  }

  function onDownloadUpdated(data: unknown): void {
    const u = data as { id: string; state: "running" | "done" | "failed" | "cancelled"; received: number; total: number; path: string };
    const id = engineDownloads.current.get(u.id);
    if (!id) return;
    if (u.state !== "running") engineDownloads.current.delete(u.id);
    const state = u.state === "cancelled" ? "failed" : u.state;
    let name = "";
    setDownloads((d) =>
      d.map((x) => {
        if (x.id !== id) return x;
        name = x.name;
        return { ...x, state, received: u.received, total: u.total, path: u.path || x.path };
      }),
    );
    if (state === "done") toast(`Saved ${name || u.path.slice(u.path.lastIndexOf("/") + 1)}`);
    if (state === "failed") toast(`Unable to download ${name || "the file"}`);
  }

  // ------------------------------------------------------------- render ---

  /// A second view on chrome://extensions wedges the GTK host (getTree stops
  /// answering), so the hidden registry view stands down while a TAB is
  /// showing that page. The tab is the one the user asked for; the registry
  /// comes back when it closes.
  const registryYields = allTabs.some((t) => t.url.startsWith("chrome://extensions"));
  const rows = extensionRows(registry, extActions);
  const pinnedActions = pinnedRows(rows, prefs.pinnedExtensions);
  /// The actions whose live state is wanted: every toolbar button, for its
  /// badge, and the one a click is being decided for.
  const probeRows = rows.filter(
    (r) => r.enabled && probeUrl(r) !== "" && (prefs.pinnedExtensions.includes(r.id) || r.id === checkingAction),
  );

  const hiddenViews = (
    <>
      {/* Chromium answers listExtensions and listExtensionActions on a view
          showing chrome://extensions and nowhere else, so the toolbar keeps
          one of its own. It is a floating layer of the first window's
          overlay rather than a row, so it takes no layout, and it is where
          the app's own installs go too. 2px, not 1: the engine holds a
          browser back while its view is 1px or less on a side, and only
          gives up waiting after 20 s.

          It starts on about:blank and only becomes the registry once the
          page it is showing has said which engine drew it. A host that fell
          back to WebKit hands chrome:// to the OS, which puts up "There is no
          application set to open the URL chrome://extensions" on macOS.
          `key` is what rebuilds the view at the registry address: Chromium
          refuses to walk there from about:blank. */}
      <box
        testID="extensions-registry"
        orientation="horizontal"
        style={{ halign: "start", valign: "end", minWidth: 2, minHeight: 2 }}
      >
        <webview
          key={`${engine}:${registryYields}`}
          ref={(node) => {
            // Guarded by widget id and never reset: an inline ref callback
            // runs on every render, and a refresh that re-renders would arm
            // itself again for ever.
            const registryView = node as NdNodeRef<"webview"> | null;
            extRegistry.current = registryView;
            if (!registryView || registryArmed.current === registryView.id) return;
            registryArmed.current = registryView.id;
            if (engine === "unknown") {
              probeEngine(registryView);
              return;
            }
            if (!chromium || registryYields) return;
            refreshExtensions();
            // An empty answer means the watcher attached to nothing, and a
            // Web Store install would then never show up until the panel was
            // opened by hand.
            void watchExtensions(registryView, () => {
              refreshExtensions();
              refreshActionStates();
            })
              .then((watched) => {
                if (watched.length === 0) console.error("ND_APP EXTWATCH attached to nothing");
                else if (TEST_HOOKS) console.error(`ND_APP EXTWATCH watching ${watched.length}`);
              })
              .catch((e: unknown) => console.error(`ND_APP EXTWATCH failed ${String(e)}`));
          }}
          url={chromium && !registryYields ? "chrome://extensions" : "about:blank"}
          testID="extensions-registry-view"
          style={{ minWidth: 2, minHeight: 2 }}
          // Without this the engine's answer has nowhere to land and every
          // executeJavaScript on this view hangs, which is how the engine
          // probe came back with nothing.
          onJavaScriptResult={onJavaScriptResult}
          onExtensionsList={onExtensionsList}
          onExtensionActions={onExtensionActions}
          onExtensionsChanged={onExtensionsChanged}
        />
      </box>

      {/* One hidden view per action whose live state is wanted, created at a
          page of that extension (see probes). 2px for the same reason as the
          registry view. */}
      {chromium &&
        probeRows.map((row) => (
          <box
            key={row.id}
            testID={`ext-probe-${row.id}`}
            orientation="horizontal"
            style={{ halign: "start", valign: "end", minWidth: 2, minHeight: 2 }}
          >
            <webview
              key={probeUrl(row)}
              ref={(node) => {
                const probe = node as NdNodeRef<"webview"> | null;
                // The null call comes on every render too, so the armed id
                // survives it; a rebuilt probe arrives with a new id.
                if (!probe) {
                  probes.current.delete(row.id);
                  return;
                }
                probes.current.set(row.id, probe);
                if (probeArmed.current.get(row.id) === probe.id) return;
                probeArmed.current.set(row.id, probe.id);
                void readActionFor(row.id, focusedWindowId, 10);
              }}
              url={probeUrl(row)}
              testID={`ext-probe-view-${row.id}`}
              style={{ minWidth: 2, minHeight: 2 }}
              onJavaScriptResult={onJavaScriptResult}
              onExtensionActions={onExtensionActions}
            />
          </box>
        ))}
    </>
  );

  const ctx: BrowserContext = {
    session: state,
    prefs,
    chromium,
    history,
    downloads,
    prompts,
    rows,
    pinnedActions,
    checkingAction,
    privateOpen,
    focusedWindowId,
    dropHint,
    iconEpoch,
    hiddenViews,
    rt,
    findFor,
    actionStates,
    actionDefaults,
    moveTargets,
    openTab,
    closeTab,
    selectTab,
    setPinned,
    canSleep,
    sleepTab: (id) => void sleepTab(id),
    asleep: (id) => asleep[id] === true && !isLive(id),
    reopenTab,
    cycleTab,
    navigate,
    retry: (tabId) => patch(tabId, { error: null, attempt: rt(tabId).attempt + 1 }),
    command,
    zoomFor,
    setZoom,
    setLayout,
    openFind: (tabId) => setFind(tabId, (f) => ({ ...f, open: true })),
    closeFind,
    runFind,
    findCommand,
    decidePrompt,
    denyPromptsFor,
    resetSiteDecisions,
    refreshExtensions,
    pinExtension,
    clickAction,
    installTestExtension,
    newWindow,
    openPrivate: () => setPrivateOpen(true),
    openSettings: () => setSettingsOpen(true),
    moveTab,
    moveTabBy,
    moveTabTo,
    onTabDropped,
    setDropHint: (windowId, index) =>
      setDropHintState((h) => (h && h.windowId === windowId && h.index === index ? h : { windowId, index })),
    onDragStart: () => {},
    onDragEnd: () => setDropHintState(null),
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
      if (node) slots.current.set(windowId, node);
      else slots.current.delete(windowId);
    },
    registerController: (windowId, controller) => controllers.current.set(windowId, controller),
    controllerFor: (windowId) => controllers.current.get(windowId),
    runTestJs: (tabId) => {
      const node = view(tabId);
      const code = process.env.NB_TEST_JS;
      if (node && code) void executeJavaScript(node, code).catch(() => {});
    },
    onContextMenuItem,
  };

  return (
    <>
      {/* Every tab's page, each in a portal of its own in the framework's
          off-window pool. The portal keeps the view's React position fixed
          whichever window lists the tab, so moving a tab never unmounts its
          page; the placement effect shows it in its window's slot. One
          portal per tab, in id order, so no reorder of the tabs ever reorders
          these, and they come before the windows so that a closing window's
          pages are taken down before the window is. */}
      {[...allTabs]
        .filter((t) => t.url !== "" && isLive(t.id))
        .sort((a, b) => tabNumber(a.id) - tabNumber(b.id))
        .map((t) => {
          const w = windows.find((x) => x.tabs.includes(t))!;
          const tabRt = rt(t.id);
          const shown = w.activeId === t.id && tabRt.error === null;
          // React never attaches refs inside a subtree that mounts straight
          // into a hidden Activity, and without the ref a tab's context menu
          // is never registered and its URL is never set. A view therefore
          // stays "visible" for the one frame it takes to arm; it has no URL
          // yet, so the frame is blank.
          const arming = !armedTabs[t.id];
          return (
            <Fragment key={t.id}>
              {createPortal(
                <Activity mode={shown || arming ? "visible" : "hidden"}>
                  <webview
                    key={tabRt.attempt}
                    ref={(node) => {
                      views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                      if (!node) return;
                      // The view exists now, so its menu can be pushed; the
                      // render-time sync could only skip it.
                      syncContextMenus(t.id);
                      setArmedTabs((a) => (a[t.id] ? a : { ...a, [t.id]: true }));
                    }}
                    url={armedTabs[t.id] || createAtUrl(t.url) ? t.url : ""}
                    testID={`page-${t.id}`}
                    style={{ hexpand: true, vexpand: true }}
                    onNavigate={(e) => onNavigated(t.id, e.text)}
                    onTitleChanged={(e) => onTitled(t.id, e.text)}
                    onLoadingChanged={(e) => onLoading(t.id, e.checked)}
                    onLoadProgress={(e) => patch(t.id, { progress: e.value })}
                    onBackAvailable={(e) => patch(t.id, { canGoBack: e.checked })}
                    onForwardAvailable={(e) => patch(t.id, { canGoForward: e.checked })}
                    onLoadFailed={(e) => patch(t.id, { error: e.data as { url: string; error: string } })}
                    onNewWindow={(e) => openTabFromPage(t.id, e.text)}
                    onBrowserCommand={(e) => onBrowserCommand(t.id, e.text)}
                    onJavaScriptResult={onJavaScriptResult}
                    onPermissionRequest={(e) => onPermissionRequest(t.id, e.data)}
                    onFaviconChanged={(e) => onFavicon(t.url, e.data as { dataUrl?: string; iconUrl?: string })}
                    onSecurityChanged={(e) => patch(t.id, { security: securityOf(t.url, e.data) })}
                    onFindResult={(e) => {
                      // Two events per search on GTK: `done` carries the
                      // outcome, `done: false` carries the total from the
                      // separate counting pass, which AppKit never sends.
                      const r = e.data as { matchFound: boolean; matchCount?: number; done: boolean };
                      setFind(t.id, (f) => (r.done ? { ...f, found: r.matchFound } : { ...f, count: r.matchCount ?? null }));
                    }}
                    onContextMenuItemClicked={(e) => onContextMenuItem(t.id, e.data as ContextMenuItemClick)}
                    onDownloadRequested={(e) => {
                      const d = e.data as { id?: string; url: string; suggestedFilename?: string };
                      const node = view(t.id);
                      const engine = d.id && node ? { id: d.id, respond: (path: string) => sendCommand(node, "respondDownload", { id: d.id, path }) } : undefined;
                      startDownload(d.url, d.suggestedFilename, engine);
                    }}
                    onDownloadUpdated={(e) => onDownloadUpdated(e.data)}
                  />
                </Activity>,
              )}
            </Fragment>
          );
        })}

      {windows.map((w, i) => (
        <BrowserWindow key={w.id} win={w} first={i === 0} ctx={ctx} />
      ))}

      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
      {privateOpen && (
        <PrivateWindow
          onClose={() => setPrivateOpen(false)}
          onSettings={() => setSettingsOpen(true)}
          onDownloads={() => controllers.current.get(focusedWindowId)?.openDownloads()}
          onDownload={startDownload}
          onDownloadUpdated={onDownloadUpdated}
          moveTargets={moveTargets("private").filter((t) => t.id !== "private")}
          onMoveOut={(url, windowId, index) => openTab(windowId, url, false, index)}
          onAdopt={closeTab}
          bridge={privateBridge}
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
  const pinStyleIndex = Math.max(0, PIN_STYLES.findIndex((p) => p.id === prefs.pinStyle));

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
                    // The row hands its suffix only its minimum once the
                    // subtitle wants the width, and a toggle group's minimum
                    // is two ellipsized labels: "Comp…" in the capture.
                    style={{ minWidth: LAYOUT_SEGMENT_WIDTH }}
                    options={LAYOUTS.map((l) => l.name)}
                    selectedIndex={layoutIndex}
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
                    selectedIndex={pinStyleIndex}
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
                  testID="settings-fresh-window"
                  title="Start with a Fresh Window"
                  subtitle="Pinned tabs stay; the rest of last time's tabs don't come back"
                  checked={prefs.freshWindow}
                  onToggled={(e) => settings.update((s) => ({ ...s, freshWindow: e.checked }))}
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
