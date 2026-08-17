// The broker. Every privileged extension API lands here, in the Bun process:
// the engine knows nothing about Chrome extensions, so content scripts, the
// background page and the popup all talk to this module over script messages
// and get answered by world-scoped JavaScript evaluation.
//
// The app owns the widgets, so it hands the broker three things: the current
// tab list, a <webview> handle per surface, and the raw events (scriptMessage,
// schemeRequest). Everything else is decided here.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  executeJavaScript,
  notifications,
  sendCommand,
  type ContextMenuItem,
  type ContextMenuItemClick,
  type NdNodeRef,
} from "@nativedesktop/react";

import {
  bootstrapSource,
  bridgeHandler,
  contentScriptWrapper,
  contentStyleWrapper,
  type ContextKind,
} from "./bootstrap.ts";
import { extractZip, idFromPath, isCrx, parseCrx } from "./crx.ts";
import { loadMessages, parseManifest, pickIcon, type ExtensionManifest } from "./manifest.ts";
import { ContextMenuRegistry, parseFrameworkId, type MenuProps } from "./context-menus.ts";
import { compileMatcher, toWebKitPatterns, type CompiledMatcher } from "./match-patterns.ts";
import { permissionWarnings } from "./permissions.ts";
import {
  clearArea,
  deleteKeys,
  extensionsDir,
  listInstalled,
  openRegistry,
  readArea,
  removeInstalled,
  setEnabled,
  upsertInstalled,
  writeArea,
  type StorageArea,
} from "./registry.ts";
import {
  CHROME_VERSION,
  WEBSTORE_HANDLER,
  WEBSTORE_MATCH,
  WEBSTORE_SURFACE,
  chromeUserAgent,
  isWebstoreUrl,
  parseWebstoreInstall,
  webstoreHookSource,
} from "./webstore.ts";
import type { Messages } from "./i18n.ts";

type WebViewRef = NdNodeRef<"webview">;

export interface AppTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface LoadedExtension {
  id: string;
  root: string;
  enabled: boolean;
  granted: string[];
  manifest: ExtensionManifest;
  messages: Messages;
  /** Per-group compiled patterns, index-aligned with `manifest.contentScripts`. */
  matchers: CompiledMatcher[];
}

/** What the manager and the headerbar render. */
export interface ExtensionView {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  iconPath: string | null;
  /** The same icon as a `data:` URL, for `<button iconData>` / `<row iconData>`,
   * which take bytes rather than a path. */
  iconData: string | undefined;
  title: string;
  badge: string;
  hasPopup: boolean;
  warnings: string[];
}

export interface InstallPrompt {
  id: string;
  name: string;
  version: string;
  root: string;
  iconPath: string | null;
  warnings: string[];
  permissions: string[];
  /** `install` is the pre-enable consent gate; `permissions` is an already
   * installed extension asking for more through `chrome.permissions.request`.
   * Same dialog, different verb and a different set of consequences. */
  kind: "install" | "permissions";
}

export interface PopupState {
  extensionId: string;
  url: string;
  width: number;
  height: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".xml": "text/xml",
  ".wasm": "application/wasm",
};

/// Chrome ships a font list from the OS; nothing here enumerates fonts, and
/// the only caller in practice is a settings dropdown.
const FONT_LIST = [
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Noto Sans",
].map((name) => ({ fontId: name, displayName: name }));

/// How long a tab waits for extension background pages before loading anyway.
/// 8s is the product answer: long enough for a real extension to boot, short
/// enough that a broken one does not hold the browser hostage. A loaded CI box
/// is slower than any user's machine, so the drives raise it rather than race
/// it (`NB_BACKGROUND_READY_MS`).
const BACKGROUND_READY_TIMEOUT_MS = Number(process.env.NB_BACKGROUND_READY_MS ?? 8000);


const POPUP_DEFAULT = { width: 380, height: 600 };
const POPUP_MIN = 25;
const POPUP_MAX = { width: 800, height: 600 };

/** Where a script message came from, as the app knows it. */
type Surface =
  | { kind: "content"; tabId: string; extensionId: string }
  | { kind: "background"; extensionId: string }
  | { kind: "popup"; extensionId: string };

interface FrameRef {
  surface: Surface;
  frameId: number;
  documentId: string;
  url: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PortLink {
  id: string;
  from: string;
  to: string | null;
  name: string;
}

export interface ActionState {
  title: string;
  badge: string;
  iconPath: string | null;
}

export function extensionUrl(id: string, path = "/"): string {
  return `chrome-extension://${id}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ExtensionHost {
  readonly extensions = new Map<string, LoadedExtension>();

  private tabs: AppTab[] = [];
  private tabNumbers = new Map<string, number>();
  private nextTabNumber = 1;

  private tabViews = new Map<string, WebViewRef>();
  private backgroundViews = new Map<string, WebViewRef>();
  private popupViews = new Map<string, WebViewRef>();
  /** Surface key -> the node id its user scripts were installed on. */
  private armed = new Map<string, number>();
  /** Tab id -> the node id currently carrying the store's Chrome user agent. */
  private storeUserAgent = new Map<string, number>();
  /** Tab id -> the node id the store install hook is installed on. */
  private storeHooked = new Map<string, number>();
  /** Every frame that has said hello, keyed by the token it generated. */
  private frames = new Map<string, FrameRef>();
  private frameCounters = new Map<string, number>();

  private pending = new Map<string, PendingCall>();
  private ports = new Map<string, PortLink>();
  private alarms = new Map<string, { timer: ReturnType<typeof setTimeout>; scheduled: number; periodInMinutes?: number }>();
  private actions = new Map<string, ActionState>();
  private menus = new ContextMenuRegistry();
  private popupSizes = new Map<string, { width: number; height: number }>();
  private sessionStorage = new Map<string, Record<string, unknown>>();
  /** Extensions added in this session, so onInstalled reports "install" once. */
  private freshInstalls = new Set<string>();
  /** Messages waiting for a background page that has not finished loading. */
  private queuedForBackground = new Map<string, Record<string, unknown>[]>();
  /** Background pages whose document has finished loading, listeners and all. */
  private backgroundLoaded = new Set<string>();
  /** Background pages that have also run out of their own startup work. */
  private backgroundIdle = new Set<string>();
  /** Set once the wait for background pages has been given up on. */
  private backgroundDeadlinePassed = false;

  private popup: PopupState | null = null;
  private prompt: InstallPrompt | null = null;
  /// Settled by `resolvePrompt` when the pending prompt is a permission
  /// request, so `chrome.permissions.request` can await the user.
  private permissionResolve: ((granted: boolean) => void) | null = null;
  private managerOpen = false;
  private listeners = new Set<() => void>();
  private seq = 0;

  // ---------------------------------------------------------------- lifecycle

  async load(): Promise<void> {
    await openRegistry();
    for (const record of await listInstalled()) {
      if (!existsSync(resolve(record.root, "manifest.json"))) continue;
      try {
        this.adopt(record.id, record.root, record.enabled, record.granted);
      } catch (error) {
        console.error(`[nativebrowser] extension ${record.id} failed to load: ${(error as Error).message}`);
      }
    }
  }

  private adopt(id: string, root: string, enabled: boolean, granted: string[]): LoadedExtension {
    const manifest = parseManifest(root, uiLocale());
    const loaded: LoadedExtension = {
      id,
      root,
      enabled,
      granted,
      manifest,
      messages: loadMessages(root, manifest.defaultLocale, uiLocale()),
      matchers: manifest.contentScripts.map((group) => compileMatcher(group.matches, group.excludeMatches)),
    };
    this.extensions.set(id, loaded);
    if (!this.actions.has(id)) {
      this.actions.set(id, {
        title: manifest.action?.defaultTitle ?? manifest.name,
        badge: "",
        iconPath: this.iconPath(loaded, 48),
      });
    }
    return loaded;
  }

  private iconPath(ext: LoadedExtension, size: number): string | null {
    const relative = pickIcon(ext.manifest.action?.defaultIcon ?? {}, size) ?? pickIcon(ext.manifest.icons, size);
    if (!relative) return null;
    const path = this.resolveInside(ext.root, relative);
    return path && existsSync(path) ? path : null;
  }

  /** Bumped on every state change, so React can subscribe without an effect. */
  revision = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  /// Whether every enabled extension's background page is up AND has finished
  /// starting itself.
  ///
  /// Tabs hold their navigation until this is true, because a content script
  /// that connects before the background page can answer gets one reply — the
  /// wrong one — and never asks again. Chrome guarantees this ordering by
  /// construction; here it has to be arranged. The deadline keeps a broken
  /// extension from holding the browser hostage.
  backgroundsReady(): boolean {
    if (this.backgroundDeadlinePassed) return true;
    const waiting = this.enabledExtensions().filter(
      (ext) =>
        (ext.manifest.backgroundPage !== null || ext.manifest.serviceWorker !== null) &&
        !(this.backgroundLoaded.has(ext.id) && this.backgroundIdle.has(ext.id)),
    );
    // Every background page reported in, so the deadline has nothing left to
    // rescue. Cancelling it matters for more than tidiness: an armed timer
    // fires its "did not load in time" line on a completely healthy run, and
    // that line is the first thing anyone debugging this reaches for.
    if (waiting.length === 0) {
      if (this.backgroundDeadline) {
        clearTimeout(this.backgroundDeadline);
        this.backgroundDeadline = null;
      }
      return true;
    }
    if (!this.backgroundDeadline) {
      const late = waiting.map((ext) => ext.id).join(", ");
      this.backgroundDeadline = setTimeout(() => {
        this.backgroundDeadline = null;
        this.backgroundDeadlinePassed = true;
        console.error(
          `[nativebrowser] ${late} did not finish starting after ${BACKGROUND_READY_TIMEOUT_MS}ms; ` +
            "tabs are proceeding without it",
        );
        this.notify();
      }, BACKGROUND_READY_TIMEOUT_MS);
    }
    return false;
  }

  private backgroundDeadline: ReturnType<typeof setTimeout> | null = null;

  viewFor(kind: "background" | "popup", extensionId: string): WebViewRef | null {
    return (kind === "background" ? this.backgroundViews : this.popupViews).get(extensionId) ?? null;
  }

  tabViewFor(tabId: string): WebViewRef | null {
    return this.tabViews.get(tabId) ?? null;
  }

  // ------------------------------------------------------------------ install

  /// Reads whatever the user picked — a folder, a .zip or a .crx — into the
  /// app's own extensions directory and returns it as a pending prompt. The
  /// extension is not enabled until `resolvePrompt(true)`.
  async stage(path: string): Promise<InstallPrompt> {
    const source = resolve(path);
    if (!existsSync(source)) throw new Error("that file no longer exists");

    let root = source;
    let id: string;

    if (statSync(source).isFile()) {
      const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
      // A bare .zip carries no key, so it falls back to the path rule that
      // unpacked folders use: same file in, same id out.
      const archive = isCrx(bytes) ? parseCrx(bytes) : { zip: bytes, id: null, version: 0 };
      id = archive.id ?? idFromPath(source);
      root = resolve(extensionsDir(), id);
      rmSync(root, { recursive: true, force: true });
      await extractZip(archive.zip, root);
      // Some packages nest everything under a single top folder.
      if (!existsSync(resolve(root, "manifest.json"))) {
        const inner = unwrapSingleFolder(root);
        if (inner) root = inner;
      }
    } else {
      id = idFromPath(source);
    }

    const manifest = parseManifest(root, uiLocale());
    const already = this.extensions.get(id);
    const staged = this.adopt(id, root, already?.enabled ?? false, already?.granted ?? []);
    const prompt: InstallPrompt = {
      id,
      name: manifest.name,
      version: manifest.version,
      root,
      iconPath: this.iconPath(staged, 48),
      warnings: permissionWarnings(manifest.permissions, manifest.hostPermissions),
      permissions: [...manifest.permissions, ...manifest.hostPermissions],
      kind: "install",
    };
    this.prompt = prompt;
    this.notify();
    return prompt;
  }

  /// `chrome.permissions.request`. Only permissions the manifest declared as
  /// optional can be asked for, which is Chrome's rule and the thing that stops
  /// an extension escalating to anything it likes after install. Resolves false
  /// if a prompt is already up: two consent dialogs at once is how a user says
  /// yes to the wrong one.
  requestPermissions(extensionId: string, wanted: string[]): Promise<boolean> {
    const ext = this.extensions.get(extensionId);
    if (!ext || this.prompt) return Promise.resolve(false);
    const allowed = new Set([...ext.manifest.optionalPermissions, ...ext.manifest.hostPermissions]);
    const asking = wanted.filter((p) => !ext.granted.includes(p));
    if (asking.length === 0) return Promise.resolve(true);
    if (asking.some((p) => !allowed.has(p))) return Promise.resolve(false);

    const hosts = asking.filter((p) => p === "<all_urls>" || p.includes("://"));
    const plain = asking.filter((p) => !hosts.includes(p));
    this.prompt = {
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      root: ext.root,
      iconPath: this.iconPath(ext, 48),
      warnings: permissionWarnings(plain, hosts),
      permissions: asking,
      kind: "permissions",
    };
    this.notify();
    return new Promise<boolean>((resolve) => {
      this.permissionResolve = resolve;
    });
  }

  /// The Chrome Web Store's CRX endpoint. Downloading is the app's job; the
  /// staging path above does the rest.
  async stageFromWebStore(input: string): Promise<InstallPrompt> {
    const id = webStoreId(input);
    if (!id) throw new Error("that is not a Chrome Web Store address");
    const endpoint =
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CHROME_VERSION}.0&acceptformat=crx3` +
      `&x=${encodeURIComponent(`id=${id}&uc`)}`;
    const response = await fetch(endpoint, { redirect: "follow" });
    if (!response.ok) throw new Error(`the store answered ${response.status}`);
    const file = resolve(extensionsDir(), `${id}.crx`);
    await Bun.write(file, response);
    return this.stage(file);
  }

