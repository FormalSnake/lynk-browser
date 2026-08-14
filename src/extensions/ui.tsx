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

/// The install prompt. Shown before anything of the extension runs, and the
/// only thing that can enable it.
export function ExtensionPermissionPrompt({ host }: HostProps): React.ReactNode {
  const { prompt } = useExtensionState(host);
  if (!prompt) return null;
  return (
    <window title="Add extension" testID="ext-prompt-window" defaultWidth={460} defaultHeight={360}>
      <toolbarview testID="ext-prompt-toolbar">
        <headerbar testID="ext-prompt-header" title="Add extension" showTitleButtons={false} />
        <box
          testID="ext-prompt"
          orientation="vertical"
          spacing={Spacing.md}
          style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}
        >
          <box orientation="horizontal" spacing={Spacing.md}>
            {prompt.iconPath !== null && <image testID="ext-prompt-icon" path={prompt.iconPath} />}
            <box orientation="vertical" spacing={Spacing.xs} style={{ hexpand: true }}>
              <label testID="ext-prompt-name" text={`Add ${prompt.name}?`} cssClasses={["title-4"]} />
              <label testID="ext-prompt-version" text={`Version ${prompt.version}`} cssClasses={["caption", "dimmed"]} />
            </box>
          </box>

          <label
            testID="ext-prompt-lead"
            text={prompt.warnings.length > 0 ? "It will be able to:" : "It asks for no special access."}
            style={{ halign: "start" }}
          />
          <box testID="ext-prompt-warnings" orientation="vertical" spacing={Spacing.sm} style={{ vexpand: true }}>
            {prompt.warnings.map((warning, index) => (
              <box key={warning} orientation="horizontal" spacing={Spacing.sm}>
                <image iconName="dialog-warning-symbolic" />
                <label testID={`ext-prompt-warning-${index}`} text={warning} style={{ halign: "start", hexpand: true }} />
              </box>
            ))}
          </box>

          <box orientation="horizontal" spacing={Spacing.sm} style={{ halign: "end" }}>
            <button testID="ext-prompt-cancel" label="Cancel" onClick={() => void host.resolvePrompt(false)} />
            <button
              testID="ext-prompt-add"
              label="Add extension"
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

/// The extensions manager: what is installed, whether it runs, and how to add
/// more.
export function ExtensionsManagerWindow({ host, actions }: HostProps & { actions: ManagerActions }): React.ReactNode {
  const { views, managerOpen } = useExtensionState(host);
  if (!managerOpen) return null;
  return (
    <window
      title="Extensions"
      testID="ext-manager-window"
      defaultWidth={620}
      defaultHeight={520}
      onClosed={() => host.setManagerOpen(false)}
    >
      <toolbarview testID="ext-manager-toolbar">
        <headerbar testID="ext-manager-header" title="Extensions">
          <button
            slot="end"
            testID="ext-install-file"
            label="Add from file"
            iconName="folder-open-symbolic"
            onClick={actions.installFromFile}
          />
          <button
            slot="end"
            testID="ext-install-store"
            label="Add from the store"
            iconName="system-search-symbolic"
            onClick={actions.installFromStore}
          />
        </headerbar>
        <scrollview testID="ext-manager-scroll" style={{ hexpand: true, vexpand: true }}>
          <clamp maximumSize={720}>
            <box orientation="vertical" spacing={Spacing.lg} style={{ padding: Spacing.lg, hexpand: true }}>
              {views.length === 0 ? (
                <statuspage
                  testID="ext-manager-empty"
                  iconName="application-x-addon-symbolic"
                  title="No extensions yet"
                  description="Add a folder, a .zip or a .crx, or paste a Chrome Web Store address."
                  style={{ vexpand: true }}
                >
                  <button
                    testID="ext-manager-empty-add"
                    label="Add from file"
                    cssClasses={["suggested-action", "pill"]}
                    onClick={actions.installFromFile}
                  />
                </statuspage>
              ) : (
                <settingsgroup testID="ext-manager-list" title="Installed">
                  {views.map((view) => (
                    <row
                      key={view.id}
                      testID={`ext-row-${view.id}`}
                      title={view.name}
                      subtitle={`${view.version} — ${view.enabled ? "on" : "off"}`}
                      iconName="application-x-addon-symbolic"
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
                        onClick={() => void host.uninstall(view.id)}
                      />
                    </row>
                  ))}
                </settingsgroup>
              )}

              <settingsgroup testID="ext-manager-add" title="Add an extension">
                <row
                  testID="ext-manager-add-folder"
                  title="Load an unpacked folder"
                  subtitle="Pick a folder that contains a manifest.json"
                  iconName="folder-symbolic"
                  activatable
                  onActivate={actions.installFromFolder}
                />
                <row
                  testID="ext-manager-add-file"
                  title="Install from a file"
                  subtitle="A packed .crx or a .zip"
                  iconName="package-x-generic-symbolic"
                  activatable
                  onActivate={actions.installFromFile}
                />
                <row
                  testID="ext-manager-add-store"
                  title="Install from the Chrome Web Store"
                  subtitle="Paste the address of a store listing"
                  iconName="system-search-symbolic"
                  activatable
                  onActivate={actions.installFromStore}
                />
              </settingsgroup>
            </box>
          </clamp>
        </scrollview>
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
    <window title="Add from the Chrome Web Store" testID="ext-store-window" defaultWidth={520} defaultHeight={200}>
      <toolbarview testID="ext-store-toolbar">
        <headerbar testID="ext-store-header" title="Add from the Chrome Web Store" showTitleButtons={false} />
        <box
          testID="ext-store"
          orientation="vertical"
          spacing={Spacing.md}
          style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}
        >
          <label text="Store address" style={{ halign: "start" }} />
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
            label={shortLabel(view.name)}
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
