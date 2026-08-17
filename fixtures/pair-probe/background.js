// Answers the content script and counts the round trips in chrome.storage, so
// the drive can check the result twice: in the page's isolated world, and on
// disk under this extension's own id. A ping counted under someone else's id
// is what cross-talk between two installed extensions looks like.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.k !== "ping") return;
  chrome.storage.local.get("pings", function (stored) {
    var n = ((stored && stored.pings) || 0) + 1;
    chrome.storage.local.set({ pings: n, lastUrl: message.url || "" }, function () {
      sendResponse({ pong: chrome.runtime.id, n: n });
    });
  });
  return true;
});

// A real chrome.contextMenus registration: a parent with two children, one of
// them a checkbox, and one link-only item with a target pattern. That is the
// whole shape a browser has to carry (nesting, item types, per-hit filtering),
// and the drive asserts both the model the broker keeps and the
// info a click delivers.
chrome.contextMenus.create({ id: "pair-parent", title: "Pair Probe tools", contexts: ["all"] });
chrome.contextMenus.create({
  id: "pair-open",
  parentId: "pair-parent",
  title: "Pair: run the probe",
  contexts: ["all"],
});
chrome.contextMenus.create({
  id: "pair-sticky",
  parentId: "pair-parent",
  type: "checkbox",
  checked: false,
  title: "Pair: sticky",
  contexts: ["all"],
});
chrome.contextMenus.create({
  id: "pair-link",
  title: "Pair: only local links",
  contexts: ["link"],
  targetUrlPatterns: ["*://127.0.0.1/*"],
});

chrome.contextMenus.onClicked.addListener(function (info) {
  chrome.storage.local.set({
    lastMenu: [
      info.menuItemId,
      info.parentMenuItemId || "",
      info.checked === true,
      info.wasChecked === true,
      info.pageUrl || "",
    ].join("|"),
  });
});
