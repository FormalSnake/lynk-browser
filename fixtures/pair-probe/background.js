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
