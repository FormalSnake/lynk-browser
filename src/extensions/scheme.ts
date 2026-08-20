// The origin extension pages are served from. It is a parameter rather than a
// constant because Chromium owns `chrome-extension://` at navigation level and
// blocks an embedder's handler for it (ERR_BLOCKED_BY_CLIENT) before any
// scheme factory is consulted, so the CEF engine serves the same ids and the
// same paths from `nbext://` while WebKit keeps Chrome's own scheme.
//
// Only `chrome.runtime.getURL` shows an extension which one it got; everything
// else here builds URLs through these helpers.

/** What WebKit serves. Chrome's own scheme, and what an extension expects. */
export const WEBKIT_SCHEME = "chrome-extension";

/** What Chromium serves. Pre-registered per process through ND_CEF_SCHEMES. */
export const CHROMIUM_SCHEME = "nbext";

/// The engine handshake is the env var the host itself reads
/// (NDCefEngine.isRequested), so the app and the engine can never disagree
/// about which scheme is being served.
export function extensionScheme(): string {
  return process.env.ND_WEBVIEW_ENGINE === "chromium" ? CHROMIUM_SCHEME : WEBKIT_SCHEME;
}

export function extensionOrigin(id: string): string {
  return `${extensionScheme()}://${id}`;
}

export function extensionUrl(id: string, path = "/"): string {
  return `${extensionOrigin(id)}${path.startsWith("/") ? path : `/${path}`}`;
}

/** True for an extension URL on either scheme, whichever engine wrote it. */
export function isExtensionUrl(url: string): boolean {
  return url.startsWith(`${WEBKIT_SCHEME}://`) || url.startsWith(`${CHROMIUM_SCHEME}://`);
}

/// Persisted state outlives the engine that wrote it: a session tab or a
/// history row stored under one scheme is unloadable under the other, so a
/// stored extension URL is retargeted on read. Ids and paths are identical
/// across schemes, so only the prefix moves.
export function retargetExtensionUrl(url: string): string {
  const scheme = extensionScheme();
  for (const other of [WEBKIT_SCHEME, CHROMIUM_SCHEME]) {
    if (other !== scheme && url.startsWith(`${other}://`)) return `${scheme}://${url.slice(other.length + 3)}`;
  }
  return url;
}