  pendingPrompt(): InstallPrompt | null {
    return this.prompt;
  }

  /// Resolves the install prompt. Only `true` writes a registry row, which is
  /// what makes the grant explicit and survivable across restarts.
  async resolvePrompt(granted: boolean): Promise<void> {
    const prompt = this.prompt;
    this.prompt = null;
    if (!prompt) return;
    const ext = this.extensions.get(prompt.id);

    if (prompt.kind === "permissions") {
      const answer = this.permissionResolve;
      this.permissionResolve = null;
      if (granted && ext) {
        ext.granted = [...new Set([...ext.granted, ...prompt.permissions])];
        this.reinstallContentScripts();
        await upsertInstalled({
          id: ext.id,
          root: ext.root,
          enabled: ext.enabled,
          granted: ext.granted,
          installedAt: Date.now(),
        });
      }
      this.notify();
      if (answer) answer(granted && ext !== undefined);
      return;
    }

    if (!granted || !ext) {
      // Cancelling drops a first-time install; a re-install of something
      // already in the registry keeps whatever the user granted before.
      if (!granted && !ext?.enabled) this.extensions.delete(prompt.id);
      this.notify();
      return;
    }
    ext.granted = prompt.permissions;
    ext.enabled = true;
    this.freshInstalls.add(ext.id);
    this.reinstallContentScripts();
    await upsertInstalled({
      id: ext.id,
      root: ext.root,
      enabled: true,
      granted: ext.granted,
      installedAt: Date.now(),
    });
    this.notify();
  }

