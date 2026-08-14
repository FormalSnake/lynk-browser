// The Chrome Web Store's own "Add to Chrome" button, wired to the app's install
// flow. Nothing here installs anything: it turns a click on a page the app does
// not control into the same `{id}` the store dialog already produces, and the
// broker takes it from there.
//
// Three pieces, in the order they matter:
//   1. a user agent the store will serve its install UI to at all,
//   2. a hook script scoped to that one origin, which finds the control and
//      intercepts its activation,
//   3. the message it sends the broker, re-validated on arrival.
//
// The live store is unreachable from the offline test box, so `fixtures/
// webstore-listing/index.html` stands in for its markup and everything about
// the REAL store is manually verifiable only: open a listing, confirm the
// install UI renders, click it, confirm the permission prompt is the app's.
import { bridgeHandler } from "./bootstrap.ts";

/** The one origin any of this applies to, as a WebKit allow-list pattern. */
export const WEBSTORE_MATCH = "https://chromewebstore.google.com/*";

/// Stands in for an extension id: it names the hook's content world and its
/// handler, and `handleScriptMessage` routes on seeing it. A Chrome id is 32
/// letters from a-p, so this cannot collide with one.
export const WEBSTORE_SURFACE = "__webstore";

/// Its own handler name, minted the same way an extension's is: a name is per
/// view on both engines, so the hook sharing one with an extension would take
/// that extension's bus down. See `bridgeHandler`.
export const WEBSTORE_HANDLER = bridgeHandler(WEBSTORE_SURFACE);

/// Claimed to the store twice: in the user agent a listing sniffs, and in the
/// `prodversion` the CRX endpoint is asked for. One number, because a listing
/// that believes it is talking to Chrome 124 while the download asks for
/// something else is the kind of drift nobody notices until an extension
/// declares a `minimum_chrome_version`.
export const CHROME_VERSION = 124;

/// The store serves a different page to a non-Chrome user agent, with no
/// install control on it at all, so the hook has nothing to find without this.
export function chromeUserAgent(platform: string = process.platform): string {
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;
}

export function isWebstoreUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "chromewebstore.google.com";
  } catch {
    return false;
  }
}

/// The extension id, read from the listing URL rather than the DOM: the store's
/// own path is the stable contract, the markup around it is not. Deliberately
/// stricter than `webStoreId` in the broker, which parses whatever a user
/// pastes into the store dialog. This one only accepts an address the hook
/// could actually have been running on.
///
/// Embedded into the hook by source text: no module-scope references.
export function webstoreListingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "chromewebstore.google.com") return null;
  const match = /\/detail\/(?:[^/]+\/)?([a-p]{32})(?:\/|$)/.exec(parsed.pathname);
  return match ? match[1]! : null;
}

/// The slice of `Element` the matcher reads. A real DOM element satisfies this
/// as it stands, which is what lets the test drive the same code over parsed
/// fixture markup instead of a browser.
export interface ControlNode {
  readonly localName: string;
  readonly textContent: string | null;
  readonly parentElement: ControlNode | null;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
}

/// Independent readings of one element. No single one identifies the install
/// button, which is the point: the store's markup drifts, and a hook pinned to
/// one selector is a hook that silently stops working.
export interface ControlSignals {
  /** Something that can be activated at all: a button, or a thing wearing the role. */
  activatable: boolean;
  /** The accessible name, lowercased and whitespace-collapsed. */
  label: string;
  /** The element carries one of the store's own scripting hooks. */
  storeHook: boolean;
  /** An ancestor looks like the listing this control belongs to. */
  inListing: boolean;
  disabled: boolean;
}

