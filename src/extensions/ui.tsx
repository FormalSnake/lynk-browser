// Native surfaces for extensions: the hidden background views, the action
// popup window, the install permission prompt, and the manager. All native
// widgets — the only web content anywhere here is the extension's own popup
// page inside a <webview>.
import { Activity } from "react";

import {
  Spacing,
  onJavaScriptResult,
  useRef,
  useState,
  useSyncExternalStore,
  type NdNodeRef,
} from "@nativedesktop/react";
import { SERVICE_WORKER_PATH, extensionUrl, type ExtensionHost, type ExtensionView, type InstallPrompt } from "./host.ts";
import { hostWarning } from "./permissions.ts";

interface HostProps {
  host: ExtensionHost;
}

/// One reactive read of everything the extension UI renders from. The host is
/// a plain object outside React, so this is the subscription that keeps the
/// tree honest without an effect.
export function useExtensionState(host: ExtensionHost): {
  views: ExtensionView[];
  prompt: InstallPrompt | null;
  popup: ReturnType<ExtensionHost["popupState"]>;
  managerOpen: boolean;
} {
  const snapshot = useSyncExternalStore(
    (onChange) => host.subscribe(onChange),
    () => host.revision,
  );
  void snapshot;
  return {
    views: host.views(),
    prompt: host.pendingPrompt(),
    popup: host.popupState(),
    managerOpen: host.isManagerOpen(),
  };
}

/// A <webview> that is armed before it navigates. User scripts registered
/// after a load has started miss document_start, so the URL is withheld for
/// one render while the shim and content scripts go in.
function ExtensionWebView({
  host,
  kind,
  extensionId,
  url,
  testID,
  hideOnceArmed = false,
}: HostProps & {
  kind: "background" | "popup";
  extensionId: string;
  url: string;
  testID: string;
  hideOnceArmed?: boolean;
}): React.ReactNode {
  const [armed, setArmed] = useState(false);
  // The scheme handler answers on the view that asked, taken from here rather
  // than from a lookup: a request can arrive while the host's own map is being
  // rebuilt, and an unanswered request leaves the page loading forever.
  const self = useRef<NdNodeRef<"webview"> | null>(null);

  const view = (
    <webview
      url={armed ? url : ""}
      testID={testID}
      style={{ hexpand: true, vexpand: true }}
      // Attach only. The host drops its handle when the app retires the surface
      // (disable, uninstall, popup close); a ref cleanup would also fire on
      // every re-render whose callback identity changed.
      ref={(node) => {
        if (!node) return;
        self.current = node as NdNodeRef<"webview">;
        host.armExtensionView(kind, extensionId, node as NdNodeRef<"webview">);
        setArmed(true);
      }}
      onScriptMessage={(e) => {
        const message = e.data as { body: unknown };
        host.handleScriptMessage({ kind, extensionId }, message.body);
      }}
      onSchemeRequest={(e) => {
        if (self.current) host.serveScheme(self.current, e.data as { id: string; url: string });
      }}
      onJavaScriptResult={onJavaScriptResult}
      onLoadFailed={(e) => {
        const failure = e.data as { url: string; error: string };
        console.error(`[nativebrowser] ${extensionId} ${kind} failed to load ${failure.url}: ${failure.error}`);
      }}
    />
  );

  // The first frame is deliberately visible and blank: React does not attach
  // refs inside a subtree that mounts straight into a hidden Activity, and
  // without a ref the app can never talk to the page. Arming flips it hidden
  // and sets the URL in the same commit, so nothing of the page is ever shown.
  if (!hideOnceArmed) return view;
  return <Activity mode={armed ? "hidden" : "visible"}>{view}</Activity>;
}

