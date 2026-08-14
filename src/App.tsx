import {
  Spacing,
  executeJavaScript,
  onJavaScriptResult,
  onToastButtonClicked,
  onToastDismissed,
  sendCommand,
  showToast,
  useRef,
  useState,
  useStoreValue,
} from "@nativedesktop/react";
import type { NdNodeRef, SourceTreeAction, SourceTreeNode } from "@nativedesktop/react";
// <Activity mode="hidden"> is React's own keep-mounted-but-hidden primitive; it
// drives the renderer's hideInstance/unhideInstance hooks, which the host turns
// into gtk_widget_set_visible. That is what lets every tab keep a LIVE webview:
// switching tabs hides a widget instead of unmounting a subtree, so the page,
// its scroll position and its JS state all survive. @nativedesktop/react does
// not re-export it, hence the direct react import.
import { Activity } from "react";

import type { DownloadItem } from "./lib/downloads.ts";
import { runDownload } from "./lib/downloads.ts";
import { recentVisits, recordTitle, recordVisit, searchHistory, type Visit } from "./lib/history.ts";
import { session } from "./lib/session.ts";
import { SEARCH_PREFIX, displayUrl, fileNameFromUrl, hostOf, toUrl } from "./lib/url.ts";

const TAB_ACTIONS: SourceTreeAction[] = [
  { id: "close", iconName: "window-close-symbolic", tooltip: "Close tab" },
];

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
  { id: "new-tab", title: "New tab", hint: "Ctrl+T", iconName: "tab-new-symbolic" },
  { id: "close-tab", title: "Close tab", hint: "Ctrl+W", iconName: "window-close-symbolic" },
  { id: "reopen-tab", title: "Reopen closed tab", hint: "Ctrl+Shift+T", iconName: "edit-undo-symbolic" },
  { id: "reload", title: "Reload", hint: "Ctrl+R", iconName: "view-refresh-symbolic" },
  { id: "downloads", title: "Downloads", hint: "Sidebar", iconName: "folder-download-symbolic" },
  { id: "zoom-in", title: "Zoom in", hint: "Ctrl++", iconName: "zoom-in-symbolic" },
  { id: "zoom-out", title: "Zoom out", hint: "Ctrl+-", iconName: "zoom-out-symbolic" },
  { id: "zoom-reset", title: "Reset zoom", hint: "Ctrl+0", iconName: "zoom-original-symbolic" },
];

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