/// Embedded into the hook by source text: no module-scope references.
export function installControlSignals(element: ControlNode): ControlSignals {
  const hooks = ["jsaction", "jsname", "jscontroller", "data-item-id", "data-extension-id"];
  const listingMarkers = ["itemtype", "data-item-id", "data-extension-id"];
  const names = element.getAttributeNames().map((name) => name.toLowerCase());
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  const label = (element.getAttribute("aria-label") ?? element.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  let inListing = false;
  let up = element.parentElement;
  for (let hops = 0; up && hops < 12 && !inListing; hops++) {
    const upNames = up.getAttributeNames().map((name) => name.toLowerCase());
    inListing =
      up.localName === "main" ||
      (up.getAttribute("role") ?? "").toLowerCase() === "main" ||
      listingMarkers.some((marker) => upNames.includes(marker));
    up = up.parentElement;
  }

  return {
    activatable: element.localName === "button" || role === "button",
    label,
    storeHook: hooks.some((hook) => names.includes(hook)),
    inListing,
    disabled: element.getAttribute("disabled") !== null || element.getAttribute("aria-disabled") === "true",
  };
}

/// An install label plus at least one corroborating signal. A control that only
/// reads right, or only sits in the right place, is not enough.
export const INSTALL_SCORE_THRESHOLD = 4;

/// Embedded into the hook by source text: no module-scope references.
export function scoreInstallControl(signals: ControlSignals): number {
  if (!signals.activatable || signals.disabled) return 0;
  let score = 0;
  // Anchored, so the store's post-install "Remove from Chrome" cannot match.
  // A localized listing says something else entirely and scores nothing, which
  // is the fail-closed half of the deal: the store dialog still installs by URL.
  if (/^add to [a-z]+$/.test(signals.label) || signals.label === "install") score += 3;
  if (signals.storeHook) score += 1;
  if (signals.inListing) score += 1;
  return score;
}

export function isInstallControl(element: ControlNode): boolean {
  return scoreInstallControl(installControlSignals(element)) >= INSTALL_SCORE_THRESHOLD;
}

export interface WebstoreInstallMessage {
  k: "webstoreInstall";
  id: string;
  name: string;
}

/// Embedded into the hook by source text: no module-scope references.
export function webstoreInstallMessage(id: string, name: string): WebstoreInstallMessage {
  return { k: "webstoreInstall", id: id, name: name };
}

/// The same message as the broker must treat it: from a world the app owns, but
/// read off a page it does not. The id is re-validated rather than trusted,
/// because everything past this point downloads whatever it is handed.
export function parseWebstoreInstall(body: unknown): WebstoreInstallMessage | null {
  if (!body || typeof body !== "object") return null;
  const env = body as Record<string, unknown>;
  if (env.k !== "webstoreInstall") return null;
  const id = typeof env.id === "string" ? env.id : "";
  if (!/^[a-p]{32}$/.test(id)) return null;
  return { k: "webstoreInstall", id, name: typeof env.name === "string" ? env.name : "" };
}

/// The hook itself, as source injected into the store origin and nothing else.
///
/// The four functions above ship into the page by their own source text, which
/// is why each stands alone: a reference to anything at module scope compiles
/// here and is undefined there. `chrome.scripting.executeScript` imposes the
/// same discipline on an injected `func`, and the test asserts the result still
/// parses and still names them.
export function webstoreHookSource(): string {
  return `(function(){
${webstoreListingId.toString()}
${installControlSignals.toString()}
${scoreInstallControl.toString()}
${webstoreInstallMessage.toString()}
var THRESHOLD = ${INSTALL_SCORE_THRESHOLD};

function bridge() {
  var handlers = window.webkit && window.webkit.messageHandlers;
  return (handlers && handlers[${JSON.stringify(WEBSTORE_HANDLER)}]) || null;
}

// A click lands on whatever is painted under the pointer, usually a span inside
// the control, so the match walks up a few levels before giving up.
function controlFor(target) {
  for (var el = target, hops = 0; el && hops < 5; el = el.parentElement, hops++) {
    if (el.nodeType !== 1) continue;
    if (scoreInstallControl(installControlSignals(el)) >= THRESHOLD) return el;
  }
  return null;
}

// Nothing is prevented until the message is certain to be sendable: an
// unrecognized page, an unrecognized control or a missing bridge all leave the
// event exactly as the store dispatched it.
function intercept(event) {
  var id = webstoreListingId(location.href);
  if (!id) return;
  if (!controlFor(event.target)) return;
  var handler = bridge();
  if (!handler) return;
  event.preventDefault();
  event.stopPropagation();
  handler.postMessage(webstoreInstallMessage(id, (document.title || "").trim()));
}

// Capture on window runs before any delegated listener the store installs
// further down the tree, which is the only place the store's own handler can be
// cut off without knowing anything about it.
window.addEventListener("click", intercept, true);
window.addEventListener("keydown", function (event) {
  if (event.key === "Enter" || event.key === " ") intercept(event);
}, true);
})();`;
}
