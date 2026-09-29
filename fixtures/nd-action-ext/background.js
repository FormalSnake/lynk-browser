// The shape 1Password ships: the manifest declares a popup, and the extension
// turns it off at runtime so that a toolbar click reaches onClicked instead.
// An app that reads the manifest off disk sees a popup that no longer exists.
chrome.action.setPopup({ popup: "" });
chrome.action.setTitle({ title: "ND Action Runtime" });
chrome.action.setBadgeText({ text: "7" });
chrome.action.setBadgeBackgroundColor({ color: "#d93025" });

// No host permissions: this only reaches the page when the click granted
// activeTab on it, which is what Chrome's toolbar does.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (url) => {
        document.documentElement.dataset.ndActionClicked = url;
      },
      args: [tab.url ?? ""],
    });
  } catch (error) {
    console.error("ND_ACTION_CLICK_FAIL", String(error));
  }
});
