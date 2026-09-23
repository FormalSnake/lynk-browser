// The shape 1Password ships: the manifest declares a popup, and the extension
// turns it off at runtime so that a toolbar click reaches onClicked instead.
// An app that reads the manifest off disk sees a popup that no longer exists.
chrome.action.setPopup({ popup: "" });
chrome.action.setTitle({ title: "ND Action Runtime" });
chrome.action.setBadgeText({ text: "7" });
chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
