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
import { Platform, Spacing, executeJavaScript, sendCommand, useRef, useState, useStoreValue } from "@nativedesktop/react";
import type {
  NdNodeRef,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";
import { Activity } from "react";

import type { MoveTarget } from "./BrowserWindow.tsx";
import { ADDRESS_MIN_WIDTH, CompactTabs, tabRunMetrics } from "./CompactTabs.tsx";
import { FIND_BAR_WIDTH } from "./lib/metrics.ts";
import { permissionSentence, splitTypes, type PermissionPrompt } from "./lib/permissions.ts";
import { settings } from "./lib/settings.ts";
import { parseTabPayload, tabPayload } from "./lib/tabdrag.ts";
import { displayUrl, hostOf, toUrl, fieldAddress } from "./lib/url.ts";

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
}

function blankTab(id: string): PrivateTab {
  return { id, url: "", title: "", canGoBack: false, canGoForward: false, loading: false };
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
  bridge: { current: PrivateBridge | null };
}

export function PrivateWindow({
  onClose,
  onSettings,
  onDownloads,
  downloadHandlers,
  moveTargets,
  onMoveOut,
  onAdopt,
  bridge,
}: PrivateWindowProps): React.ReactNode {
  const prefs = useStoreValue(settings);
  const compact = prefs.layout === "compact";
  const [tabs, setTabs] = useState<PrivateTab[]>([blankTab("p1")]);
  const [activeId, setActiveId] = useState("p1");
  const [findOpen, setFindOpen] = useState(false);
  /// Same queue the main window keeps, with one difference that is the whole
  /// point of this window: nothing a page is allowed to do here is written
  /// down, so every request is asked again.
  const [prompts, setPrompts] = useState<PermissionPrompt[]>([]);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const pending = useRef<PermissionPrompt[]>([]);
  const next = useRef(2);
  const views = useRef(new Map<string, NdNodeRef<"webview"> | null>());
  /// The header's address field, so the menu's Open Address Bar can put the
  /// caret in it. Grab-focus selects the contents on both backends.
  const omnibox = useRef<NdNodeRef<"searchinput"> | null>(null);

  const [width, setWidth] = useState(WINDOW_WIDTH);
  /// Where a tab dragged over the row would land. There is no drag-leave
  /// event, so it clears when the drag ends or drops.
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const activePrompt = prompts.find((p) => p.tabId === active.id) ?? null;
  /// A private tab is never pinned: nothing about this window outlives it, so
  /// there is nothing for a pin to keep.
  const runTabs = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, pinned: false }));

  function patch(id: string, part: Partial<PrivateTab>): void {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...part } : t)));
  }

  function openTab(url = "", index?: number): void {
    const id = `p${next.current++}`;
    setTabs((list) => {
      const at = index ?? list.length;
      return [...list.slice(0, at), { ...blankTab(id), url }, ...list.slice(at)];
    });
    setActiveId(id);
  }

  bridge.current = { open: (url, index) => openTab(url, index), close: (tabId) => closeTab(tabId) };

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
    onMoveOut(active.url, windowId, Number.MAX_SAFE_INTEGER);
    closeTab(active.id);
  }

  function onDropAt(payload: string, index: number): void {
    setDropIndex(null);
    const drag = parseTabPayload(payload);
    if (!drag) return;
    if (drag.profile === "private") {
      const from = tabs.findIndex((t) => t.id === drag.tabId);
      if (from < 0) return;
      // The slot was counted with the dragged tab still in the row.
      moveTab(drag.tabId, from < index ? index - 1 : index);
      return;
    }
    // A normal tab: a page on another profile cannot come across live.
    openTab(drag.url, index);
    onAdopt(drag.tabId);
  }

  function closeTab(id: string): void {
    denyPromptsFor(id);
    views.current.delete(id);
    // The last tab takes the window with it, the way a normal window's does.
    if (tabs.length === 1 && tabs[0]!.id === id) {
      onClose();
      return;
    }
    setTabs((list) => {
      const rest = list.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(rest[rest.length - 1]!.id);
      return rest;
    });
  }

  function command(name: "goBack" | "goForward" | "reload"): void {
    const node = views.current.get(active.id);
    if (node) sendCommand(node, name);
  }

  /// Find runs against the ACTIVE tab's view, the same rule the main window
  /// follows: the bar belongs to the window, and a search on a hidden tab has
  /// nothing to highlight.
  function findCommand(name: "findStart" | "findNext" | "findPrevious" | "findStop", arg?: unknown): void {
    const node = views.current.get(active.id);
    if (node) sendCommand(node, name, arg);
  }

  function closeFind(): void {
    findCommand("findStop");
    setFindOpen(false);
    const node = views.current.get(active.id);
    if (node) sendCommand(node, "focus");
  }

  /// An id left unanswered leaves the page waiting for ever, so every way a
  /// prompt can leave this queue answers it first. Block is the safe answer.
  /// A ref with the state mirroring it, for the reason the main window's copy
  /// explains: answering closes the popover, and the close handler must not
  /// answer the same id a second time.
  function setQueue(next: PermissionPrompt[]): void {
    pending.current = next;
    setPrompts(next);
  }

  function respond(tabId: string, id: string, allow: boolean): void {
    const node = views.current.get(tabId);
    if (node) sendCommand(node, "respondPermission", { id, allow });
  }

  function denyPromptsFor(tabId: string): void {
    const doomed = pending.current.filter((p) => p.tabId === tabId);
    if (doomed.length === 0) return;
    for (const prompt of doomed) respond(tabId, prompt.id, false);
    setQueue(pending.current.filter((p) => p.tabId !== tabId));
  }

  function answerPrompt(prompt: PermissionPrompt, allow: boolean): void {
    respond(prompt.tabId, prompt.id, allow);
    setQueue(pending.current.filter((p) => p.id !== prompt.id));
    setSiteInfoOpen(false);
  }

  function onPermissionRequest(tabId: string, data: unknown): void {
    const request = (data ?? {}) as { id?: string; origin?: string; types?: string };
    if (!request.id) return;
    setQueue([
      ...pending.current,
      { id: request.id, tabId, origin: request.origin ?? "", types: splitTypes(request.types ?? "") },
    ]);
    if (tabId === active.id) setSiteInfoOpen(true);
  }

  function navigate(raw: string): void {
    const target = toUrl(fieldAddress(raw, active.url));
    if (!target) return;
    if (active.url === target) return command("reload");
    patch(active.id, { url: target });
  }

  const nodes: SourceTreeNode[] = tabs.map((t) => ({
    id: t.id,
    title: t.title || (t.url ? displayUrl(t.url) : "New Tab"),
    iconName: "view-conceal-symbolic",
    actionIds: ["close"],
    testID: `private-tab-${t.id}`,
  }));

  return (
    <window
      title="Private Browsing"
      testID="private-window"
      defaultWidth={WINDOW_WIDTH}
      defaultHeight={WINDOW_HEIGHT}
      onClosed={onClose}
      onSizeChanged={(e) => setWidth((e.data as { width: number }).width)}
    >
      <splitview sidebarWidth={0.24} testID="private-split">
        {/* Compact drops this pane here for the same reason the main window
            does: the content pane stays the splitview's second child, so no
            webview moves and no page reloads. */}
        {!compact && (
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
                nodes={nodes}
                actions={TAB_ACTIONS}
                selectedId={active.id}
                indentationPerLevel={0}
                style={{ vexpand: true }}
                onSelectionChanged={(e) => {
                  const { nodeId } = e.data as { nodeId: string | null };
                  if (nodeId) setActiveId(nodeId);
                }}
                onActionClicked={(e) => {
                  const { nodeId, actionId } = e.data as { nodeId: string; actionId: string };
                  if (actionId === "close") closeTab(nodeId);
                }}
              />
            </box>
          </toolbarview>
        )}

        <toolbarview slot="content" testID="private-content-toolbar">
          <headerbar
            testID="private-chrome"
            title=""
            canGoBack={active.canGoBack}
            canGoForward={active.canGoForward}
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
            {compact && (
              <CompactTabs
                tabs={runTabs}
                activeId={active.id}
                metrics={tabRunMetrics(width, runTabs, active.id, 0, Platform.backend === "gtk" ? "gtk" : "appkit")}
                prefix="private-"
                // A private window shows no favicons: the cache is on disk and
                // this window writes nothing there.
                iconFor={() => undefined}
                labelFor={(t) => t.title || (t.url ? displayUrl(t.url) : "New Tab")}
                addressFor={(t) => displayUrl(t.url) || "New Tab"}
                onSelect={setActiveId}
                onClose={closeTab}
                dragPayload={(t) => tabPayload({ profile: "private", tabId: t.id, url: t.url })}
                dropIndex={dropIndex}
                onDragOverIndex={setDropIndex}
                onDropAt={onDropAt}
                onDragStart={() => {}}
                onDragEnd={() => setDropIndex(null)}
              />
            )}
            {compact && (
              <button
                slot="start"
                testID="private-header-new-tab"
                iconName="list-add-symbolic"
                tooltip="New Tab"
                cssClasses={["flat"]}
                onClick={() => openTab()}
              />
            )}

            {/* The private window's site-info button: it answers permission
                requests and says what this window will not do, which is
                remember any of them. */}
            <box testID="private-site-info-anchor" orientation="horizontal">
              <button
                testID="private-site-info"
                iconName="web-browser-symbolic"
                tooltip="Site Information"
                cssClasses={["flat"]}
                onClick={() => setSiteInfoOpen(!siteInfoOpen)}
              />
              <popover
                testID="private-site-info-popover"
                open={siteInfoOpen}
                position="bottom"
                onClosed={() => {
                  setSiteInfoOpen(false);
                  denyPromptsFor(active.id);
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
                    text={hostOf(active.url) || "New Tab"}
                    cssClasses={["heading"]}
                    style={{ halign: "start" }}
                  />
                  {activePrompt ? (
                    <box orientation="vertical" spacing={Spacing.sm}>
                      <label
                        testID="private-permission-request"
                        text={permissionSentence(hostOf(active.url) || activePrompt.origin, activePrompt.types)}
                        style={{ halign: "start" }}
                      />
                      <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
                        <button
                          testID="private-permission-block"
                          label="Block"
                          onClick={() => answerPrompt(activePrompt, false)}
                        />
                        <button
                          testID="private-permission-allow"
                          label="Allow"
                          cssClasses={["suggested-action"]}
                          onClick={() => answerPrompt(activePrompt, true)}
                        />
                      </box>
                    </box>
                  ) : (
                    <label
                      testID="private-site-permissions-note"
                      text="Choices you make here are forgotten when this window closes."
                      cssClasses={["dimmed"]}
                      style={{ halign: "start" }}
                    />
                  )}
                </box>
              </popover>
            </box>
            {/* Packed straight into the header bar, not boxed: the host
                promotes a search entry there to the title widget with
                hexpand, which is what gives it the row's whole free run. */}
            <searchinput
              ref={(node) => {
                omnibox.current = node as NdNodeRef<"searchinput"> | null;
              }}
              testID="private-omnibox"
              text={displayUrl(active.url)}
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
                  const node = omnibox.current;
                  if (node) sendCommand(node, "focus");
                }}
              />
              <menuitem testID="private-menu-find" label="Find in Page" onSelect={() => setFindOpen(true)} />
              <menuitem role="separator" testID="private-menu-sep-move" />
              <menuitem
                testID="private-menu-move-left"
                label="Move Tab Left"
                enabled={tabs.indexOf(active) > 0}
                onSelect={() => moveTab(active.id, tabs.indexOf(active) - 1)}
              />
              <menuitem
                testID="private-menu-move-right"
                label="Move Tab Right"
                enabled={tabs.indexOf(active) < tabs.length - 1}
                onSelect={() => moveTab(active.id, tabs.indexOf(active) + 1)}
              />
              {moveTargets.length > 0 && (
                <menu label="Move Tab to Window" testID="private-menu-move-to">
                  {moveTargets.map((t) => (
                    <menuitem
                      key={t.id}
                      testID={`private-menu-move-to-${t.id}`}
                      label={t.label}
                      enabled={active.url !== ""}
                      onSelect={() => moveOut(t.id)}
                    />
                  ))}
                </menu>
              )}
              <menuitem role="separator" testID="private-menu-sep" />
              <menuitem testID="private-menu-downloads" label="Downloads" onSelect={onDownloads} />
              <menuitem testID="private-menu-settings" label="Settings" onSelect={onSettings} />
            </menubutton>
          </headerbar>

          <box testID="private-content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
            {/* The marker. A private window that looks like an ordinary one is
                the failure mode this banner exists to prevent. GNOME HIG
                *Banners*: one short title, no lengthy explanation, so it states
                the fact and the status page below carries the detail. */}
            <banner testID="private-banner" title="Private browsing. This window keeps no history." revealed />

            {/* The find bar floats over the page here for the same reason it
                does in the main window: see the comment on the main window's
                find anchor for why it has to be a popover on Linux. */}
            <overlay testID="private-page-stack" style={{ hexpand: true, vexpand: true }}>
              <box orientation="vertical" style={{ hexpand: true, vexpand: true }}>
                {/* In id order, not tab order: a reorder must never move a
                    live view within its parent, only the tab list. */}
                {[...tabs]
                  .filter((t) => t.url !== "")
                  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
                  .map((t) => (
                    <Activity key={t.id} mode={t.id === active.id ? "visible" : "hidden"}>
                      <webview
                        ref={(node) => {
                          views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                        }}
                        url={t.url}
                        profile={PRIVATE_PROFILE}
                        testID={`private-page-${t.id}`}
                        style={{ hexpand: true, vexpand: true }}
                        onNavigate={(e) => patch(t.id, { url: e.text })}
                        onTitleChanged={(e) => patch(t.id, { title: e.text })}
                        onLoadingChanged={(e) => patch(t.id, { loading: e.checked })}
                        onBackAvailable={(e) => patch(t.id, { canGoBack: e.checked })}
                        onForwardAvailable={(e) => patch(t.id, { canGoForward: e.checked })}
                        onNewWindow={(e) => {
                      const target = e.text.trim();
                      if (target && target !== "about:blank") openTab(target);
                    }}
                    onPermissionRequest={(e) => onPermissionRequest(t.id, e.data)}
                        onBrowserCommand={(e) => {
                          // The page's own Chrome shortcuts, for the ones this
                          // window has an answer to. A new private window is
                          // this one, which is already open.
                          if (e.text === "newTab") openTab();
                          if (e.text === "closeTab") closeTab(t.id);
                          const node = views.current.get(t.id);
                          if (e.text === "print" && node) void executeJavaScript(node, "window.print()").catch(() => {});
                        }}
                        {...downloadHandlers(() => views.current.get(t.id) ?? null)}
                      />
                    </Activity>
                  ))}

                {active.url === "" && (
                  <statuspage
                    testID="private-new-tab-page"
                    iconName="view-conceal-symbolic"
                    title="Private Browsing"
                    description="Cookies, cache and history are discarded when you close this window. Anything you download is still saved."
                    style={{ vexpand: true }}
                  />
                )}
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
                {findOpen && (
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
                )}
              </box>
            </overlay>
          </box>
        </toolbarview>
      </splitview>
    </window>
  );
}
