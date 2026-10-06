import { sendCommand, type NdNodeRef } from "@nativedesktop/solid";

/// The Chrome Web Store decides "is this Google Chrome" on the server, from the
/// X-Browser-Validation header that only Google's own builds can sign; no
/// Chromium build passes, whatever its UA or client hints say. The verdict only
/// drives two nags: the "Switch to Chrome" banner (state 17 of the item's info
/// box, whose "Install Chrome" link carries jslog 276336) and the "Switch to
/// Chrome?" promo in the header. The install button has its own controller and
/// works off chrome.webstorePrivate. Hiding by CSS rather than removing nodes
/// lets the info box come back for the store's other states (incognito, admin
/// blocked) on the same page.
const STORE_CSS = [
  '[jscontroller="o2G9me"]:has([jslog^="276336"])',
  '[role="dialog"][aria-labelledby="promo-header"]',
]
  .map((rule) => `${rule}{display:none!important}`)
  .join("");

export const WEBSTORE_FIXUP_SCRIPT = `(() => {
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(STORE_CSS)};
  const place = () => (document.head || document.documentElement)?.append(style);
  if (document.documentElement) place();
  else new MutationObserver((_, o) => document.documentElement && (o.disconnect(), place())).observe(document, { childList: true });
})();`;

const fixed = new WeakSet<object>();

/// Once per view: the user script registry outlives navigations.
export function fixWebStore(node: NdNodeRef<"webview">): void {
  if (fixed.has(node)) return;
  fixed.add(node);
  sendCommand(node, "addUserScript", {
    id: "nb-webstore",
    source: WEBSTORE_FIXUP_SCRIPT,
    injectionTime: "start",
    world: "nb-webstore",
    allowList: ["https://chromewebstore.google.com/*"],
  });
}

/// Installs, asked in the app's own dialog.
///
/// The store page installs through `chrome.webstorePrivate`, and Chromium
/// answers `beginInstallWithManifest3` with a prompt of its own. The script
/// below holds that call in the page and asks the app first; a cancel never
/// reaches Chromium, an accept lets the call through with the engine told to
/// answer Chromium's prompt unseen (`acceptExtensionInstall`).

export const STORE_CHANNEL = "ndStore";
export const STORE_ORIGINS = ["https://chromewebstore.google.com/*"];

/// What the page asks the app.
export interface StoreRequest {
  id: string;
  name: string;
  iconUrl: string;
  manifest: string;
}

export function parseStoreRequest(body: unknown): StoreRequest | null {
  try {
    const raw = (typeof body === "string" ? JSON.parse(body) : body) as Partial<StoreRequest> | null;
    if (!raw || typeof raw.id !== "string" || !/^[a-p]{32}$/.test(raw.id)) return null;
    return { id: raw.id, name: String(raw.name ?? ""), iconUrl: String(raw.iconUrl ?? ""), manifest: String(raw.manifest ?? "") };
  } catch {
    return null;
  }
}

/// Main world, document start, store pages only. Runs before the store's own
/// code, so the store never holds the unwrapped function.
export const STORE_SCRIPT = `(() => {
  if (window.__ndStoreAnswer) return;
  const pending = new Map();
  let begin = null;
  let api = null;
  window.__ndStoreAnswer = (id, accept) => {
    const held = pending.get(id);
    if (!held) return "none";
    pending.delete(id);
    if (!accept) {
      held.cancel();
      return "cancelled";
    }
    if (held.callback) begin.call(api, held.details, held.callback);
    else begin.call(api, held.details).then(held.resolve, held.reject);
    return "sent";
  };
  const hook = () => {
    const wp = window.chrome && window.chrome.webstorePrivate;
    if (!wp || typeof wp.beginInstallWithManifest3 !== "function") return false;
    api = wp;
    begin = wp.beginInstallWithManifest3;
    wp.beginInstallWithManifest3 = function (details, callback) {
      const ask = (held) => {
        pending.set(details.id, held);
        window.webkit.messageHandlers.${STORE_CHANNEL}.postMessage(JSON.stringify({
          id: details.id, name: details.localizedName || "", iconUrl: details.iconUrl || "", manifest: details.manifest || "",
        }));
      };
      if (typeof callback === "function") {
        ask({ details, callback, cancel: () => callback("user_cancelled") });
        return undefined;
      }
      return new Promise((resolve, reject) => ask({ details, resolve, reject, cancel: () => reject(new Error("User cancelled install")) }));
    };
    return true;
  };
  if (!hook()) {
    const timer = setInterval(() => { if (hook()) clearInterval(timer); }, 50);
    setTimeout(() => clearInterval(timer), 30000);
  }
})()`;

export function storeAnswerScript(id: string, accept: boolean): string {
  return `window.__ndStoreAnswer ? window.__ndStoreAnswer(${JSON.stringify(id)}, ${accept}) : "none"`;
}

/// Chrome's own wording for what an extension can do, for the permissions
/// that carry a warning in Chrome's prompt. The rest (storage, alarms,
/// cookies without hosts, …) carry none there either.
const WARNINGS: Record<string, string> = {
  tabs: "Read your browsing history",
  webNavigation: "Read your browsing history",
  history: "Read and change your browsing history",
  topSites: "Read a list of your most frequently visited websites",
  bookmarks: "Read and change your bookmarks",
  downloads: "Manage your downloads",
  nativeMessaging: "Communicate with cooperating native applications",
  notifications: "Display notifications",
  clipboardRead: "Read data you copy and paste",
  clipboardWrite: "Modify data you copy and paste",
  privacy: "Change your privacy-related settings",
  management: "Manage your apps, extensions, and themes",
  declarativeNetRequest: "Block content on any page",
  geolocation: "Detect your physical location",
  contentSettings: "Change your settings that control websites' access to features",
  proxy: "Read and change all your data on all websites",
  debugger: "Access the page debugger backend",
  desktopCapture: "Capture content of your screen",
  tabCapture: "Read and change all your data on all websites",
};

const ALL_HOSTS = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\/)$/;

function hostOfPattern(pattern: string): string | null {
  const m = /^(?:\*|https?|wss?|ftp):\/\/([^/]+)\//.exec(pattern);
  if (!m) return null;
  return m[1]!.replace(/^\*\./, "");
}

/// The lines under "It can:" in the app's prompt, in Chrome's order: site
/// access first, then the rest, each said once.
export function permissionLines(manifestJson: string): string[] {
  let manifest: {
    permissions?: unknown[];
    optional_permissions?: unknown[];
    host_permissions?: unknown[];
    content_scripts?: { matches?: unknown[] }[];
  };
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    return [];
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const permissions = strings(manifest.permissions);
  const patterns = [
    ...strings(manifest.host_permissions),
    ...permissions.filter((p) => p.includes("://") || p === "<all_urls>"),
    ...(manifest.content_scripts ?? []).flatMap((c) => strings(c?.matches)),
  ];
  const lines: string[] = [];
  if (patterns.some((p) => ALL_HOSTS.test(p))) {
    lines.push("Read and change all your data on all websites");
  } else {
    const hosts = [...new Set(patterns.map(hostOfPattern).filter((h): h is string => !!h))];
    if (hosts.length === 1) lines.push(`Read and change your data on ${hosts[0]}`);
    else if (hosts.length > 1 && hosts.length <= 3) lines.push(`Read and change your data on ${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`);
    else if (hosts.length > 3) lines.push("Read and change your data on a number of websites");
  }
  for (const p of permissions) {
    const line = WARNINGS[p];
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}