  async setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
    const ext = this.extensions.get(id);
    if (!ext) return;
    ext.enabled = enabled;
    if (!enabled) this.forgetExtensionRuntime(id);
    this.reinstallContentScripts();
    await setEnabled(id, enabled);
    this.notify();
  }

  async uninstall(id: string): Promise<void> {
    this.forgetExtensionRuntime(id);
    this.extensions.delete(id);
    this.actions.delete(id);
    this.reinstallContentScripts();
    await removeInstalled(id);
    this.notify();
  }

  /// Rewrites the user-script registry of every live tab. Chrome does not
  /// retrofit an already-loaded page either — this only decides what the tab's
  /// NEXT load injects.
  private reinstallContentScripts(): void {
    for (const [tabId, node] of this.tabViews) {
      // `clearUserScripts` takes the whole view, store hook included, so a tab
      // that had one has to be re-hooked rather than skipped by the guard.
      sendCommand(node, "clearUserScripts");
      if (this.storeHooked.delete(tabId)) this.installWebstoreHook(tabId, node);
      for (const ext of this.enabledExtensions()) this.installContentScripts(ext, node);
    }
  }

  private forgetExtensionRuntime(id: string): void {
    if (this.popup?.extensionId === id) this.popup = null;
    this.backgroundViews.delete(id);
    this.popupViews.delete(id);
    this.armed.delete(`background:${id}`);
    this.armed.delete(`popup:${id}`);
    this.backgroundLoaded.delete(id);
    this.backgroundIdle.delete(id);
    this.queuedForBackground.delete(id);
    this.forgetFrames((surface) => surface.extensionId === id);
    for (const [name, alarm] of this.alarms) {
      if (name.startsWith(`${id} `)) {
        clearTimeout(alarm.timer);
        this.alarms.delete(name);
      }
    }
    this.menus.forget(id);
  }

  // --------------------------------------------------------------------- view

  enabledExtensions(): LoadedExtension[] {
    return [...this.extensions.values()].filter((e) => e.enabled);
  }

  views(): ExtensionView[] {
    return [...this.extensions.values()].map((ext) => {
      const action = this.actions.get(ext.id);
      return {
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        description: ext.manifest.description,
        enabled: ext.enabled,
        iconPath: action?.iconPath ?? this.iconPath(ext, 48),
        // Toolbar buttons and manager rows take image BYTES; only `<image>`
        // reads a path. Same picture either way.
        iconData: iconDataUrl(action?.iconPath ?? this.iconPath(ext, 32)),
        title: action?.title ?? ext.manifest.name,
        badge: action?.badge ?? "",
        hasPopup: ext.manifest.action?.defaultPopup != null,
        warnings: permissionWarnings(ext.manifest.permissions, ext.manifest.hostPermissions),
      };
    });
  }

  popupState(): PopupState | null {
    return this.popup;
  }

  isManagerOpen(): boolean {
    return this.managerOpen;
  }

  setManagerOpen(open: boolean): void {
    this.managerOpen = open;
    this.notify();
  }

  /// Flat list for the menubar's Extensions menu. A menubar has no hit test,
  /// so it shows every registered item that has a label.
  extensionMenuItems(): { extensionId: string; id: string; title: string }[] {
    const out: { extensionId: string; id: string; title: string }[] = [];
    for (const extensionId of this.menus.extensionIds()) {
      for (const entry of this.menus.entries(extensionId)) {
        if (entry.type === "separator" || !entry.visible || !entry.title) continue;
        out.push({ extensionId, id: entry.id, title: entry.title });
      }
    }
    return out;
  }

  /// The page context menu an extension contributes to ONE tab: its items,
  /// filtered by `documentUrlPatterns` against that tab's URL and shaped for
  /// the framework's `setContextMenuItems`.
  contextMenuItemsFor(tabId: string): ContextMenuItem[] {
    const tab = this.tabs.find((t) => t.id === tabId);
    return this.menus.itemsForPage(
      this.enabledExtensions().map((e) => ({ id: e.id, name: e.manifest.name })),
      tab?.url ?? "",
    );
  }

  // --------------------------------------------------------------------- tabs

  setTabs(tabs: AppTab[]): void {
    const previous = new Map(this.tabs.map((t) => [t.id, t]));
    this.tabs = tabs;
    for (const tab of tabs) {
      if (!this.tabNumbers.has(tab.id)) this.tabNumbers.set(tab.id, this.nextTabNumber++);
      const before = previous.get(tab.id);
      if (!before) continue;
      const changes: Record<string, unknown> = {};
      if (before.url !== tab.url) changes.url = tab.url;
      if (before.title !== tab.title) changes.title = tab.title;
      if (Object.keys(changes).length > 0) {
        this.broadcastEvent("tabs.onUpdated", [this.tabNumber(tab.id), changes, this.tabInfo(tab)]);
      }
      if (!before.active && tab.active) {
        this.broadcastEvent("tabs.onActivated", [{ tabId: this.tabNumber(tab.id), windowId: 1 }]);
      }
    }
    for (const id of previous.keys()) {
      if (tabs.some((t) => t.id === id)) continue;
      this.broadcastEvent("tabs.onRemoved", [this.tabNumber(id), { windowId: 1, isWindowClosing: false }]);
      this.tabViews.delete(id);
      this.storeUserAgent.delete(id);
      this.storeHooked.delete(id);
      for (const [token, frame] of this.frames) {
        if (frame.surface.kind === "content" && frame.surface.tabId === id) this.frames.delete(token);
      }
    }
  }

  /// Emitted from the app's own navigation events, which is the only place a
  /// commit is actually observed.
  notifyNavigated(tabId: string, url: string): void {
    this.applyStoreUserAgent(tabId, url);
    const details = { tabId: this.tabNumber(tabId), frameId: 0, url, timeStamp: Date.now() };
    this.broadcastEvent("webNavigation.onCommitted", [details]);
    this.broadcastEvent("webNavigation.onCompleted", [details]);
  }

  private tabNumber(tabId: string): number {
    let number = this.tabNumbers.get(tabId);
    if (number === undefined) {
      number = this.nextTabNumber++;
      this.tabNumbers.set(tabId, number);
    }
    return number;
  }

  private tabById(number: number): AppTab | null {
    for (const tab of this.tabs) {
      if (this.tabNumber(tab.id) === number) return tab;
    }
    return null;
  }

  private tabInfo(tab: AppTab): Record<string, unknown> {
    return {
      id: this.tabNumber(tab.id),
      index: this.tabs.indexOf(tab),
      windowId: 1,
      active: tab.active,
      highlighted: tab.active,
      pinned: false,
      incognito: false,
      url: tab.url,
      title: tab.title,
      status: "complete",
      audible: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    };
  }

  // ------------------------------------------------------------------- store

  /// The store's own install button, hooked in a world of its own. It is not an
  /// extension, so it borrows the same allow-list machinery a content script
  /// uses and is pinned to the one origin: no other site is ever handed this.
  ///
  /// Installed the first time a tab REACHES the store, never while arming.
  /// Arming already races the extension background pages' boot (a tab that
  /// gives up waiting loads with no content scripts at all), and two more
  /// widget commands per tab on that path was enough to lose it: the MV3
  /// restore leg went red every run, and green again the moment this moved.
  /// Nothing is lost by waiting, because entering the store reloads the tab to
  /// correct the user agent anyway, and the hook is a document_start script on
  /// that reload.
  private installWebstoreHook(tabId: string, node: WebViewRef): void {
    if (this.storeHooked.get(tabId) === node.id) return;
    this.storeHooked.set(tabId, node.id);
    const world = contentWorld(WEBSTORE_SURFACE);
    sendCommand(node, "registerScriptMessage", { name: WEBSTORE_HANDLER, world });
    sendCommand(node, "addUserScript", {
      id: "nd-webstore",
      source: webstoreHookSource(),
      injectionTime: "start",
      world,
      allowList: [WEBSTORE_MATCH],
    });
  }

  /// `setUserAgent` is per VIEW, not per navigation, so a Chrome user agent
  /// left in place would follow the user out of the store and misrepresent this
  /// browser to every other site in the tab. It is therefore flipped on when a
  /// tab enters the store origin and off the moment it leaves, which keeps the
  /// engine's own user agent as what every other origin sees.
  ///
  /// The cost of doing it here: a navigation is reported after the engine has
  /// already asked for the document, so the listing that triggers the flip was
  /// fetched under the old user agent and is reloaded once. That cannot loop:
  /// it fires on the transition only, and the view is already flipped by the
  /// time the reload commits. Leaving the store does NOT reload: that page is
  /// one request that went out as Chrome, and a second full load to correct a
  /// header nothing acted on is the worse trade.
  private applyStoreUserAgent(tabId: string, url: string): void {
    const node = this.tabViews.get(tabId);
    if (!node) return;
    const wanted = isWebstoreUrl(url);
    if (wanted === (this.storeUserAgent.get(tabId) === node.id)) return;
    if (!wanted) {
      this.storeUserAgent.delete(tabId);
      sendCommand(node, "setUserAgent", "");
      return;
    }
    this.storeUserAgent.set(tabId, node.id);
    this.installWebstoreHook(tabId, node);
    sendCommand(node, "setUserAgent", chromeUserAgent());
    sendCommand(node, "reload");
  }

  /// A click on the store's install button, arriving from the hook. Everything
  /// after this is the ordinary install: the same download and the same consent
  /// prompt the store dialog raises.
  private onWebstoreMessage(body: unknown): void {
    const message = parseWebstoreInstall(body);
    if (!message) return;
    void this.stageFromWebStore(message.id).catch((error: Error) => {
      console.error(
        `[nativebrowser] ${message.name || message.id} could not be fetched from the store: ${error.message}`,
      );
    });
  }

  // -------------------------------------------------------------- attachments

  /// Installs the shim and every matching content script into a tab's webview.
  /// Must run before the view navigates: user scripts registered after a load
  /// has begun miss document_start. Returns false when this exact widget was
  /// already armed, which is what keeps React's ref churn from reinstalling
  /// half a megabyte of content script on every render.
  armTabView(tabId: string, node: WebViewRef): boolean {
    this.tabViews.set(tabId, node);
    if (this.armed.get(`tab:${tabId}`) === node.id) return false;
    this.armed.set(`tab:${tabId}`, node.id);
    sendCommand(node, "clearUserScripts");
    this.storeHooked.delete(tabId);
    const enabled = this.enabledExtensions();
    for (const ext of enabled) this.installContentScripts(ext, node);
    if (process.env.NB_TEST_HOOKS === "1") {
      console.error(`ND_APP armTabView tab=${tabId} node=${node.id} extensions=${enabled.map((e) => e.id).join(",")}`);
    }
    return true;
  }

  /// The `chrome.*` shim, installed the same way on all three surfaces. They
  /// differ in exactly two things, so those are the parameters and everything
  /// else is shared: a content script runs in the extension's isolated world
  /// and has subframes to reach, while a background or popup page IS the
  /// extension and is one frame.
  private installBootstrap(ext: LoadedExtension, kind: ContextKind, node: WebViewRef): void {
    const world = kind === "content" ? contentWorld(ext.id) : undefined;
    sendCommand(node, "registerScriptMessage", { name: bridgeHandler(ext.id), world });
    sendCommand(node, "addUserScript", {
      id: `nd-boot-${ext.id}`,
      source: this.bootstrapFor(ext, kind),
      injectionTime: "start",
      world,
      allFrames: kind === "content",
    });
  }

  private installContentScripts(ext: LoadedExtension, node: WebViewRef): void {
    const world = contentWorld(ext.id);
    this.installBootstrap(ext, "content", node);

    ext.manifest.contentScripts.forEach((group, index) => {
      const matcher = ext.matchers[index]!;
      const allowList = toWebKitPatterns(group.matches);
      const blockList = toWebKitPatterns(group.excludeMatches);
      const shared = {
        injectionTime: group.runAt === "document_start" ? "start" : "end",
        world: group.world === "MAIN" ? undefined : world,
        allFrames: group.allFrames,
        // match_about_blank frames have no URL WebKit can filter on, so the
        // native list has to stay open and the JS guard does the deciding.
        allowList: group.matchAboutBlank ? undefined : allowList,
        blockList: blockList.length > 0 ? blockList : undefined,
      };

      group.css.forEach((file, at) => {
        const css = this.readResource(ext, file);
        if (css === null) return;
        sendCommand(node, "addUserScript", {
          ...shared,
          id: `nd-css-${ext.id}-${index}-${at}`,
          source: contentScriptWrapper(
            contentStyleWrapper(css),
            matcher.matches,
            matcher.excludes,
            group.matchAboutBlank,
            false,
          ),
          world,
        });
      });

      group.js.forEach((file, at) => {
        const source = this.readResource(ext, file);
        if (source === null) {
          console.error(`[nativebrowser] ${ext.manifest.name}: content script ${file} is missing`);
          return;
        }
        sendCommand(node, "addUserScript", {
          ...shared,
          id: `nd-cs-${ext.id}-${index}-${at}`,
          source: contentScriptWrapper(
            source,
            matcher.matches,
            matcher.excludes,
            group.matchAboutBlank,
            group.runAt === "document_idle",
          ),
        });
      });
    });
  }

  /// Background and popup views run extension code in their own page world, so
  /// the shim goes in unguarded and the bridge is registered for that world.
  armExtensionView(kind: Exclude<ContextKind, "content">, extensionId: string, node: WebViewRef): void {
    const ext = this.extensions.get(extensionId);
    if (!ext) return;
    if (kind === "background") this.backgroundViews.set(extensionId, node);
    else this.popupViews.set(extensionId, node);
    const key = `${kind}:${extensionId}`;
    // React re-runs a ref callback whenever its identity changes, so the same
    // widget arriving twice must not reinstall anything or forget its frames.
    if (this.armed.get(key) === node.id) return;
    this.armed.set(key, node.id);
    if (kind === "background") {
      this.backgroundLoaded.delete(extensionId);
      this.backgroundIdle.delete(extensionId);
    }
    this.forgetFrames((surface) => surface.kind === kind && surface.extensionId === extensionId);

    this.installBootstrap(ext, kind, node);
    if (process.env.NB_TEST_HOOKS === "1") {
      console.error(`ND_APP armExtensionView kind=${kind} ext=${extensionId} node=${node.id}`);
    }
    if (kind === "popup") {
      sendCommand(node, "addUserScript", {
        id: "nd-popup-size",
        source: popupSizeReporter(extensionId),
        injectionTime: "end",
      });
    }
  }

  /// Only forgets the handle. The frame registry survives, because React hands
  /// the same widget back on the very next commit whenever a ref callback's
  /// identity changed — a page that never reloaded must keep its frames.
  detachExtensionView(kind: "background" | "popup", extensionId: string): void {
    if (kind === "background") this.backgroundViews.delete(extensionId);
    else this.popupViews.delete(extensionId);
  }

  private forgetFrames(match: (surface: Surface) => boolean): void {
    for (const [token, frame] of this.frames) {
      if (match(frame.surface)) this.frames.delete(token);
    }
  }

  private bootstrapFor(ext: LoadedExtension, kind: ContextKind): string {
    return bootstrapSource({
      extensionId: ext.id,
      kind,
      baseUrl: `chrome-extension://${ext.id}`,
      manifest: ext.manifest.raw,
      messages: catalogFor(ext),
      uiLocale: uiLocale(),
      commands: ext.manifest.commands.map((c) => ({
        name: c.name,
        description: ext.messages.has(stripMessageRef(c.description))
          ? ext.messages.get(stripMessageRef(c.description))
          : c.description,
        shortcut: c.suggestedKey ?? "",
      })),
      granted: ext.granted,
    });
  }

  // ------------------------------------------------------------------ scheme

  /// Answers a `chrome-extension://` request. Path traversal is refused before
  /// any read, and a request for an unknown extension fails rather than
  /// falling through to the filesystem.
  serveScheme(node: WebViewRef, request: { id: string; url: string }): void {
    const fail = (message: string): void => {
      sendCommand(node, "respondScheme", { id: request.id, error: message });
    };

    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return fail("malformed extension URL");
    }
    const ext = this.extensions.get(parsed.hostname);
    if (!ext) return fail(`no extension ${parsed.hostname}`);

    const path = decodeURIComponent(parsed.pathname);

    // MV3 has no page to load a service worker from, so one is synthesized at a
    // reserved path. It is not on disk and must be answered before the
    // filesystem lookup.
    if (path === SERVICE_WORKER_PATH) {
      const worker = ext.manifest.serviceWorker;
      if (!worker) return fail("this extension has no service worker");
      sendCommand(node, "respondScheme", {
        id: request.id,
        status: 200,
        mime: "text/html",
        // Deliberately NO Content-Security-Policy. This page is the framework's
        // own scaffolding, not the extension's: it bootstraps the
        // service-worker globals from an inline block before importing the
        // extension's real script. Serving the manifest's policy here kills
        // that block and the background page never reports loaded, which
        // reaches the user as a restored tab that comes back unthemed
        // (measured: the whole MV3 restore leg goes red). Chrome has no
        // equivalent document, so there is nothing to be consistent with.
        headers: { "Cache-Control": "no-cache" },
        base64: Buffer.from(serviceWorkerPage(worker), "utf8").toString("base64"),
      });
      return;
    }

    const file = this.resolveInside(ext.root, path === "/" ? "/index.html" : path);
    if (!file) return fail("path escapes the extension");
    if (!existsSync(file) || statSync(file).isDirectory()) {
      sendCommand(node, "respondScheme", {
        id: request.id,
        status: 404,
        mime: "text/plain",
        base64: btoa(`no such extension resource: ${path}`),
      });
      return;
    }

    const bytes = readFileSync(file);
    const mime = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    sendCommand(node, "respondScheme", {
      id: request.id,
      status: 200,
      mime,
      headers: this.resourceHeaders(ext, path),
      base64: bytes.toString("base64"),
    });
  }

  /// A resource the manifest lists as web-accessible is the only one a page on
  /// another origin may read, which is what the CORS header says. `no-cache`
  /// is what makes editing an unpacked extension and reloading show the edit.
  ///
  /// The manifest's `content_security_policy` is NOT served, and this is the
  /// reason: the `chrome.*` shim reaches an extension page as an injected user
  /// script, and WebKitGTK applies the page's CSP to injected scripts where
  /// Chrome exempts its own. Serving `script-src 'self'` therefore disables the
  /// runtime on exactly the pages the policy governs. Measured on both
  /// fixtures: MV2's background page stops loading, and MV3's restored tab
  /// comes back unthemed because its service worker never boots. Enforcing it
  /// needs the shim delivered over a channel CSP does not govern, which is a
  /// framework change rather than an app one.
  private resourceHeaders(ext: LoadedExtension, path: string): Record<string, string> {
    const headers: Record<string, string> = { "Cache-Control": "no-cache" };
    const relative = path.replace(/^\/+/, "");
    if (ext.manifest.webAccessibleResources.some((pattern) => matchesResource(pattern, relative))) {
      headers["Access-Control-Allow-Origin"] = "*";
    }
    return headers;
  }

  private resolveInside(root: string, relative: string): string | null {
    const base = resolve(root);
    const target = resolve(base, relative.replace(/^\/+/, ""));
    return target === base || target.startsWith(`${base}/`) ? target : null;
  }

  private readResource(ext: LoadedExtension, relative: string): string | null {
    const path = this.resolveInside(ext.root, relative);
    if (!path || !existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  // --------------------------------------------------------------- messaging

  /// Every `scriptMessage` from an extension world funnels through here.
  handleScriptMessage(surface: Surface, body: unknown): void {
    const env = body as Record<string, unknown> | null;
    if (!env) return;
    // The store hook runs in a world of its own rather than an extension's, so
    // it carries no token and no extension can reach this by posting the same
    // envelope from its own world.
    if (surface.extensionId === WEBSTORE_SURFACE) return this.onWebstoreMessage(env);
    // The popup's size reporter is not part of the shim and carries no token.
    if (env.k === "popupSize") return this.recordPopupSize(surface.extensionId, Number(env.width), Number(env.height));
    if (typeof env.token !== "string") return;
    const token = env.token;

    switch (env.k) {
      case "hello":
        return this.onHello(surface, token, env);
      case "call":
        return void this.onCall(token, env);
      case "loaded":
        return this.onLoaded(token);
      case "idle":
        return this.onIdle(token);
      case "msgres":
        return this.settle(String(env.id), env.response);
      case "portOpen":
        return this.onPortOpen(token, env);
      case "portMsg":
        return this.onPortMessage(token, env);
      case "portClose":
        return this.onPortClose(String(env.portId));
    }
  }

  private onHello(surface: Surface, token: string, env: Record<string, unknown>): void {
    const key = surfaceKey(surface);
    // Frame 0 is the main frame, exactly as Chrome numbers them; subframes get
    // the next free number for this surface.
    const isTop = env.top === true;
    let frameId = 0;
    if (!isTop) {
      const next = (this.frameCounters.get(key) ?? 0) + 1;
      this.frameCounters.set(key, next);
      frameId = next;
    } else {
      this.frameCounters.set(key, 0);
      for (const [existing, frame] of this.frames) {
        if (surfaceKey(frame.surface) === key) this.frames.delete(existing);
      }
    }
    const documentId = `${key}:${frameId}:${++this.seq}`;
    this.frames.set(token, { surface, frameId, documentId, url: String(env.url ?? "") });

    this.deliver(surface, {
      k: "ready",
      to: token,
      frameId,
      documentId,
      tabId: surface.kind === "content" ? this.tabNumber(surface.tabId) : -1,
    });

  }

  /// A background page has finished loading, so its own listeners exist now.
  /// Chrome fires onInstalled once per install; here it is once per session,
  /// because the background is started fresh with the window.
  private onLoaded(token: string): void {
    const frame = this.frames.get(token);
    if (!frame || frame.surface.kind !== "background" || frame.frameId !== 0) return;
    this.deliver(frame.surface, {
      k: "evt",
      name: "runtime.onInstalled",
      args: [{ reason: this.freshInstalls.delete(frame.surface.extensionId) ? "install" : "update", previousVersion: "" }],
    });
    this.deliver(frame.surface, { k: "evt", name: "runtime.onStartup", args: [] });

    this.backgroundLoaded.add(frame.surface.extensionId);
    const waiting = this.queuedForBackground.get(frame.surface.extensionId) ?? [];
    this.queuedForBackground.delete(frame.surface.extensionId);
    for (const envelope of waiting) this.deliver(frame.surface, envelope);
    this.notify();
  }

  /// The background page has run out of its own startup work: no chrome.* call
  /// outstanding and nothing left loading out of its own chrome-extension://
  /// origin, measured across a task boundary in the page (see the shim).
  ///
  /// This, not `loaded`, is what a tab's first navigation waits for. `load`
  /// fires while the extension's startup is still ahead of it: measured on
  /// g815, Dark Reader's config requests do not reach the broker until ~150ms
  /// after `loaded`, and a page that commits in that window connects to a
  /// background that answers it with an exception nothing retries.
  private onIdle(token: string): void {
    const frame = this.frames.get(token);
    if (!frame || frame.surface.kind !== "background" || frame.frameId !== 0) return;
    if (process.env.NB_TEST_HOOKS === "1") {
      console.error(`ND_APP backgroundIdle ext=${frame.surface.extensionId}`);
    }
    this.backgroundIdle.add(frame.surface.extensionId);
    // Tabs are holding their navigation until this is true.
    this.notify();
  }

  private async onCall(token: string, env: Record<string, unknown>): Promise<void> {
    const frame = this.frames.get(token);
    if (!frame) return;
    const id = String(env.id);
    try {
      const value = await this.dispatch(frame, String(env.api), (env.args ?? {}) as Record<string, unknown>);
      this.deliver(frame.surface, { k: "ret", to: token, id, ok: true, value: value ?? null });
    } catch (error) {
      this.deliver(frame.surface, { k: "ret", to: token, id, ok: false, error: (error as Error).message });
    }
  }

  /// Delivers one envelope into a surface's world. Anything aimed at a subframe
  /// rides the bootstrap's postMessage relay, since world-scoped evaluation
  /// only reaches a view's main frame.
  private deliver(surface: Surface, env: Record<string, unknown>): void {
    const node = this.nodeFor(surface);
    if (!node) return;
    const world = surface.kind === "content" ? contentWorld(surface.extensionId) : undefined;
    const code = `globalThis.__ndext && globalThis.__ndext.deliver(${JSON.stringify(env)})`;
    void executeJavaScript(node, code, world).catch(() => {
      // A view that navigated away mid-flight is not an error worth surfacing.
    });
  }

  private nodeFor(surface: Surface): WebViewRef | null {
    if (surface.kind === "content") return this.tabViews.get(surface.tabId) ?? null;
    if (surface.kind === "background") return this.backgroundViews.get(surface.extensionId) ?? null;
    return this.popupViews.get(surface.extensionId) ?? null;
  }

  private backgroundSurface(extensionId: string): Surface | null {
    return this.backgroundViews.has(extensionId) ? { kind: "background", extensionId } : null;
  }

  /// Fans an event out to every live surface of every enabled extension.
  private broadcastEvent(name: string, args: unknown[]): void {
    for (const ext of this.enabledExtensions()) this.emitTo(ext.id, name, args);
  }

  private emitTo(extensionId: string, name: string, args: unknown[]): void {
    const surfaces: Surface[] = [];
    if (this.backgroundViews.has(extensionId)) surfaces.push({ kind: "background", extensionId });
    if (this.popupViews.has(extensionId)) surfaces.push({ kind: "popup", extensionId });
    for (const surface of surfaces) this.deliver(surface, { k: "evt", name, args });
  }

  private awaitReply(timeoutMs = 8000): { id: string; promise: Promise<unknown> } {
    const id = `r${++this.seq}`;
    const promise = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    return { id, promise };
  }

  private settle(id: string, value: unknown): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.resolve(value);
  }

  private senderFor(frame: FrameRef): Record<string, unknown> {
    const sender: Record<string, unknown> = {
      id: frame.surface.extensionId,
      url: frame.url,
      frameId: frame.frameId,
      documentId: frame.documentId,
      origin: originOf(frame.url),
    };
    if (frame.surface.kind === "content") {
      const tab = this.tabs.find((t) => t.id === (frame.surface as { tabId: string }).tabId);
      if (tab) sender.tab = this.tabInfo(tab);
    }
    return sender;
  }

  // ------------------------------------------------------------------- ports

  private onPortOpen(token: string, env: Record<string, unknown>): void {
    const frame = this.frames.get(token);
    if (!frame) return;
    const portId = String(env.portId);
    const target =
      env.tabId === undefined
        ? this.backgroundSurface(frame.surface.extensionId)
        : ({ kind: "content", tabId: this.tabIdOf(Number(env.tabId)) ?? "", extensionId: frame.surface.extensionId } as Surface);
    if (!target || (target.kind === "content" && !target.tabId)) {
      this.deliver(frame.surface, { k: "portClose", to: token, portId });
      return;
    }
    const targetToken = this.tokenFor(target, 0);
    if (!targetToken) {
      this.deliver(frame.surface, { k: "portClose", to: token, portId });
      return;
    }
    this.ports.set(portId, { id: portId, from: token, to: targetToken, name: String(env.name ?? "") });
    this.deliver(target, {
      k: "portOpen",
      to: targetToken,
      portId,
      name: String(env.name ?? ""),
      sender: this.senderFor(frame),
    });
  }

  private onPortMessage(token: string, env: Record<string, unknown>): void {
    const link = this.ports.get(String(env.portId));
    if (!link) return;
    const otherToken = link.from === token ? link.to : link.from;
    if (!otherToken) return;
    const other = this.frames.get(otherToken);
    if (!other) return;
    this.deliver(other.surface, { k: "portMsg", to: otherToken, portId: link.id, message: env.message });
  }

  private onPortClose(portId: string): void {
    const link = this.ports.get(portId);
    if (!link) return;
    this.ports.delete(portId);
    for (const token of [link.from, link.to]) {
      const frame = token ? this.frames.get(token) : null;
      if (frame) this.deliver(frame.surface, { k: "portClose", to: token, portId });
    }
  }

  private tokenFor(surface: Surface, frameId: number): string | null {
    for (const [token, frame] of this.frames) {
      if (surfaceKey(frame.surface) === surfaceKey(surface) && frame.frameId === frameId) return token;
    }
    return null;
  }

  private tabIdOf(number: number): string | null {
    for (const tab of this.tabs) {
      if (this.tabNumber(tab.id) === number) return tab.id;
    }
    return null;
  }

  // -------------------------------------------------------------- API surface

  private async dispatch(frame: FrameRef, api: string, args: Record<string, unknown>): Promise<unknown> {
    const extensionId = frame.surface.extensionId;
    const ext = this.extensions.get(extensionId);
    if (!ext) throw new Error("extension is no longer installed");

    switch (api) {
      // --- storage
      case "storage.get": {
        const area = args.area as StorageArea;
        const all = await this.readStorage(extensionId, area);
        return selectKeys(all, args.keys);
      }
      case "storage.set": {
        const area = args.area as StorageArea;
        const items = (args.items ?? {}) as Record<string, unknown>;
        const before = await this.readStorage(extensionId, area);
        await this.writeStorage(extensionId, area, items);
        const changes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: before[key], newValue: value };
        }
        this.emitStorageChange(extensionId, area, changes);
        return null;
      }
      case "storage.remove": {
        const area = args.area as StorageArea;
        const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [String(args.keys)];
        const before = await this.readStorage(extensionId, area);
        await this.removeStorage(extensionId, area, keys);
        const changes: Record<string, unknown> = {};
        for (const key of keys) changes[key] = { oldValue: before[key] };
        this.emitStorageChange(extensionId, area, changes);
        return null;
      }
      case "storage.clear": {
        const area = args.area as StorageArea;
        const before = await this.readStorage(extensionId, area);
        await this.clearStorage(extensionId, area);
        const changes: Record<string, unknown> = {};
        for (const key of Object.keys(before)) changes[key] = { oldValue: before[key] };
        this.emitStorageChange(extensionId, area, changes);
        return null;
      }
      case "storage.getBytesInUse": {
        const all = await this.readStorage(extensionId, args.area as StorageArea);
        return JSON.stringify(selectKeys(all, args.keys)).length;
      }

      // --- messaging
      case "runtime.sendMessage": {
        const background = this.backgroundSurface(extensionId);
        // A message from the background page itself is meant for the popup and
        // any other extension view, not for a round trip into itself.
        if (frame.surface.kind === "background" || !background) {
          this.fanoutMessage(extensionId, frame, args.message, ["popup", "background"]);
          return null;
        }
        return this.sendMessageTo(background, 0, args.message, this.senderFor(frame));
      }
      case "tabs.sendMessage": {
        const tabId = this.tabIdOf(Number(args.tabId));
        if (!tabId) throw new Error("no such tab");
        const options = (args.options ?? {}) as Record<string, unknown>;
        const target: Surface = { kind: "content", tabId, extensionId };
        // MV3 addresses frames by documentId, which only the broker can map
        // back to a frame. Falling through to frameId, then to a broadcast,
        // matches the three shapes extensions actually send.
        const byDocument = options.documentId ? this.tokenForDocument(String(options.documentId)) : null;
        // The token pins the exact document; its frame NUMBER is what survives
        // a reload, so both travel and the frame decides.
        const documentFrame = byDocument ? (this.frames.get(byDocument)?.frameId ?? null) : null;
        const frameId = options.frameId === undefined ? documentFrame : Number(options.frameId);
        return this.sendMessageTo(target, frameId, args.message, this.senderFor(frame), byDocument);
      }

      // --- tabs
      case "tabs.query":
        return this.queryTabs((args.query ?? {}) as Record<string, unknown>);
      case "tabs.get": {
        const tab = this.tabById(Number(args.tabId));
        if (!tab) throw new Error("no such tab");
        return this.tabInfo(tab);
      }
      case "tabs.create": {
        const props = (args.props ?? {}) as { url?: string; active?: boolean };
        const id = this.appHooks.openTab(props.url ?? "", props.active === false);
        const tab = this.tabs.find((t) => t.id === id);
        return tab ? this.tabInfo(tab) : { id: this.tabNumber(id ?? ""), url: props.url ?? "" };
      }
      case "tabs.update": {
        const tabId = this.tabIdOf(Number(args.tabId)) ?? this.tabs.find((t) => t.active)?.id;
        const props = (args.props ?? {}) as { url?: string; active?: boolean };
        if (tabId) this.appHooks.updateTab(tabId, props);
        const tab = this.tabs.find((t) => t.id === tabId);
        return tab ? this.tabInfo(tab) : null;
      }
      case "tabs.reload": {
        const tabId = this.tabIdOf(Number(args.tabId)) ?? this.tabs.find((t) => t.active)?.id;
        if (tabId) this.appHooks.reloadTab(tabId);
        return null;
      }
      case "tabs.remove": {
        const tabId = this.tabIdOf(Number(args.tabId));
        if (tabId) this.appHooks.closeTab(tabId);
        return null;
      }
      // The two spellings differ in their answer: MV2 resolves to the raw
      // values, MV3 to one InjectionResult per frame. Handing MV2 the wrapped
      // shape makes every result truthy, which silently inverts the caller's
      // logic instead of failing.
      case "tabs.executeScript":
        return this.injectScript(ext, args, false);
      case "scripting.executeScript":
        return this.injectScript(ext, args, true);
      case "tabs.insertCSS":
      case "scripting.insertCSS": {
        const details = (args.details ?? args) as Record<string, unknown>;
        const css =
          typeof details.css === "string"
            ? details.css
            : (asStringList(details.files).map((f) => this.readResource(ext, f) ?? "").join("\n") || "");
        const node = this.targetView(args);
        if (node && css) {
          await executeJavaScript(node, contentStyleWrapper(css), contentWorld(extensionId)).catch(() => "");
        }
        return null;
      }
      case "scripting.removeCSS":
      case "scripting.registerContentScripts":
      case "scripting.unregisterContentScripts":
        return null;
      case "scripting.getRegisteredContentScripts":
        return [];

      // --- windows: this browser has one window, and a popup is not one
      case "windows.create": {
        const props = (args.props ?? {}) as { url?: string };
        if (props.url) this.appHooks.openTab(props.url, false);
        return { id: 1, focused: true, type: "normal" };
      }
      case "windows.update":
        return { id: 1, focused: true, type: "normal" };
      case "windows.getCurrent":
        return { id: 1, focused: true, type: "normal", tabs: this.tabs.map((t) => this.tabInfo(t)) };
      case "windows.getAll":
        return [{ id: 1, focused: true, type: "normal" }];

      // --- action
      case "action.setTitle": {
        const state = this.actionState(extensionId);
        state.title = String((args as { title?: string }).title ?? state.title);
        this.notify();
        return null;
      }
      case "action.setBadgeText": {
        const state = this.actionState(extensionId);
        state.badge = String((args as { text?: string }).text ?? "");
        this.notify();
        return null;
      }
      case "action.setIcon": {
        const state = this.actionState(extensionId);
        const path = (args as { path?: unknown }).path;
        const relative = typeof path === "string" ? path : pickIcon(asIconRecord(path), 48);
        const resolved = relative ? this.resolveInside(ext.root, relative) : null;
        if (resolved && existsSync(resolved)) state.iconPath = resolved;
        this.notify();
        return null;
      }
      case "action.getBadgeText":
        return this.actionState(extensionId).badge;
      case "action.setBadgeBackgroundColor":
      case "action.setPopup":
        return null;

      // --- alarms
      case "alarms.create": {
        this.createAlarm(extensionId, String(args.name ?? ""), (args.info ?? {}) as Record<string, unknown>);
        return null;
      }
      case "alarms.clear":
        return this.clearAlarm(extensionId, String(args.name ?? ""));
      case "alarms.clearAll": {
        for (const name of [...this.alarms.keys()]) {
          if (name.startsWith(`${extensionId} `)) this.clearAlarm(extensionId, name.split(" ")[1]!);
        }
        return true;
      }
      case "alarms.get": {
        const alarm = this.alarms.get(`${extensionId} ${args.name ?? ""}`);
        return alarm ? { name: args.name, scheduledTime: alarm.scheduled, periodInMinutes: alarm.periodInMinutes } : null;
      }
      case "alarms.getAll": {
        const out: unknown[] = [];
        for (const [key, alarm] of this.alarms) {
          const [owner, name] = key.split(" ");
          if (owner !== extensionId) continue;
          out.push({ name, scheduledTime: alarm.scheduled, periodInMinutes: alarm.periodInMinutes });
        }
        return out;
      }

      // --- context menus, notifications, permissions, odds and ends
      case "contextMenus.create": {
        const id = this.menus.create(extensionId, (args.props ?? {}) as MenuProps);
        this.notify();
        return id;
      }
      case "contextMenus.update": {
        this.menus.update(extensionId, String(args.id), (args.props ?? {}) as MenuProps);
        this.notify();
        return null;
      }
      case "contextMenus.remove": {
        this.menus.remove(extensionId, String(args.id));
        this.notify();
        return null;
      }
      case "contextMenus.removeAll": {
        this.menus.removeAll(extensionId);
        this.notify();
        return null;
      }
      case "notifications.create": {
        const options = (args.options ?? {}) as { title?: string; message?: string };
        return notifications.show({ title: options.title ?? ext.manifest.name, body: options.message });
      }
      case "notifications.clear":
        return true;
      case "permissions.contains": {
        const wanted = [
          ...((args.permissions as string[] | undefined) ?? []),
          ...((args.origins as string[] | undefined) ?? []),
        ];
        return wanted.every((p) => ext.granted.includes(p));
      }
      case "permissions.request":
        return this.requestPermissions(ext.id, [
          ...((args.permissions as string[] | undefined) ?? []),
          ...((args.origins as string[] | undefined) ?? []),
        ]);
      case "permissions.remove": {
        const dropping = new Set([
          ...((args.permissions as string[] | undefined) ?? []),
          ...((args.origins as string[] | undefined) ?? []),
        ]);
        ext.granted = ext.granted.filter((p) => !dropping.has(p));
        this.reinstallContentScripts();
        await upsertInstalled({
          id: ext.id,
          root: ext.root,
          enabled: ext.enabled,
          granted: ext.granted,
          installedAt: Date.now(),
        });
        this.notify();
        return true;
      }
      case "extension.isAllowedFileSchemeAccess":
        return false;
      case "fontSettings.getFontList":
        return FONT_LIST;
      case "runtime.getPlatformInfo":
        return { os: process.platform === "darwin" ? "mac" : "linux", arch: process.arch === "arm64" ? "arm" : "x86-64" };
      case "runtime.setUninstallURL":
      case "runtime.reload":
        return null;
      default:
        throw new Error(`${api} is not implemented`);
    }
  }

  private targetView(args: Record<string, unknown>): WebViewRef | null {
    const target = (args.target ?? {}) as { tabId?: number };
    const raw = args.tabId ?? target.tabId;
    const tabId = raw === undefined ? this.tabs.find((t) => t.active)?.id : this.tabIdOf(Number(raw));
    return tabId ? (this.tabViews.get(tabId) ?? null) : null;
  }

  /// chrome.scripting.executeScript and its MV2 predecessor. Three shapes reach
  /// here: a function plus arguments (serialized to source by the shim), a list
  /// of packaged files, and MV2's raw `code`. Only the view's main frame is
  /// reachable, so `allFrames` injects into frame 0 alone — recorded as a
  /// limitation rather than silently pretended.
  private async injectScript(
    ext: LoadedExtension,
    args: Record<string, unknown>,
    wrapResults: boolean,
  ): Promise<unknown[]> {
    const node = this.targetView(args);
    if (!node) return [];
    const details = (args.details ?? args) as Record<string, unknown>;

    let body: string;
    if (typeof details.funcSource === "string") {
      const callArgs = Array.isArray(details.args) ? details.args : [];
      body = `return (${details.funcSource}).apply(null, ${JSON.stringify(callArgs)});`;
    } else if (typeof details.code === "string") {
      body = details.code;
    } else {
      const files = asStringList(details.files);
      const sources = files.map((file) => this.readResource(ext, file));
      if (sources.some((s) => s === null)) throw new Error("no such script file in this extension");
      body = sources.join("\n;\n");
    }

    const world = details.world === "MAIN" ? undefined : contentWorld(ext.id);
    const code = `JSON.stringify((function(){ ${body} })())`;
    const raw = await evalInView(node, code, world);
    const result = safeParse(raw);
    return wrapResults ? [{ frameId: 0, documentId: null, result }] : [result];
  }

  private actionState(extensionId: string): ActionState {
    let state = this.actions.get(extensionId);
    if (!state) {
      const ext = this.extensions.get(extensionId);
      state = { title: ext?.manifest.name ?? "", badge: "", iconPath: ext ? this.iconPath(ext, 48) : null };
      this.actions.set(extensionId, state);
    }
    return state;
  }

  private queryTabs(query: Record<string, unknown>): unknown[] {
    return this.tabs
      .filter((tab) => {
        if (query.active !== undefined && tab.active !== query.active) return false;
        if (typeof query.url === "string" && !tab.url.includes(query.url.replace(/\*/g, ""))) return false;
        if (query.windowType !== undefined && query.windowType !== "normal") return false;
        return true;
      })
      .map((tab) => this.tabInfo(tab));
  }

  private async sendMessageTo(
    surface: Surface,
    frameId: number | null,
    message: unknown,
    sender: Record<string, unknown>,
    toToken: string | null = null,
  ): Promise<unknown> {
    const { id, promise } = this.awaitReply();
    const envelope = {
      k: "msg",
      id,
      message,
      sender,
      to: toToken,
      frameId,
      spread: toToken !== null || frameId !== 0,
    };

    // A restored tab's content scripts can start before the background page
    // has finished loading. Chrome wakes a service worker for exactly this and
    // delivers the message; dropping it here would leave the content script
    // waiting for an answer that never comes. Readiness is the page having said
    // page having FINISHED LOADING, not merely existing: the shim says hello at
    // document_start, long before the extension's own deferred script has
    // registered its onMessage listener, and a message delivered in that window
    // is answered with "no listener" and never retried.
    if (surface.kind === "background" && !this.backgroundLoaded.has(surface.extensionId)) {
      if (!this.extensions.get(surface.extensionId)?.enabled) return null;
      const queue = this.queuedForBackground.get(surface.extensionId) ?? [];
      queue.push(envelope);
      this.queuedForBackground.set(surface.extensionId, queue);
      return promise;
    }
    if (!this.nodeFor(surface)) return null;

    this.deliver(surface, envelope);
    return promise;
  }

  private tokenForDocument(documentId: string): string | null {
    for (const [token, frame] of this.frames) {
      if (frame.documentId === documentId) return token;
    }
    return null;
  }

  private fanoutMessage(
    extensionId: string,
    from: FrameRef,
    message: unknown,
    kinds: ("background" | "popup")[],
  ): void {
    const sender = this.senderFor(from);
    for (const kind of kinds) {
      const surface: Surface = { kind, extensionId };
      if (surfaceKey(surface) === surfaceKey(from.surface)) continue;
      if (!this.nodeFor(surface)) continue;
      this.deliver(surface, { k: "msg", id: `x${++this.seq}`, message, sender, frameId: 0, spread: false });
    }
  }

  // ---------------------------------------------------------------- storage

  private async readStorage(id: string, area: StorageArea): Promise<Record<string, unknown>> {
    if (area === "session") return this.sessionStorage.get(id) ?? {};
    return readArea(id, area);
  }

  private async writeStorage(id: string, area: StorageArea, items: Record<string, unknown>): Promise<void> {
    if (area === "session") {
      this.sessionStorage.set(id, { ...(this.sessionStorage.get(id) ?? {}), ...items });
      return;
    }
    await writeArea(id, area, items);
  }

  private async removeStorage(id: string, area: StorageArea, keys: string[]): Promise<void> {
    if (area === "session") {
      const current = { ...(this.sessionStorage.get(id) ?? {}) };
      for (const key of keys) delete current[key];
      this.sessionStorage.set(id, current);
      return;
    }
    await deleteKeys(id, area, keys);
  }

  private async clearStorage(id: string, area: StorageArea): Promise<void> {
    if (area === "session") {
      this.sessionStorage.delete(id);
      return;
    }
    await clearArea(id, area);
  }

  private emitStorageChange(id: string, area: StorageArea, changes: Record<string, unknown>): void {
    if (Object.keys(changes).length === 0) return;
    this.emitTo(id, "storage.onChanged", [changes, area]);
    this.emitTo(id, `storage.${area}.onChanged`, [changes]);
  }

  // ----------------------------------------------------------------- alarms

  private createAlarm(extensionId: string, name: string, info: Record<string, unknown>): void {
    const key = `${extensionId} ${name}`;
    this.clearAlarm(extensionId, name);
    const delayMinutes =
      typeof info.delayInMinutes === "number"
        ? info.delayInMinutes
        : typeof info.when === "number"
          ? Math.max(0, (info.when - Date.now()) / 60000)
          : typeof info.periodInMinutes === "number"
            ? info.periodInMinutes
            : 0;
    const period = typeof info.periodInMinutes === "number" ? info.periodInMinutes : undefined;
    const fire = (): void => {
      this.emitTo(extensionId, "alarms.onAlarm", [{ name, scheduledTime: Date.now(), periodInMinutes: period }]);
      if (period === undefined) {
        this.alarms.delete(key);
        return;
      }
      const entry = this.alarms.get(key);
      if (!entry) return;
      entry.scheduled = Date.now() + period * 60000;
      entry.timer = setTimeout(fire, period * 60000);
    };
    const delayMs = Math.max(0, delayMinutes * 60000);
    this.alarms.set(key, { timer: setTimeout(fire, delayMs), scheduled: Date.now() + delayMs, periodInMinutes: period });
  }

  private clearAlarm(extensionId: string, name: string): boolean {
    const key = `${extensionId} ${name}`;
    const alarm = this.alarms.get(key);
    if (!alarm) return false;
    clearTimeout(alarm.timer);
    this.alarms.delete(key);
    return true;
  }

  // ------------------------------------------------------------- action UI

  /// The toolbar button: opens the popup when the manifest declares one, and
  /// otherwise fires the click event the background page listens for.
  openAction(extensionId: string): void {
    const ext = this.extensions.get(extensionId);
    if (!ext) return;
    const popup = ext.manifest.action?.defaultPopup;
    if (!popup) {
      const active = this.tabs.find((t) => t.active);
      this.emitTo(extensionId, "action.onClicked", [active ? this.tabInfo(active) : null]);
      return;
    }
    if (this.popup?.extensionId === extensionId) return this.closePopup();
    const size = this.popupSizes.get(extensionId) ?? POPUP_DEFAULT;
    this.popup = { extensionId, url: extensionUrl(extensionId, popup), ...size };
    this.notify();
  }

  closePopup(): void {
    if (!this.popup) return;
    const extensionId = this.popup.extensionId;
    this.detachExtensionView("popup", extensionId);
    this.armed.delete(`popup:${extensionId}`);
    this.forgetFrames((surface) => surface.kind === "popup" && surface.extensionId === extensionId);
    this.popup = null;
    this.notify();
  }

  /// The popup reports its own content size; the window it lives in is created
  /// at a fixed size, so the measurement takes effect the next time it opens.
  recordPopupSize(extensionId: string, width: number, height: number): void {
    const clamped = {
      width: Math.min(POPUP_MAX.width, Math.max(POPUP_MIN, Math.round(width))),
      height: Math.min(POPUP_MAX.height, Math.max(POPUP_MIN, Math.round(height))),
    };
    const current = this.popupSizes.get(extensionId);
    if (current && current.width === clamped.width && current.height === clamped.height) return;
    this.popupSizes.set(extensionId, clamped);
  }

  runCommand(extensionId: string, command: string): void {
    if (command.startsWith("_execute")) return this.openAction(extensionId);
    const active = this.tabs.find((t) => t.active);
    this.emitTo(extensionId, "commands.onCommand", [command, active ? this.tabInfo(active) : null]);
  }

  /// The menubar path: no hit test, so the click carries the active tab's URL
  /// and nothing else.
  clickContextMenuItem(extensionId: string, itemId: string): void {
    const active = this.tabs.find((t) => t.active);
    this.deliverMenuClick(extensionId, itemId, active?.id ?? "", {
      id: "",
      pageUrl: active?.url ?? "",
      editable: false,
    });
  }

  /// A click on an item this broker put in a page's context menu. Returns false
  /// when the id is not an extension's, so the app can handle its own items.
  handleContextMenuClick(tabId: string, click: ContextMenuItemClick): boolean {
    const owner = parseFrameworkId(click.id);
    if (!owner) return false;
    this.deliverMenuClick(owner.extensionId, owner.entryId, tabId, click);
    return true;
  }

  private deliverMenuClick(
    extensionId: string,
    entryId: string,
    tabId: string,
    click: ContextMenuItemClick,
  ): void {
    const entry = this.menus.entry(extensionId, entryId);
    if (!entry) return;
    const tab = this.tabs.find((t) => t.id === tabId) ?? this.tabs.find((t) => t.active);
    const pageUrl = click.pageUrl || tab?.url || "";
    const targetUrl = click.linkUrl ?? click.imageUrl ?? "";
    // The framework filters on globs, which are looser than a match pattern.
    // Chrome would never have shown this item, so the extension never hears it.
    if (!this.menus.clickAllowed(entry, pageUrl, targetUrl)) return;

    const state = this.menus.applyClick(extensionId, entry);
    if (Object.keys(state).length > 0) this.notify();

    const info: Record<string, unknown> = {
      menuItemId: entry.id,
      pageUrl,
      frameUrl: pageUrl,
      editable: click.editable,
    };
    if (entry.parentId !== null) info.parentMenuItemId = entry.parentId;
    if (click.linkUrl) info.linkUrl = click.linkUrl;
    if (click.imageUrl) info.srcUrl = click.imageUrl;
    if (click.imageUrl) info.mediaType = "image";
    if (click.selectionText) info.selectionText = click.selectionText;
    if (state.checked !== undefined) info.checked = state.checked;
    if (state.wasChecked !== undefined) info.wasChecked = state.wasChecked;
    this.emitTo(extensionId, "contextMenus.onClicked", [info, tab ? this.tabInfo(tab) : null]);
  }

  // --------------------------------------------------------------- app hooks

  /// Actions only the React tree can perform. Set once, at boot.
  appHooks: {
    openTab: (url: string, background: boolean) => string;
    closeTab: (tabId: string) => void;
    reloadTab: (tabId: string) => void;
    updateTab: (tabId: string, props: { url?: string; active?: boolean }) => void;
  } = {
    openTab: () => "",
    closeTab: () => {},
    reloadTab: () => {},
    updateTab: () => {},
  };
}