/// Every enabled extension's background page: an MV2 background page or the
/// wrapper that hosts an MV3 service worker. Both run for the life of the
/// window and are never shown — Activity hides the widget while WebKit keeps
/// the page alive, the same primitive that keeps a background tab loaded.
export function ExtensionBackgrounds({ host }: HostProps): React.ReactNode {
  const { views } = useExtensionState(host);
  return (
    <box testID="ext-backgrounds" orientation="vertical">
      {views
        .filter((view) => view.enabled)
        .map((view) => {
          const ext = host.extensions.get(view.id);
          const page = ext?.manifest.backgroundPage ?? (ext?.manifest.serviceWorker ? SERVICE_WORKER_PATH : null);
          if (!ext || !page) return null;
          return (
            <ExtensionWebView
              key={view.id}
              host={host}
              kind="background"
              extensionId={view.id}
              url={extensionUrl(view.id, page)}
              testID={`ext-background-${view.id}`}
              hideOnceArmed
            />
          );
        })}
    </box>
  );
}

/// The action popup: its own small window, closed when it loses focus, the way
/// a browser popup behaves.
export function ExtensionPopupWindow({ host }: HostProps): React.ReactNode {
  const { popup } = useExtensionState(host);
  if (!popup) return null;
  const view = host.views().find((v) => v.id === popup.extensionId);
  return (
    <window
      title={view?.title ?? "Extension"}
      testID="ext-popup-window"
      defaultWidth={popup.width}
      defaultHeight={popup.height}
      onClosed={() => host.closePopup()}
    >
      <box testID="ext-popup" orientation="vertical" style={{ hexpand: true, vexpand: true }}>
        <ExtensionWebView
          host={host}
          kind="popup"
          extensionId={popup.extensionId}
          url={popup.url}
          testID={`ext-popup-view-${popup.extensionId}`}
        />
      </box>
    </window>
  );
}

/// What `symbolScale="small"` resolves to. The minor permission rows carry no
/// icon, so this is the indent that keeps them under the same leading edge as
/// the row that does.
const WARNING_ICON_PX = 16;

/// The one warning that covers host access, recomputed from the manifest the
/// host already adopted. `permissionWarnings` folds every host pattern into a
/// single sentence, so matching against it is what separates the consequential
/// row from the rest without parsing prose.
function broadAccessWarning(host: ExtensionHost, extensionId: string): string | null {
  const manifest = host.extensions.get(extensionId)?.manifest;
  return manifest ? hostWarning(manifest.hostPermissions) : null;
}

/// `defaultWidth`/`defaultHeight` are create-only and there is no resize
/// command, so the prompt's height is decided before it mounts. The budget is
/// the fixed chrome (header bar, padding, identity block, lead-in, buttons)
/// plus one line per permission sentence.
function promptHeight(warnings: number): number {
  return Math.min(640, Math.max(280, 240 + 32 * warnings));
}

