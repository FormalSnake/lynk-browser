import { sendCommand, type NdNodeRef } from "@nativedesktop/react";

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