// ------------------------------------------------------------------ helpers

/// The popup's own size, reported once the page has laid out and on every
/// change after. The window cannot be resized in place (see LEDGER), so this
/// is what makes the *next* open the right size.
function popupSizeReporter(extensionId: string): string {
  return `(function(){
function report() {
  var el = document.documentElement;
  var w = Math.max(el.scrollWidth, document.body ? document.body.scrollWidth : 0);
  var h = Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
  var handlers = window.webkit && window.webkit.messageHandlers;
  var bridge = handlers && handlers[${JSON.stringify(bridgeHandler(extensionId))}];
  if (bridge) bridge.postMessage({ k: "popupSize", width: w, height: h });
}
new ResizeObserver(report).observe(document.documentElement);
setTimeout(report, 200);
})();`;
}

export function contentWorld(extensionId: string): string {
  return `ext:${extensionId}`;
}

/** Reserved path the MV3 service-worker wrapper page is served from. */
export const SERVICE_WORKER_PATH = "/__nd_service_worker.html";

const ACCELERATOR_MODIFIERS: Record<string, string> = {
  ctrl: "primary",
  control: "primary",
  command: "primary",
  cmd: "primary",
  macctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  search: "primary",
};

const ACCELERATOR_KEYS: Record<string, string> = {
  comma: "comma",
  period: "period",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  insert: "Insert",
  delete: "Delete",
  home: "Home",
  end: "End",
};