/// The install prompt. Shown before anything of the extension runs, and the
/// only thing that can enable it.
export function ExtensionPermissionPrompt({ host }: HostProps): React.ReactNode {
  const { prompt } = useExtensionState(host);
  if (!prompt) return null;
  const broad = broadAccessWarning(host, prompt.id);
  return (
    <window
      title="Add Extension"
      testID="ext-prompt-window"
      defaultWidth={460}
      defaultHeight={promptHeight(prompt.warnings.length)}
    >
      <toolbarview testID="ext-prompt-toolbar">
        <headerbar testID="ext-prompt-header" title="Permissions" showTitleButtons={false} />
        <box
          testID="ext-prompt"
          orientation="vertical"
          spacing={Spacing.md}
          style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}
        >
          {/* Everything the user reads hangs off one column: the icon is the
              only thing to the left of it, so the name, the version, the
              provenance, the lead-in and every permission sentence share a
              leading edge. */}
          <box orientation="horizontal" spacing={Spacing.md}>
            {prompt.iconPath !== null && (
              // The identity element of a consent decision: Firefox draws it at
              // 32, Chrome at 48.
              <image testID="ext-prompt-icon" path={prompt.iconPath} pixelSize={32} style={{ valign: "start" }} />
            )}
            <box orientation="vertical" spacing={Spacing.md} style={{ hexpand: true }}>
              <box orientation="vertical" spacing={Spacing.xs}>
                <label
                  testID="ext-prompt-name"
                  text={`Add ${prompt.name}?`}
                  cssClasses={["title-4"]}
                  style={{ halign: "start" }}
                />
                <label
                  testID="ext-prompt-version"
                  text={`Version ${prompt.version}`}
                  cssClasses={["caption", "dimmed"]}
                  style={{ halign: "start" }}
                />
                {/* Two unpacked copies of the same extension are identical but
                    for where they came from, so the folder is identity here.
                    Ellipsized: a long path must not widen the dialog. */}
                <label
                  testID="ext-prompt-source"
                  text={prompt.root}
                  cssClasses={["caption", "dimmed", "monospace"]}
                  ellipsize
                  style={{ halign: "start" }}
                />
              </box>

              <label
                testID="ext-prompt-lead"
                text={
                  prompt.warnings.length > 0
                    ? `${prompt.name} will be able to:`
                    : `${prompt.name} asks for no special access.`
                }
                style={{ halign: "start" }}
              />
              <box testID="ext-prompt-warnings" orientation="vertical" spacing={Spacing.sm}>
                {prompt.warnings.map((warning, index) => (
                  <box key={warning} orientation="horizontal" spacing={Spacing.sm}>
                    {/* Only broad host access earns the triangle. The others
                        are indented past the icon column so the sentences stay
                        on one leading edge. */}
                    {warning === broad ? (
                      <image
                        iconName="dialog-warning-symbolic"
                        symbolScale="small"
                        cssClasses={["warning"]}
                        style={{ valign: "start" }}
                      />
                    ) : null}
                    <label
                      testID={`ext-prompt-warning-${index}`}
                      text={warning}
                      style={{
                        halign: "start",
                        hexpand: true,
                        margin: warning === broad ? undefined : { left: WARNING_ICON_PX + Spacing.sm },
                      }}
                    />
                  </box>
                ))}
              </box>
            </box>
          </box>

          <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end", vexpand: true, valign: "end" }}>
            <button testID="ext-prompt-cancel" label="Cancel" onClick={() => void host.resolvePrompt(false)} />
            <button
              testID="ext-prompt-add"
              label="Add Extension"
              cssClasses={["suggested-action"]}
              onClick={() => void host.resolvePrompt(true)}
            />
          </box>
        </box>
      </toolbarview>
    </window>
  );
}

export interface ManagerActions {
  installFromFile: () => void;
  installFromFolder: () => void;
  installFromStore: () => void;
}

/// One entry per way in, so the header bar, the placeholder and the list cannot
/// drift into different verbs or different glyphs for the same action. The
/// header carries the label as a tooltip: three full labels do not fit a
/// header bar, and shortening them there is how the four verbs got in.
const ADD_ACTIONS: {
  testID: string;
  headerTestID: string;
  label: string;
  subtitle: string;
  iconName: string;
  run: (actions: ManagerActions) => void;
}[] = [
  {
    testID: "ext-manager-add-store",
    headerTestID: "ext-install-store",
    label: "Add From the Chrome Web Store",
    subtitle: "Paste the address of a store listing",
    iconName: "system-software-install-symbolic",
    run: (actions) => actions.installFromStore(),
  },
  {
    testID: "ext-manager-add-folder",
    headerTestID: "ext-install-folder",
    label: "Add From a Folder",
    subtitle: "Pick a folder that contains a manifest.json",
    iconName: "folder-symbolic",
    run: (actions) => actions.installFromFolder(),
  },
  {
    testID: "ext-manager-add-file",
    headerTestID: "ext-install-file",
    label: "Add From a File",
    subtitle: "A packed .crx or a .zip",
    iconName: "package-x-generic-symbolic",
    run: (actions) => actions.installFromFile(),
  },
];

