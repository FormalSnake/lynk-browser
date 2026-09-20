// The gate drives this service worker over CDP. Everything it needs is hung off
// globalThis because Runtime.evaluate has no other way to reach extension APIs.
globalThis.ndOpenWindow = () => chrome.windows.create({ url: "about:blank" });
globalThis.ndOpenTab = () => chrome.tabs.create({ url: "about:blank" });
globalThis.ndOpenOptions = () => chrome.runtime.openOptionsPage();
globalThis.ndWrite = (value) => chrome.storage.local.set({ ndGate: value });
globalThis.ndRead = () => chrome.storage.local.get("ndGate").then((r) => r.ndGate ?? "");
globalThis.ndReadMenu = () => chrome.storage.local.get("ndMenu").then((r) => r.ndMenu ?? "");
globalThis.ndClearMenu = () => chrome.storage.local.remove("ndMenu");

// A parent with children so the host has an extension submenu to render, not
// just a leaf. Chromium only merges these into a page's context menu when the
// extension declares the contextMenus permission.
function ndCreateMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "nd-ext-root", title: "ND Gate Menu", contexts: ["all"] });
    chrome.contextMenus.create({ id: "nd-ext-one", parentId: "nd-ext-root", title: "Gate Item One", contexts: ["all"] });
    chrome.contextMenus.create({ id: "nd-ext-two", parentId: "nd-ext-root", title: "Gate Item Two", contexts: ["all"] });
  });
}

chrome.runtime.onInstalled.addListener(ndCreateMenus);
chrome.runtime.onStartup.addListener(ndCreateMenus);
ndCreateMenus();

chrome.contextMenus.onClicked.addListener((info) => {
  chrome.storage.local.set({ ndMenu: String(info.menuItemId) });
});