/// A manifest's `Alt+Shift+D` in the framework's `alt+shift+d` spelling.
/// Chrome's `Ctrl` is the platform's primary modifier, which is exactly what
/// `primary` means here.
export function toNdAccelerator(chromeKey: string): string | null {
  const parts = chromeKey.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const modifiers: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    const modifier = ACCELERATOR_MODIFIERS[part.toLowerCase()];
    if (modifier) modifiers.push(modifier);
    else key = ACCELERATOR_KEYS[part.toLowerCase()] ?? part.toLowerCase();
  }
  if (!key || modifiers.length === 0) return null;
  return [...new Set(modifiers), key].join("+");
}

/// MV3 backgrounds are service worker *scripts*, not pages. WebKitGTK will not
/// host an extension service worker, so the script runs in an ordinary hidden
/// page with the few ServiceWorkerGlobalScope members extensions actually
/// touch. The lifecycle is deliberately absent: this worker never sleeps, so
/// install/activate/fetch have nothing to fire.
/// One small PNG per installed extension, read once and memoized: `views()`
/// runs on every render and an icon file never changes under a given path.
const iconDataCache = new Map<string, string | undefined>();

function iconDataUrl(path: string | null): string | undefined {
  if (!path) return undefined;
  const cached = iconDataCache.get(path);
  if (cached !== undefined || iconDataCache.has(path)) return cached;
  let encoded: string | undefined;
  try {
    const mime = path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
    encoded = `data:${mime};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    encoded = undefined;
  }
  iconDataCache.set(path, encoded);
  return encoded;
}

/// `web_accessible_resources` entries are glob paths (`icons/*`, `*.png`), not
/// match patterns.
function matchesResource(pattern: string, relative: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(relative);
}

function serviceWorkerPage(workerPath: string): string {
  const src = workerPath.startsWith("/") ? workerPath : `/${workerPath}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Service worker</title>
<script>
(function () {
  var real = self.addEventListener.bind(self);
  var inert = { install: 1, activate: 1, fetch: 1, push: 1, sync: 1, notificationclick: 1 };
  self.addEventListener = function (type, fn, opts) {
    if (inert[type]) return;
    return real(type, fn, opts);
  };
  self.skipWaiting = function () { return Promise.resolve(); };
  self.clients = {
    claim: function () { return Promise.resolve(); },
    matchAll: function () { return Promise.resolve([]); },
    get: function () { return Promise.resolve(undefined); },
  };
  self.registration = {
    scope: location.origin + "/",
    active: null,
    showNotification: function () { return Promise.resolve(); },
    getNotifications: function () { return Promise.resolve([]); },
  };
})();
</script>
<script src="${src}" defer></script>
</head><body></body></html>`;
}

function surfaceKey(surface: Surface): string {
  return surface.kind === "content" ? `content:${surface.tabId}:${surface.extensionId}` : `${surface.kind}:${surface.extensionId}`;
}

function uiLocale(): string {
  const raw = process.env.LANG ?? process.env.LC_ALL ?? "en_US";
  return raw.split(".")[0]!.replace("-", "_") || "en_US";
}

function catalogFor(ext: LoadedExtension): Record<string, { message: string; placeholders?: Record<string, { content: string }> }> {
  const path = resolve(ext.root, "_locales", ext.manifest.defaultLocale, "messages.json");
  const chain = [path];
  const specific = resolve(ext.root, "_locales", uiLocale(), "messages.json");
  if (existsSync(specific)) chain.unshift(specific);
  const merged: Record<string, { message: string; placeholders?: Record<string, { content: string }> }> = {};
  for (const file of chain.reverse()) {
    if (!existsSync(file)) continue;
    try {
      Object.assign(merged, JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A catalog that will not parse contributes nothing rather than failing the load.
    }
  }
  return merged;
}

function stripMessageRef(value: string): string {
  const match = /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value);
  return match ? match[1]! : value;
}

function selectKeys(all: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  if (keys === null || keys === undefined) return all;
  if (typeof keys === "string") return keys in all ? { [keys]: all[keys] } : {};
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key === "string" && key in all) out[key] = all[key];
    }
    return out;
  }
  // An object argument supplies defaults for every key it names.
  const out: Record<string, unknown> = { ...(keys as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (key in all) out[key] = all[key];
  }
  return out;
}

/// executeJavaScript settles when the engine answers with a matching id. A view
/// that navigates, or a result that never comes back, would otherwise leave the
/// promise pending forever — and an extension awaiting executeScript would
/// deadlock rather than see a null. Chrome answers something in every case, so
/// this does too.
const EVAL_TIMEOUT_MS = 5000;

function evalInView(node: WebViewRef, code: string, world: string | undefined): Promise<string> {
  return Promise.race([
    executeJavaScript(node, code, world).catch(() => "null"),
    new Promise<string>((resolve) => setTimeout(() => resolve("null"), EVAL_TIMEOUT_MS)),
  ]);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asIconRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [size, path] of Object.entries(value as Record<string, unknown>)) {
    if (typeof path === "string") out[size] = path;
  }
  return out;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function webStoreId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed;
  const match = /\/detail\/(?:[^/]+\/)?([a-p]{32})/.exec(trimmed);
  return match ? match[1]! : null;
}

/// A package whose entries all sit under one folder (`darkreader/manifest.json`)
/// is unwrapped so the extension root is where the manifest actually is.
function unwrapSingleFolder(root: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (entries.length !== 1 || dirs.length !== 1) return null;
  const inner = resolve(root, dirs[0]!.name);
  return existsSync(resolve(inner, "manifest.json")) ? inner : null;
}
