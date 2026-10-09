// A private window is a second top-level window whose webviews all share ONE
// ephemeral network session: the framework treats a `profile` name beginning
// with "private" as a partition that never touches disk, so cookies, cache and
// storage die with the window.
//
// It is deliberately plainer than the main window: nothing here writes to the
// session store or the history database, which is the whole point. That means
// no command palette (its ranking reads history) and no downloads list; the
// address field IS the address bar, which is also the only place in the app
// that exercises `<searchinput>` on GTK.
import {
  Activity,
  Platform,
  Spacing,
  allowPopups,
  executeJavaScript,
  newWindowRequest,
  openBlockedPopup,
  sendCommand,
} from "@nativedesktop/react";
import type {
  NdNodeRef,
  NewWindowRequest,
  PopupBlocked,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";
import { For, Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";

import type { MoveTarget } from "./BrowserWindow.tsx";
import { ADDRESS_MIN_WIDTH, CompactTabs, tabRunMetrics } from "./CompactTabs.tsx";
import { PopupBlockedControl } from "./PopupBlocked.tsx";
import { FIND_BAR_WIDTH } from "./lib/metrics.ts";
import { permissionSentence, splitTypes, type PermissionPrompt, type PermissionResult } from "./lib/permissions.ts";
import { placeOpenedTab } from "./lib/session.ts";
import { settings } from "./lib/settings.ts";
import { trackStore } from "./lib/live.ts";
import { parseTabPayload, tabPayload } from "./lib/tabdrag.ts";
import { tabHover } from "./lib/tabstate.ts";
import { displayUrl, hostOf, toUrl, fieldAddress } from "./lib/url.ts";
import { fixWebStore } from "./lib/webstore.ts";

const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 720;

const TAB_ACTIONS: SourceTreeAction[] = [
  { id: "close", iconName: "window-close-symbolic", tooltip: "Close Tab" },
];

/// One ephemeral partition for the whole window, so private tabs share a
/// session with each other and with nothing else.
const PRIVATE_PROFILE = "private-window";

interface PrivateTab {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /// Pop-ups the engine blocked on the page now showing.
  popups: PopupBlocked[];
}

function blankTab(id: string): PrivateTab {
  return { id, url: "", title: "", canGoBack: false, canGoForward: false, loading: false, popups: [] };
}

/// How the rest of the app hands this window a tab from a normal window. The
/// page cannot come with it: this window's pages live on an ephemeral profile
/// of their own, so the address is reopened here.
export interface PrivateBridge {
  open(url: string, index: number): void;
  /// A private tab dropped on a normal window, reopened there.
  close(tabId: string): void;
}

/// What a private window cannot own itself. Settings and the downloads list
/// are one per app and live in the main window, so the private window's menu
/// routes to them rather than growing copies.
export interface PrivateWindowProps {
  onClose: () => void;
  onSettings: () => void;
  onDownloads: () => void;
  /// The root's download handlers, spread on every private view. Private
  /// browsing hides the trail, it does not refuse the file: what you download
  /// is still saved, and it lands in the one downloads list the app has.
  downloadHandlers: (node: () => NdNodeRef<"webview"> | null) => {
    onDownloadRequested: (e: { data: unknown }) => void;
    onDownloadUpdated: (e: { data: unknown }) => void;
  };
  /// The normal windows a tab can be sent to, and the call that reopens one
  /// there. A private page never moves live into a normal window: its
  /// cookies and storage are this window's and nobody else's.
  moveTargets: MoveTarget[];
  onMoveOut: (url: string, windowId: string, index: number) => void;
  /// A normal window's tab dropped here: the root closes it where it was.
  onAdopt: (tabId: string) => void;
  /// A sized window.open from a private page: the root draws the pop-up
  /// window, and what it opens comes back here.
  onPopupWindow: (popup: string, url: string, features: NewWindowRequest["features"], onNewWindow: (e: { text: string }) => void) => void;
  bridge: { current: PrivateBridge | null };
}

/// How many blocked pop-ups a tab lists, as in the main window.
const BLOCKED_POPUPS_KEPT = 8;

export function PrivateWindow(props: PrivateWindowProps) {
  const prefs = trackStore(settings);
  const compact = (): boolean => prefs.layout === "compact";
  const [tabs, setTabs] = createSignal<PrivateTab[]>([blankTab("p1")]);
  const [activeId, setActiveId] = createSignal("p1");
  const [findOpen, setFindOpen] = createSignal(false);
  /// Same queue the main window keeps, with one difference that is the whole
  /// point of this window: nothing a page is allowed to do here is written
  /// down, so every request is asked again.
  const [prompts, setPrompts] = createSignal<PermissionPrompt[]>([]);
  const [siteInfoOpen, setSiteInfoOpen] = createSignal(false);
  let pending: PermissionPrompt[] = [];
  let next = 2;
  const views = new Map<string, NdNodeRef<"webview">>();
  /// The header's address field, so the menu's Open Address Bar can put the
  /// caret in it. Grab-focus selects the contents on both backends.
  let omnibox: NdNodeRef<"searchinput"> | undefined;

  const [width, setWidth] = createSignal(WINDOW_WIDTH);
  /// Where a tab dragged over the row would land. There is no drag-leave
  /// event, so it clears when the drag ends or drops.
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);

  const active = createMemo((): PrivateTab => tabs().find((t) => t.id === activeId()) ?? tabs()[0]!);

  // Fullscreen as in the main window: a page's element fullscreen or F11 takes
  // the window, with the chrome put away.
  let windowRef: NdNodeRef<"window"> | undefined;
  const [pageFullscreen, setPageFullscreen] = createSignal("");
  const [browserFullscreen, setBrowserFullscreen] = createSignal(false);
  const immersive = (): boolean => pageFullscreen() !== "" || browserFullscreen();
  let windowFullscreen = false;
  createEffect(immersive, (on) => {
    if (on === windowFullscreen || !windowRef) return;
    windowFullscreen = on;
    sendCommand(windowRef, "setFullscreen", { fullscreen: on });
  });
  createEffect(
    () => active().id,
    (id) => {
      const tab = pageFullscreen();
      if (!tab || tab === id) return;
      exitPageFullscreen(tab);
      setPageFullscreen("");
    },
  );
  function exitPageFullscreen(tab: string): void {
    const view = views.get(tab);
    if (view) sendCommand(view, "exitFullscreen");
  }
  function leaveFullscreen(): void {
    const tab = pageFullscreen();
    if (tab) exitPageFullscreen(tab);
    setPageFullscreen("");
    setBrowserFullscreen(false);
  }
  const activePrompt = createMemo(() => prompts().find((p) => p.tabId === active().id) ?? null);
  /// A private tab is never pinned: nothing about this window outlives it, so
  /// there is nothing for a pin to keep.
  const runTabs = createMemo(() => tabs().map((t) => ({ id: t.id, url: t.url, title: t.title, pinned: false })));

  /// A page event that changes nothing writes nothing.
  function patch(id: string, part: Partial<PrivateTab>): void {
    setTabs((list) => {
      const now = list.find((t) => t.id === id);
      if (!now || (Object.keys(part) as (keyof PrivateTab)[]).every((k) => Object.is(now[k], part[k]))) return list;
      return list.map((t) => (t.id === id ? { ...t, ...part } : t));
    });
  }

  function openTab(url = "", index?: number, background = false): string {
    const id = `p${next++}`;
    setTabs((list) => {
      const at = index ?? list.length;
      return [...list.slice(0, at), { ...blankTab(id), url }, ...list.slice(at)];
    });
    if (!background) setActiveId(id);
    return id;
  }

  /// A tab one of this window's pages asked for, placed the way Chrome
  /// places it. "window" stays a tab: this window is the private one.
  const openers = new Map<string, string>();
  function openFromPage(fromTab: string, e: { text: string }): void {
    const request = newWindowRequest(e);
    const target = request.url.trim();
    if (!target || target === "about:blank") return;
    if (request.disposition === "popup" && request.popup) {
      props.onPopupWindow(request.popup, target, request.features, (next) => openFromPage("", next));
      return;
    }
    const place = placeOpenedTab(tabs(), fromTab, openers, request.disposition);
    const id = openTab(target, place.index, !place.foreground);
    openers.set(id, fromTab);
    if (request.popup) pendingPopups.set(id, request.popup);
  }
  /// Tabs whose view takes over a browser window.open already made.
  const pendingPopups = new Map<string, string>();

  props.bridge.current = { open: (url, index) => openTab(url, index), close: (tabId) => closeTab(tabId) };

  /// A reorder within this window: the page stays live, it only changes
  /// place in the list.
  function moveTab(id: string, index: number): void {
    setTabs((list) => {
      const tab = list.find((t) => t.id === id);
      if (!tab) return list;
      const rest = list.filter((t) => t.id !== id);
      const at = Math.max(0, Math.min(rest.length, index));
      return [...rest.slice(0, at), tab, ...rest.slice(at)];
    });
    setActiveId(id);
  }

  function moveOut(windowId: string): void {
    props.onMoveOut(active().url, windowId, Number.MAX_SAFE_INTEGER);
    closeTab(active().id);
  }

  function onDropAt(payload: string, index: number): void {
    setDropIndex(null);
    const drag = parseTabPayload(payload);
    if (!drag) return;
    if (drag.profile === "private") {
      const from = tabs().findIndex((t) => t.id === drag.tabId);
      if (from < 0) return;
      // The slot was counted with the dragged tab still in the row.
      moveTab(drag.tabId, from < index ? index - 1 : index);
      return;
    }
    // A normal tab: a page on another profile cannot come across live.
    openTab(drag.url, index);
    props.onAdopt(drag.tabId);
  }

  /// Tabs whose page is being asked whether it may go.
  const closing = new Set<string>();

  /// A close the user asked for, after the page's beforeunload agrees.
  function requestCloseTab(id: string): void {
    const node = views.get(id);
    if (!node) return closeTab(id);
    closing.add(id);
    sendCommand(node, "requestClose");
  }

  function closeTab(id: string): void {
    dismissPromptsFor(id);
    views.delete(id);
    // The last tab takes the window with it, the way a normal window's does.
    const list = tabs();
    if (list.length === 1 && list[0]!.id === id) {
      props.onClose();
      return;
    }
    let rest: PrivateTab[] = [];
    setTabs((now) => (rest = now.filter((t) => t.id !== id)));
    setActiveId((cur) => (cur === id ? rest[rest.length - 1]!.id : cur));
  }

  function command(name: "goBack" | "goForward" | "reload"): void {
    const node = views.get(active().id);
    if (node) sendCommand(node, name);
  }

  /// Find runs against the ACTIVE tab's view, the same rule the main window
  /// follows: the bar belongs to the window, and a search on a hidden tab has
  /// nothing to highlight.
  function findCommand(name: "findStart" | "findNext" | "findPrevious" | "findStop", arg?: unknown): void {
    const node = views.get(active().id);
    if (node) sendCommand(node, name, arg);
  }

  function closeFind(): void {
    findCommand("findStop");
    setFindOpen(false);
    const node = views.get(active().id);
    if (node) sendCommand(node, "focus");
  }

  /// An id left unanswered leaves the page waiting for ever, so every way a
  /// prompt can leave this queue answers it first, as a dismissal.
  /// A plain array with the signal mirroring it, for the reason the main
  /// window's copy explains: answering closes the popover, and the close
  /// handler must not answer the same id a second time.
  function setQueue(queue: PermissionPrompt[]): void {
    pending = queue;
    setPrompts(queue);
  }

  function respond(tabId: string, id: string, result: PermissionResult): void {
    const node = views.get(tabId);
    if (node) sendCommand(node, "respondPermission", { id, result });
  }

  function dismissPromptsFor(tabId: string): void {
    const doomed = pending.filter((p) => p.tabId === tabId);
    if (doomed.length === 0) return;
    for (const prompt of doomed) respond(tabId, prompt.id, "dismiss");
    setQueue(pending.filter((p) => p.tabId !== tabId));
  }

  function answerPrompt(prompt: PermissionPrompt, result: PermissionResult): void {
    respond(prompt.tabId, prompt.id, result);
    setQueue(pending.filter((p) => p.id !== prompt.id));
    setSiteInfoOpen(false);
  }

  function onPermissionRequest(tabId: string, data: unknown): void {
    const request = (data ?? {}) as { id?: string; origin?: string; types?: string };
    if (!request.id) return;
    setQueue([
      ...pending,
      { id: request.id, tabId, origin: request.origin ?? "", types: splitTypes(request.types ?? "") },
    ]);
    if (tabId === active().id) setSiteInfoOpen(true);
  }

  function navigate(raw: string): void {
    const target = toUrl(fieldAddress(raw, active().url));
    if (!target) return;
    if (active().url === target) return command("reload");
    patch(active().id, { url: target });
  }

  const nodes = createMemo((): SourceTreeNode[] =>
    tabs().map((t) => ({
      id: t.id,
      title: t.title || (t.url ? displayUrl(t.url) : "New Tab"),
      iconName: "view-conceal-symbolic",
      actionIds: ["close"],
      testID: `private-tab-${t.id}`,
    })),
  );

  /// The pages, in id order, not tab order: a reorder must never move a live
  /// view within its parent, only the tab list.
  const pages = createMemo(() =>
    tabs()
      .filter((t) => t.url !== "")
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
  );

  function Page(v: { tab: PrivateTab }) {
    const id = v.tab.id;
    let node!: NdNodeRef<"webview">;
    // Given no address until it has reported its own, as in the main window.
    const popup = pendingPopups.get(id);
    pendingPopups.delete(id);
    const [adopting, setAdopting] = createSignal(popup !== undefined);
    onSettled(() => {
      views.set(id, node);
      fixWebStore(node);
      return () => {
        if (views.get(id) === node) views.delete(id);
      };
    });
    return (
      <webview
        ref={node}
        url={adopting() ? "" : v.tab.url}
        popup={popup}
        adoptPopups
        profile={PRIVATE_PROFILE}
        testID={`private-page-${id}`}
        style={{ hexpand: true, vexpand: true }}
        onNavigate={(e) => {
          // The blocked list belongs to the page that tried, as Chrome's does.
          const moved = tabs().find((t) => t.id === id)?.url !== e.text;
          patch(id, moved ? { url: e.text, popups: [] } : { url: e.text });
          setAdopting(false);
        }}
        onPopupBlocked={(e) => {
          const blocked = e.data as PopupBlocked;
          const now = tabs().find((t) => t.id === id)?.popups ?? [];
          patch(id, { popups: [...now.filter((b) => b.url !== blocked.url), blocked].slice(-BLOCKED_POPUPS_KEPT) });
        }}
        onWindowClosed={() => closeTab(id)}
        onTitleChanged={(e) => patch(id, { title: e.text })}
        onLoadingChanged={(e) => patch(id, { loading: e.checked })}
        onBackAvailable={(e) => patch(id, { canGoBack: e.checked })}
        onForwardAvailable={(e) => patch(id, { canGoForward: e.checked })}
        onNewWindow={(e) => openFromPage(id, e)}
        onPermissionRequest={(e) => onPermissionRequest(id, e.data)}
        onFullscreenChanged={(e) => {
          if (e.checked) setPageFullscreen(id);
          else if (pageFullscreen() === id) setPageFullscreen("");
        }}
        onCloseApproved={() => {
          if (closing.delete(id)) closeTab(id);
        }}
        onBrowserCommand={(e) => {
          // The page's own Chrome shortcuts, for the ones this window has an
          // answer to. A new private window is this one, which is already
          // open.
          if (e.text === "newTab") openTab();
          if (e.text === "fullscreen") {
            if (immersive()) leaveFullscreen();
            else setBrowserFullscreen(true);
          }
          if (e.text === "closeTab") requestCloseTab(id);
          const view = views.get(id);
          if (e.text === "print" && view) void executeJavaScript(view, "window.print()").catch(() => {});
        }}
        {...props.downloadHandlers(() => views.get(id) ?? null)}
      />
    );
  }

  return (
    <window
      ref={windowRef}
      title="Private Browsing"
      testID="private-window"
      defaultWidth={WINDOW_WIDTH}
      defaultHeight={WINDOW_HEIGHT}
      onClosed={() => props.onClose()}
      onSizeChanged={(e) => setWidth((e.data as { width: number }).width)}
      onFullscreenChanged={(e) => {
        windowFullscreen = e.checked;
        if (e.checked) {
          if (Platform.backend === "gtk" && !immersive()) setBrowserFullscreen(true);
          return;
        }
        if (immersive()) leaveFullscreen();
      }}
    >
      <splitview sidebarWidth={0.24} collapsed={immersive()} testID="private-split">
        {/* Compact drops this pane here for the same reason the main window
            does: the content pane stays the splitview's second child, so no
            webview moves and no page reloads. */}
        <Show when={!compact()}>
          <toolbarview slot="sidebar" testID="private-sidebar-toolbar">
            <headerbar testID="private-sidebar-header" title="Private" />
            {/* Same metrics as the main window's column: see the comments there
                for why the row inset rides a box around the New Tab button and
                why the tree indents by nothing. */}
            <box
              testID="private-sidebar"
              orientation="vertical"
              spacing={Spacing.xs}
              style={{ vexpand: true, padding: { top: Spacing.sm, bottom: Spacing.sm } }}
            >
              <box orientation="horizontal" style={{ hexpand: true, padding: { left: Spacing.md } }}>
                <button
                  testID="private-new-tab"
                  label="New Tab"
                  iconName="tab-new-symbolic"
                  labelAlign="start"
                  cssClasses={["flat"]}
                  style={{ hexpand: true }}
                  onClick={() => openTab()}
                />
              </box>
              <sourcetree
                testID="private-tab-list"
                nodes={nodes()}
                actions={TAB_ACTIONS}
                selectedId={active().id}
                indentationPerLevel={0}
                style={{ vexpand: true }}
                onSelectionChanged={(e) => {
                  const { nodeId } = e.data as { nodeId: string | null };
                  if (nodeId) setActiveId(nodeId);
                }}
                onActionClicked={(e) => {
                  const { nodeId, actionId } = e.data as { nodeId: string; actionId: string };
                  if (actionId === "close") requestCloseTab(nodeId);
                }}
              />
            </box>
          </toolbarview>
        </Show>

        <toolbarview slot="content" testID="private-content-toolbar">
          <Activity mode={immersive() ? "hidden" : "visible"}>
            <headerbar
              testID="private-chrome"
              title=""
              canGoBack={active().canGoBack}
              canGoForward={active().canGoForward}
              onBack={() => command("goBack")}
              onForward={() => command("goForward")}
            >
              <button
                slot="start"
                testID="private-reload"
                iconName="view-refresh-symbolic"
                tooltip="Reload"
                cssClasses={["flat"]}
                onClick={() => command("reload")}
              />

              {/* The same compact row the main window draws: tabs in the toolbar
                  between reload and the address field, nothing below it. */}
              <Show when={compact()}>
                <CompactTabs
                  tabs={runTabs()}
                  activeId={active().id}
                  metrics={tabRunMetrics(width(), runTabs(), active().id, 0, Platform.backend === "gtk" ? "gtk" : "appkit", true)}
                  prefix="private-"
                  // A private window shows no favicons: the cache is on disk and
                  // this window writes nothing there.
                  iconFor={() => undefined}
                  labelFor={(t) => t.title || (t.url ? displayUrl(t.url) : "New Tab")}
                  hoverFor={tabHover}
                  onSelect={setActiveId}
                  onClose={requestCloseTab}
                  dragPayload={(t) => tabPayload({ profile: "private", tabId: t.id, url: t.url })}
                  dropIndex={dropIndex()}
                  onDragOverIndex={setDropIndex}
                  onDropAt={onDropAt}
                  onDragStart={() => {}}
                  onDragEnd={() => setDropIndex(null)}
                />
                <button
                  slot="start"
                  testID="private-header-new-tab"
                  iconName="list-add-symbolic"
                  tooltip="New Tab"
                  cssClasses={["flat"]}
                  onClick={() => openTab()}
                />
              </Show>

              {/* The private window's site-info button: it answers permission
                  requests and says what this window will not do, which is
                  remember any of them. */}
              <box testID="private-site-info-anchor" orientation="horizontal">
                <button
                  testID="private-site-info"
                  iconName="web-browser-symbolic"
                  tooltip="Site Information"
                  cssClasses={["flat"]}
                  onClick={() => setSiteInfoOpen(!siteInfoOpen())}
                />
                <popover
                  testID="private-site-info-popover"
                  open={siteInfoOpen()}
                  position="bottom"
                  onClosed={() => {
                    setSiteInfoOpen(false);
                    dismissPromptsFor(active().id);
                  }}
                >
                  <box
                    testID="private-site-info-panel"
                    orientation="vertical"
                    spacing={Spacing.sm}
                    style={{ padding: Spacing.sm, minWidth: FIND_BAR_WIDTH - 100 }}
                  >
                    <label
                      testID="private-site-info-host"
                      text={hostOf(active().url) || "New Tab"}
                      cssClasses={["heading"]}
                      style={{ halign: "start" }}
                    />
                    <Show
                      when={activePrompt()}
                      fallback={
                        <label
                          testID="private-site-permissions-note"
                          text="Choices you make here are forgotten when this window closes."
                          cssClasses={["dimmed"]}
                          style={{ halign: "start" }}
                        />
                      }
                    >
                      {(prompt) => (
                        <box orientation="vertical" spacing={Spacing.sm}>
                          <label
                            testID="private-permission-request"
                            text={permissionSentence(hostOf(active().url) || prompt().origin, prompt().types)}
                            style={{ halign: "start" }}
                          />
                          <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
                            <button
                              testID="private-permission-block"
                              label="Block"
                              onClick={() => answerPrompt(prompt(), "deny")}
                            />
                            <button
                              testID="private-permission-allow"
                              label="Allow"
                              cssClasses={["suggested-action"]}
                              onClick={() => answerPrompt(prompt(), "allow")}
                            />
                          </box>
                        </box>
                      )}
                    </Show>
                  </box>
                </popover>
              </box>
              <PopupBlockedControl
                prefix="private-"
                position="bottom"
                scope={active().id}
                urls={active().popups.map((b) => b.url)}
                site={hostOf(active().url)}
                onOpen={(url) => {
                  const tab = active();
                  const blocked = tab.popups.find((b) => b.url === url);
                  const node = views.get(tab.id);
                  patch(tab.id, { popups: tab.popups.filter((b) => b.url !== url) });
                  if (blocked && node) void openBlockedPopup(node, blocked).catch(() => {});
                }}
                onAllow={() => {
                  const tab = active();
                  const node = views.get(tab.id);
                  if (node && tab.url) allowPopups(node, tab.url);
                  patch(tab.id, { popups: [] });
                }}
              />
              {/* Packed straight into the header bar, not boxed: the host
                  promotes a search entry there to the title widget with
                  hexpand, which is what gives it the row's whole free run. */}
              <searchinput
                ref={omnibox}
                testID="private-omnibox"
                text={displayUrl(active().url)}
                placeholder="Search or enter address"
                style={{ hexpand: true, minWidth: ADDRESS_MIN_WIDTH }}
                onActivate={(e) => navigate(e.text)}
              />
              {/* The app's one primary menu button is packed into whichever
                  header bar the framework last registered, so a second window
                  gets none. This is the private window's own: without it
                  Settings, Find and Downloads have no route from here. Settings
                  and Downloads are one per app and open in the main window;
                  Find is this window's own. */}
              <menubutton slot="end" testID="private-menu" iconName="open-menu-symbolic">
                <menuitem testID="private-menu-new-tab" label="New Tab" onSelect={() => openTab()} />
                <menuitem
                  testID="private-menu-address"
                  label="Open Address Bar"
                  onSelect={() => {
                    if (omnibox) sendCommand(omnibox, "focus");
                  }}
                />
                <menuitem testID="private-menu-find" label="Find in Page" onSelect={() => setFindOpen(true)} />
                <menuitem role="separator" testID="private-menu-sep-move" />
                <menuitem
                  testID="private-menu-move-left"
                  label="Move Tab Left"
                  enabled={tabs().indexOf(active()) > 0}
                  onSelect={() => moveTab(active().id, tabs().indexOf(active()) - 1)}
                />
                <menuitem
                  testID="private-menu-move-right"
                  label="Move Tab Right"
                  enabled={tabs().indexOf(active()) < tabs().length - 1}
                  onSelect={() => moveTab(active().id, tabs().indexOf(active()) + 1)}
                />
                <Show when={props.moveTargets.length > 0}>
                  <menu label="Move Tab to Window" testID="private-menu-move-to">
                    <For each={props.moveTargets} keyed={(t) => t.id}>
                      {(t) => (
                        <menuitem
                          testID={`private-menu-move-to-${t().id}`}
                          label={t().label}
                          enabled={active().url !== ""}
                          onSelect={() => moveOut(t().id)}
                        />
                      )}
                    </For>
                  </menu>
                </Show>
                <menuitem role="separator" testID="private-menu-sep" />
                <menuitem testID="private-menu-downloads" label="Downloads" onSelect={() => props.onDownloads()} />
                <menuitem testID="private-menu-settings" label="Settings" onSelect={() => props.onSettings()} />
              </menubutton>
            </headerbar>
          </Activity>

          <box testID="private-content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
            {/* The marker. A private window that looks like an ordinary one is
                the failure mode this banner exists to prevent. GNOME HIG
                *Banners*: one short title, no lengthy explanation, so it states
                the fact and the status page below carries the detail. */}
            <banner testID="private-banner" title="Private browsing. This window keeps no history." revealed={!immersive()} />

            {/* The find bar floats over the page here for the same reason it
                does in the main window: see the comment on the main window's
                find anchor for why it has to be a popover on Linux. */}
            <overlay testID="private-page-stack" style={{ hexpand: true, vexpand: true }}>
              <box orientation="vertical" style={{ hexpand: true, vexpand: true }}>
                <For each={pages()} keyed={(t) => t.id}>
                  {(t) => (
                    <Activity mode={t().id === active().id ? "visible" : "hidden"}>
                      <Page tab={t()} />
                    </Activity>
                  )}
                </For>

                <Show when={active().url === ""}>
                  <statuspage
                    testID="private-new-tab-page"
                    iconName="view-conceal-symbolic"
                    title="Private Browsing"
                    description="Cookies, cache and history are discarded when you close this window. Anything you download is still saved."
                    style={{ vexpand: true }}
                  />
                </Show>
              </box>

              <box
                testID="private-find-anchor"
                orientation="horizontal"
                style={{
                  halign: "end",
                  valign: "start",
                  minWidth: FIND_BAR_WIDTH,
                  minHeight: 1,
                  margin: { top: Spacing.sm, right: Spacing.md },
                }}
              >
                <Show when={findOpen()}>
                  <popover testID="private-find-popover" open position="bottom" onClosed={closeFind}>
                    <box
                      testID="private-find-bar"
                      orientation="horizontal"
                      spacing={Spacing.sm}
                      style={{ padding: Spacing.sm, minWidth: FIND_BAR_WIDTH }}
                    >
                      <searchinput
                        testID="private-find-query"
                        placeholder="Find in Page"
                        style={{ hexpand: true }}
                        onChanged={(e) => (e.text ? findCommand("findStart", { text: e.text }) : findCommand("findStop"))}
                        onActivate={() => findCommand("findNext")}
                      />
                      <button
                        testID="private-find-previous"
                        iconName="go-up-symbolic"
                        tooltip="Previous match"
                        cssClasses={["flat"]}
                        onClick={() => findCommand("findPrevious")}
                      />
                      <button
                        testID="private-find-next"
                        iconName="go-down-symbolic"
                        tooltip="Next match"
                        cssClasses={["flat"]}
                        onClick={() => findCommand("findNext")}
                      />
                      <button
                        testID="private-find-close"
                        iconName="window-close-symbolic"
                        tooltip="Close"
                        cssClasses={["flat"]}
                        onClick={closeFind}
                      />
                    </box>
                  </popover>
                </Show>
              </box>
            </overlay>
          </box>
        </toolbarview>
      </splitview>
    </window>
  );
}
