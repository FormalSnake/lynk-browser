// A private window is a second top-level window whose webviews all share ONE
// ephemeral network session: the framework treats a `profile` name beginning
// with "private" as a partition that never touches disk, so cookies, cache and
// storage die with the window.
//
// It is deliberately plainer than the main window. Nothing here writes to the
// session store or the history database, and nothing here mounts an extension
// surface, because both would defeat the point. That means no command palette
// (its ranking reads history) and no downloads list; the address field IS the
// address bar, which is also the only place in the app that exercises
// `<searchinput>` on GTK.
import { Spacing, sendCommand, setContextMenuItems, useRef, useState } from "@nativedesktop/react";
import type {
  ContextMenuItemClick,
  NdNodeRef,
  SourceTreeAction,
  SourceTreeNode,
} from "@nativedesktop/react";
import { Activity } from "react";

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

/// What a private window cannot own itself. Settings, the extensions manager
/// and the downloads list are one per app and live in the main window, so the
/// private window's menu routes to them rather than growing copies.
export interface PrivateWindowProps {
  onClose: () => void;
  onSettings: () => void;
  onExtensions: () => void;
  onDownloads: () => void;
  onDownload: (url: string, suggested?: string) => void;
}

export function PrivateWindow({
  onClose,
  onSettings,
  onExtensions,
  onDownloads,
  onDownload,
}: PrivateWindowProps): React.ReactNode {
  const [tabs, setTabs] = useState<PrivateTab[]>([blankTab("p1")]);
  const [activeId, setActiveId] = useState("p1");
  const [findOpen, setFindOpen] = useState(false);
  const next = useRef(2);
  const views = useRef(new Map<string, NdNodeRef<"webview"> | null>());
  /// Views whose context-menu items have been pushed. An inline ref callback
  /// runs on every render, and the items here never change.
  const menuedViews = useRef(new Set<number>());

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  function patch(id: string, part: Partial<PrivateTab>): void {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...part } : t)));
  }

  function openTab(url = ""): void {
    const id = `p${next.current++}`;
    setTabs((list) => [...list, { ...blankTab(id), url }]);
    setActiveId(id);
  }

  function closeTab(id: string): void {
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
    caption: hostOf(t.url) || undefined,
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
          <box
            testID="private-sidebar"
            orientation="vertical"
            spacing={Spacing.xs}
            style={{ vexpand: true, padding: Spacing.xs }}
          >
            <button
              testID="private-new-tab"
              label="New Tab"
              iconName="tab-new-symbolic"
              labelAlign="start"
              cssClasses={["flat"]}
              onClick={() => openTab()}
            />
            <sourcetree
              testID="private-tab-list"
              nodes={nodes}
              actions={TAB_ACTIONS}
              selectedId={active.id}
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
                Settings, Extensions, Find and Downloads have no route from
                here. The three that are one per app open in the main window;
                Find is this window's own. */}
            <menubutton slot="end" testID="private-menu" iconName="open-menu-symbolic">
              <menuitem testID="private-menu-new-tab" label="New Tab" onSelect={() => openTab()} />
              <menuitem testID="private-menu-find" label="Find in Page" onSelect={() => setFindOpen(true)} />
              <menuitem role="separator" testID="private-menu-sep" />
              <menuitem testID="private-menu-downloads" label="Downloads" onSelect={onDownloads} />
              <menuitem testID="private-menu-extensions" label="Manage Extensions" onSelect={onExtensions} />
              <menuitem testID="private-menu-settings" label="Settings" onSelect={onSettings} />
            </menubutton>
          </headerbar>

          <box testID="private-content" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
            {/* The marker. A private window that looks like an ordinary one is
                the failure mode this banner exists to prevent. GNOME HIG
                *Banners*: one short title, no lengthy explanation — the status
                page below carries what this window actually does. */}
            <banner testID="private-banner" title="Private browsing: this window saves no history" revealed />

            {findOpen && (
              <box
                testID="private-find-bar"
                orientation="horizontal"
                spacing={Spacing.sm}
                style={{ padding: Spacing.sm, hexpand: true }}
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
            )}

            {tabs
              .filter((t) => t.url !== "")
              .map((t) => (
                <Activity key={t.id} mode={t.id === active.id ? "visible" : "hidden"}>
                  <webview
                    ref={(node) => {
                      views.current.set(t.id, node as NdNodeRef<"webview"> | null);
                      if (!node || menuedViews.current.has(node.id)) return;
                      menuedViews.current.add(node.id);
                      // No extensions run in a private window, so this is the
                      // whole menu the app adds to the engine's own.
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
                description="This window keeps no history, cookies or cache. Anything you download is still saved."
                style={{ vexpand: true }}
              />
            )}
          </box>
        </toolbarview>
      </splitview>
    </window>
  );
}