/// The extensions manager: what is installed, whether it runs, and how to add
/// more.
export function ExtensionsManagerWindow({ host, actions }: HostProps & { actions: ManagerActions }): React.ReactNode {
  const { views, managerOpen } = useExtensionState(host);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!managerOpen) return null;

  const close = (): void => {
    setDetailId(null);
    setRemoving(null);
    host.setManagerOpen(false);
  };

  return (
    <>
      <window title="Extensions" testID="ext-manager-window" defaultWidth={620} defaultHeight={520} onClosed={close}>
        <toolbarview testID="ext-manager-toolbar">
          <headerbar testID="ext-manager-header" title="Extensions">
            {ADD_ACTIONS.map((action) => (
              <button
                key={action.headerTestID}
                slot="start"
                testID={action.headerTestID}
                iconName={action.iconName}
                tooltip={action.label}
                onClick={() => action.run(actions)}
              />
            ))}
          </headerbar>
          {/* A GtkScrolledWindow allocates its child the child's MINIMUM height
              and scrolls from there, so anything that can shrink below its
              natural size is clipped in here rather than scrolled. An
              AdwStatusPage can (it scrolls internally), which is why the
              placeholder sits beside the scroller and gets the whole window.
              The boxed lists cannot: their rows have a real minimum, so the
              viewport is forced past the window height and a scrollbar
              appears. */}
          <box orientation="vertical" style={{ hexpand: true, vexpand: true }}>
            {views.length === 0 ? (
              <statuspage
                testID="ext-manager-empty"
                iconName="application-x-addon-symbolic"
                title="No Extensions Yet"
                description="Extensions add features to your browser."
                style={{ vexpand: true }}
              >
                {ADD_ACTIONS.map((action, index) => (
                  <button
                    key={action.testID}
                    testID={action.testID}
                    label={action.label}
                    iconName={action.iconName}
                    cssClasses={index === 0 ? ["suggested-action", "pill"] : ["pill"]}
                    onClick={() => action.run(actions)}
                  />
                ))}
              </statuspage>
            ) : (
              <scrollview
                testID="ext-manager-scroll"
                hscroll="never"
                style={{ hexpand: true, vexpand: true }}
              >
                <clamp maximumSize={720}>
                  <box orientation="vertical" spacing={Spacing.lg} style={{ padding: Spacing.lg, hexpand: true }}>
                    <settingsgroup testID="ext-manager-list" title="Installed">
                      {views.map((view) => (
                        <row
                          key={view.id}
                          testID={`ext-row-${view.id}`}
                          title={view.name}
                          subtitle={view.version}
                          // One extension, one picture: the same bytes the
                          // prompt showed and the toolbar button shows.
                          iconData={view.iconData}
                          iconName="application-x-addon-symbolic"
                          // Empty rather than absent: cssClasses reconciles
                          // against what it is sent, and a missing prop leaves
                          // the class on when the extension is switched back on.
                          cssClasses={view.enabled ? [] : ["dimmed"]}
                          activatable
                          onActivate={() => setDetailId(view.id)}
                        >
                          <switch
                            slot="suffix"
                            testID={`ext-toggle-${view.id}`}
                            checked={view.enabled}
                            onToggled={(e) => void host.setExtensionEnabled(view.id, e.checked)}
                          />
                          <button
                            slot="suffix"
                            testID={`ext-remove-${view.id}`}
                            iconName="user-trash-symbolic"
                            tooltip={`Remove ${view.name}`}
                            cssClasses={["flat"]}
                            onClick={() => setRemoving(view.id)}
                          />
                        </row>
                      ))}
                    </settingsgroup>

                    <settingsgroup testID="ext-manager-add" title="Add an Extension">
                      {ADD_ACTIONS.map((action) => (
                        <row
                          key={action.testID}
                          testID={action.testID}
                          title={action.label}
                          subtitle={action.subtitle}
                          iconName={action.iconName}
                          activatable
                          onActivate={() => action.run(actions)}
                        />
                      ))}
                    </settingsgroup>
                  </box>
                </clamp>
              </scrollview>
            )}
          </box>
        </toolbarview>
      </window>

      <ExtensionDetailWindow
        host={host}
        view={views.find((view) => view.id === detailId) ?? null}
        onClose={() => setDetailId(null)}
        onRemove={setRemoving}
      />
      <RemoveExtensionDialog
        host={host}
        view={views.find((view) => view.id === removing) ?? null}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          setDetailId(null);
        }}
      />
    </>
  );
}

