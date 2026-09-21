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
import { Spacing, sendCommand, setContextMenuItems, useRef, useState } from "@nativedesktop/react";
import type {
  ContextMenuItemClick,
  NdNodeRef,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";
import { Activity } from "react";

import { FIND_BAR_WIDTH } from "./lib/metrics.ts";
import { permissionSentence, splitTypes, type PermissionPrompt } from "./lib/permissions.ts";
import { displayUrl, hostOf, toUrl } from "./lib/url.ts";

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

/// What a private window cannot own itself. Settings and the downloads list
/// are one per app and live in the main window, so the private window's menu
/// routes to them rather than growing copies.
export interface PrivateWindowProps {
  onClose: () => void;
  onSettings: () => void;
  onDownloads: () => void;
  onDownload: (url: string, suggested?: string) => void;
}

export function PrivateWindow({
  onClose,
  onSettings,
  onDownloads,
  onDownload,
}: PrivateWindowProps): React.ReactNode {
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
  /// Views whose context-menu items have been pushed. An inline ref callback
  /// runs on every render, and the items here never change.
  const menuedViews = useRef(new Set<number>());

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const activePrompt = prompts.find((p) => p.tabId === active.id) ?? null;

  function patch(id: string, part: Partial<PrivateTab>): void {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...part } : t)));
  }

  function openTab(url = ""): void {
    const id = `p${next.current++}`;
    setTabs((list) => [...list, { ...blankTab(id), url }]);
    setActiveId(id);
  }

  function closeTab(id: string): void {
    denyPromptsFor(id);
    views.current.delete(id);
    setTabs((list) => {
      const rest = list.filter((t) => t.id !== id);
      if (rest.length === 0) {
        const fresh = `p${next.current++}`;
        setActiveId(fresh);
        return [blankTab(fresh)];
      }
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
    const target = toUrl(raw);
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
      defaultWidth={1100}
      defaultHeight={720}
      onClosed={onClose}
    >
      <splitview sidebarWidth={0.24} testID="private-split">
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

        <toolbarview slot="content" testID="private-content-toolbar">
          <headerbar
            testID="private-chrome"
            title=""
            canGoBack={active.canGoBack}
            canGoForward={active.canGoForward}
            onBack={() => command("goBack")}
            onForward={() => command("goForward")}
          >
            {/* The private window's site-info button: it answers permission
                requests and says what this window will not do, which is
                remember any of them. */}
            <box slot="start" testID="private-site-info-anchor" orientation="horizontal">
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
            <button
              slot="start"
              testID="private-reload"
              iconName="view-refresh-symbolic"
              tooltip="Reload"
              cssClasses={["flat"]}
              onClick={() => command("reload")}
            />
            <searchinput
              slot="start"
              testID="private-omnibox"
              text={displayUrl(active.url)}
              placeholder="Search or Enter Address"
              style={{ hexpand: true }}
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
              <menuitem testID="private-menu-find" label="Find in Page" onSelect={() => setFindOpen(true)} />
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
                {tabs
                  .filter((t) => t.url !== "")
                  .map((t) => (
                    <Activity key={t.id} mode={t.id === active.id ? "visible" : "hidden"}>
                      <webview
                        ref={(node) => {
                          views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                          if (!node || menuedViews.current.has(node.id)) return;
                          menuedViews.current.add(node.id);
                          // The whole menu the app adds to the engine's own.
                          setContextMenuItems(node as NdNodeRef<"webview">, [
                            { id: "nb-open-link", label: "Open Link in New Tab", contexts: ["link"] },
                            { id: "nb-save-image", label: "Save Image", contexts: ["image"] },
                          ]);
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
                        onNewWindow={(e) => openTab(e.text)}
                    onPermissionRequest={(e) => onPermissionRequest(t.id, e.data)}
                        onContextMenuItemClicked={(e) => {
                          const click = e.data as ContextMenuItemClick;
                          if (click.id === "nb-open-link" && click.linkUrl) openTab(click.linkUrl);
                          if (click.id === "nb-save-image" && click.imageUrl) onDownload(click.imageUrl);
                        }}
                        onDownloadRequested={(e) => {
                          // Private browsing hides the trail, it does not refuse
                          // the file: what you download is still saved, and it
                          // lands in the one downloads list the app has.
                          const d = e.data as { url: string; suggestedFilename?: string };
                          onDownload(d.url, d.suggestedFilename);
                        }}
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