interface Runtime {
  loading: boolean;
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { url: string; error: string } | null;
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
  attempt: 0,
};

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

  const closed = useRef<{ url: string; title: string }[]>([]);
  const recentDownloads = useRef(new Map<string, number>());
  /// Last URL the engine actually committed per tab, so a download can put the
  /// tab back where it was.
  const committed = useRef(new Map<string, string>());
  const views = useRef(new Map<string, NdNodeRef<"webview"> | null>());
  const toast = useRef<NdNodeRef<"toastoverlay">>(null);

  const rt = (id: string): Runtime => runtime[id] ?? IDLE;
  const patch = (id: string, part: Partial<Runtime>): void =>
    setRuntime((r) => ({ ...r, [id]: { ...(r[id] ?? IDLE), ...part } }));
  const view = (id: string): NdNodeRef<"webview"> | null => views.current.get(id) ?? null;

  function refreshHistory(): void {
    void recentVisits().then(setHistory);
  }

  function openTab(url: string, background = false): void {
    session.update((s) => {
      const id = `t${s.nextTabId}`;
      return {
        ...s,
        tabs: [...s.tabs, { id, url, title: "" }],
        activeId: background ? s.activeId : id,
        nextTabId: s.nextTabId + 1,
      };
    });
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

  function startDownload(url: string, suggested?: string): void {
    // WebKitGTK's download-started signal lives on the network session, which
    // every view shares, so one download fires downloadRequested once per live
    // webview. Take the first and ignore the echoes.
    const now = Date.now();
    const seen = recentDownloads.current.get(url);
    if (seen !== undefined && now - seen < 5000) return;
    recentDownloads.current.set(url, now);

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
      case "downloads":
        return setDownloadsOpen(true);
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
  const pageTitle = active.title || (active.url ? displayUrl(active.url) : "New tab");

  const nodes: SourceTreeNode[] = tabs.map((t) => ({
    id: t.id,
    title: t.title || (t.url ? displayUrl(t.url) : "New tab"),
    caption: hostOf(t.url) || undefined,
    // Favicons are not exposed by the framework yet; the row keeps the icon
    // slot so swapping one in later is a one-line change.
    iconName: "web-browser-symbolic",
    actionIds: ["close"],
    testID: `tab-${t.id}`,
  }));

  // Ranking is entirely the app's job: <commandpalette> renders what it is
  // given, in order. Address first (that is what a browser bar is for), then
  // open tabs, then history, then app commands.
  const query = paletteQuery.trim();
  const lowered = query.toLowerCase();
  const paletteItems: PaletteItem[] = [];
  if (query) {
    const target = toUrl(query);
    if (target) {
      const searching = target.startsWith(SEARCH_PREFIX);
      paletteItems.push({
        id: "url",
        title: searching ? `Search DuckDuckGo for ${query}` : `Go to ${query}`,
        subtitle: searching ? undefined : target,
        iconName: searching ? "system-search-symbolic" : "web-browser-symbolic",
      });
    }
  }
  for (const t of tabs) {
    if (t.id === active.id) continue;
    const label = t.title || displayUrl(t.url) || "New tab";
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
          <menuitem testID="menu-new-tab" label="New tab" accelerator="primary+t" onSelect={newTab} />
          <menuitem
            testID="menu-address"
            label="Open address bar"
            accelerator="primary+l"
            onSelect={() => openPalette(active.url)}
          />
          <menuitem testID="menu-close-tab" label="Close tab" accelerator="primary+w" onSelect={() => closeTab(active.id)} />
          <menuitem
            testID="menu-reopen-tab"
            label="Reopen closed tab"
            accelerator="primary+shift+t"
            onSelect={reopenTab}
          />
        </menu>
        <menu label="View" testID="menu-view">
          <menuitem testID="menu-reload" label="Reload" accelerator="primary+r" onSelect={() => command("reload")} />
          <menuitem role="separator" testID="menu-view-sep" />
          <menuitem
            testID="menu-zoom-in"
            label="Zoom in"
            accelerator="primary+plus"
            onSelect={() => setZoom(zoomFor(active.url) + 0.1)}
          />
          <menuitem
            testID="menu-zoom-out"
            label="Zoom out"
            accelerator="primary+minus"
            onSelect={() => setZoom(zoomFor(active.url) - 0.1)}
          />
          <menuitem testID="menu-zoom-reset" label="Reset zoom" accelerator="primary+0" onSelect={() => setZoom(1)} />
        </menu>
        <menu label="Tabs" testID="menu-tabs">
          <menuitem testID="menu-next-tab" label="Next tab" accelerator="primary+tab" onSelect={() => cycleTab(1)} />
          <menuitem
            testID="menu-prev-tab"
            label="Previous tab"
            accelerator="primary+shift+tab"
            onSelect={() => cycleTab(-1)}
          />
          <menuitem role="separator" testID="menu-tabs-sep" />
          {tabs.map((t, i) => (
            <menuitem
              key={t.id}
              testID={`menu-tab-${i}`}
              label={t.title || (t.url ? displayUrl(t.url) : "New tab")}
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
          </menu>
        )}
        <menu label="History" testID="menu-history">
          {history.length === 0 ? (
            <menuitem testID="menu-history-empty" label="No history yet" enabled={false} />
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
                label="New tab"
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
                  {/* Test-only readout of the palette's ranked ids: palette rows
                      are not part of getTree, so a drive has no other way to
                      address a row by what it is rather than where it sits. */}
                  {TEST_HOOKS && (
                    <label
                      testID="palette-debug"
                      ellipsize
                      text={`q=${paletteQuery}|${paletteItems.map((i) => i.id).join(",")}`}
                    />
                  )}
                  <sourcelist
                    testID="downloads-list"
                    items={downloads.map((d) => ({
                      title: d.name,
                      iconName: d.state === "failed" ? "dialog-warning-symbolic" : "folder-download-symbolic",
                      badge: d.state === "running" ? "…" : undefined,
                    }))}
                    emptyIconName="folder-download-symbolic"
                    emptyTitle="No downloads yet"
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
              <button
                slot="start"
                testID="omnibox"
                label={shownUrl || "Search or enter address"}
                tooltip="Search or enter address (Ctrl+L)"
                ellipsize
                cssClasses={["flat", "pill"]}
                style={{ hexpand: true }}
                onClick={() => openPalette(active.url)}
              />
            </headerbar>

            <box testID="content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
              {activeRt.loading && <progressbar testID="progress" fraction={activeRt.progress} />}

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
                .filter((t) => t.url !== "")
                .map((t) => {
                  const state = rt(t.id);
                  const shown = t.id === active.id && state.error === null;
                  return (
                    <Activity key={t.id} mode={shown ? "visible" : "hidden"}>
                      <webview
                        key={state.attempt}
                        ref={(node) => {
                          views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                        }}
                        url={t.url}
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
                    label="Try again"
                    cssClasses={["suggested-action", "pill"]}
                    onClick={() => patch(active.id, { error: null, attempt: activeRt.attempt + 1 })}
                  />
                </statuspage>
              )}

              {active.url === "" && (
                <statuspage
                  testID="new-tab-page"
                  iconName="web-browser-symbolic"
                  title="New tab"
                  description="Search the web, or open a page you have visited before."
                  style={{ vexpand: true }}
                >
                  <button
                    testID="new-tab-search"
                    label="Search or enter address"
                    cssClasses={["suggested-action", "pill"]}
                    onClick={() => openPalette("")}
                  />
                </statuspage>
              )}
            </box>
          </toolbarview>
        </splitview>
      </toastoverlay>
    </window>
  );
}