/// Height for the detail window, decided before it mounts: `defaultHeight` is
/// create-only and there is no resize command. The fixed groups plus one
/// 54px boxed-list row per granted permission, capped so a greedy manifest
/// asks for a scroll rather than a screen-tall window.
function detailHeight(permissions: number): number {
  return Math.min(700, 440 + 54 * permissions);
}

/// One extension's own page: what it was granted and the two controls that can
/// take it back. Reached by activating its row, which is otherwise the only
/// place a grant is visible after the install prompt is gone.
///
/// The permissions are read-only. The host grants and revokes the whole set
/// together (`resolvePrompt` writes `granted` in one go), so removing the
/// extension is the only revoke there is.
function ExtensionDetailWindow({
  host,
  view,
  onClose,
  onRemove,
}: HostProps & {
  view: ExtensionView | null;
  onClose: () => void;
  onRemove: (id: string) => void;
}): React.ReactNode {
  if (!view) return null;
  const broad = broadAccessWarning(host, view.id);
  const root = host.extensions.get(view.id)?.root ?? "";
  return (
    <window
      title={view.name}
      testID="ext-detail-window"
      defaultWidth={520}
      defaultHeight={detailHeight(view.warnings.length)}
      onClosed={onClose}
    >
      <toolbarview testID="ext-detail-toolbar">
        <headerbar testID="ext-detail-header" title={view.name} subtitle={`Version ${view.version}`} />
        <scrollview testID="ext-detail-scroll" hscroll="never" style={{ hexpand: true, vexpand: true }}>
          <clamp maximumSize={560}>
            <box orientation="vertical" spacing={Spacing.lg} style={{ padding: Spacing.lg, hexpand: true }}>
              <settingsgroup testID="ext-detail-state">
                <switchrow
                  testID={`ext-detail-toggle-${view.id}`}
                  title="Enabled"
                  subtitle="Run this extension on the pages it asked for"
                  checked={view.enabled}
                  onToggled={(e) => void host.setExtensionEnabled(view.id, e.checked)}
                />
              </settingsgroup>

              <settingsgroup
                testID="ext-detail-permissions"
                title="Permissions"
                description={
                  view.warnings.length > 0
                    ? "Granted when you added it. Removing the extension is the only way to take them back."
                    : `${view.name} asks for no special access.`
                }
              >
                {view.warnings.map((warning, index) => (
                  <row
                    key={warning}
                    testID={`ext-detail-permission-${index}`}
                    title={warning}
                    iconName={warning === broad ? "dialog-warning-symbolic" : "security-medium-symbolic"}
                  />
                ))}
              </settingsgroup>

              <settingsgroup testID="ext-detail-about" title="Details">
                <row testID="ext-detail-folder" title="Folder" subtitle={root} />
                <row testID="ext-detail-id" title="Identifier" subtitle={view.id} />
              </settingsgroup>

              <button
                testID="ext-detail-remove"
                label="Remove Extension"
                cssClasses={["destructive-action", "pill"]}
                style={{ halign: "center" }}
                onClick={() => onRemove(view.id)}
              />
            </box>
          </clamp>
        </scrollview>
      </toolbarview>
    </window>
  );
}

/// Removal is irreversible and `uninstall` drops the extension's chrome.storage
/// rows with it, so it asks first.
function RemoveExtensionDialog({
  host,
  view,
  onClose,
  onRemoved,
}: HostProps & { view: ExtensionView | null; onClose: () => void; onRemoved: () => void }): React.ReactNode {
  if (!view) return null;
  return (
    <window title="Remove Extension" testID="ext-confirm-window" defaultWidth={460} defaultHeight={210} onClosed={onClose}>
      <toolbarview testID="ext-confirm-toolbar">
        <headerbar testID="ext-confirm-header" title="Remove Extension" showTitleButtons={false} />
        <box
          testID="ext-confirm"
          orientation="vertical"
          spacing={Spacing.md}
          style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}
        >
          <label
            testID="ext-confirm-title"
            text={`Remove ${view.name}?`}
            cssClasses={["title-4"]}
            style={{ halign: "start" }}
          />
          <label
            testID="ext-confirm-body"
            text="This also deletes its settings and stored data."
            style={{ halign: "start" }}
          />
          <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end", vexpand: true, valign: "end" }}>
            <button testID="ext-confirm-cancel" label="Cancel" onClick={onClose} />
            <button
              testID="ext-confirm-remove"
              label="Remove Extension"
              cssClasses={["destructive-action"]}
              onClick={() => {
                void host.uninstall(view.id);
                onRemoved();
              }}
            />
          </box>
        </box>
      </toolbarview>
    </window>
  );
}

/// Install straight from a Chrome Web Store listing. The address is all the
/// store's CRX endpoint needs; the download and the permission prompt are the
/// same flow a local file goes through.
export function ExtensionStoreDialog({
  host,
  open,
  onClose,
  onFailure,
}: HostProps & { open: boolean; onClose: () => void; onFailure: (reason: string) => void }): React.ReactNode {
  const [address, setAddress] = useState("");
  if (!open) return null;

  const submit = (): void => {
    onClose();
    void host.stageFromWebStore(address).catch((error: Error) => onFailure(error.message));
    setAddress("");
  };

  return (
    <window title="Add From the Chrome Web Store" testID="ext-store-window" defaultWidth={520} defaultHeight={200}>
      <toolbarview testID="ext-store-toolbar">
        <headerbar testID="ext-store-header" title="Add From the Chrome Web Store" showTitleButtons={false} />
        <box
          testID="ext-store"
          orientation="vertical"
          spacing={Spacing.md}
          style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}
        >
          <label text="Store Address" style={{ halign: "start" }} />
          {/* Deliberately uncontrolled: feeding `text` back from onChanged
              makes GTK's set_text race the entry and blank it (LEDGER). */}
          <textinput
            testID="ext-store-input"
            placeholder="https://chromewebstore.google.com/detail/…"
            onChanged={(e) => setAddress(e.text)}
            onActivate={submit}
          />
          <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end", vexpand: true, valign: "end" }}>
            <button testID="ext-store-cancel" label="Cancel" onClick={onClose} />
            <button testID="ext-store-add" label="Continue" cssClasses={["suggested-action"]} onClick={submit} />
          </box>
        </box>
      </toolbarview>
    </window>
  );
}

/// The toolbar buttons, one per enabled extension. GTK buttons take an icon
/// theme name rather than image bytes, so the extension's own PNG cannot be
/// the button's icon yet (LEDGER: framework asks); the name carries the
/// identity instead.
export function ExtensionActionButtons({ host }: HostProps): React.ReactNode {
  const { views } = useExtensionState(host);
  return (
    <>
      {views
        .filter((view) => view.enabled)
        .map((view) => (
          <button
            key={view.id}
            slot="end"
            testID={`ext-action-${view.id}`}
            // The extension's own icon, which is what every browser shows here
            // and what makes this read as a control rather than a label.
            // Initials remain the fallback for an extension that ships none.
            iconData={view.iconData}
            label={view.iconData ? "" : shortLabel(view.name)}
            badge={view.badge || undefined}
            tooltip={view.title}
            cssClasses={["flat"]}
            onClick={() => host.openAction(view.id)}
          />
        ))}
    </>
  );
}

/// Initials, so a row of extension buttons stays a row rather than a sentence.
function shortLabel(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2);
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
