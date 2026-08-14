import { describe, expect, test } from "bun:test";
import { toNdAccelerator, webStoreId } from "./host.ts";
import { hostWarning, permissionWarnings } from "./permissions.ts";

describe("permissionWarnings", () => {
  test("Dark Reader's MV2 set warns about all sites and about tabs", () => {
    expect(permissionWarnings(["alarms", "fontSettings", "storage", "tabs"], ["<all_urls>"])).toEqual([
      "Read and change all your data on all websites",
      "Access browser tabs",
    ]);
  });

  test("Dark Reader's MV3 set warns only about host access", () => {
    expect(permissionWarnings(["alarms", "fontSettings", "scripting", "storage"], ["*://*/*"])).toEqual([
      "Read and change all your data on all websites",
    ]);
  });

  test("host access comes first, however the permissions are ordered", () => {
    const warnings = permissionWarnings(["tabs", "downloads"], ["<all_urls>"]);
    expect(warnings[0]).toBe("Read and change all your data on all websites");
  });

  test("an extension that asks for nothing visible warns about nothing", () => {
    expect(permissionWarnings(["storage", "alarms", "activeTab"], [])).toEqual([]);
  });

  test("a duplicated warning is listed once", () => {
    expect(permissionWarnings(["history", "history"], [])).toEqual(["Read and change your browsing history"]);
  });
});

describe("hostWarning", () => {
  test("one wildcard host swallows the narrower ones", () => {
    expect(hostWarning(["https://a.test/*", "<all_urls>"])).toBe("Read and change all your data on all websites");
  });

  test("named hosts are counted, and a domain wildcard reads as the domain", () => {
    expect(hostWarning(["https://*.example.com/*"])).toBe("Read and change your data on example.com");
    expect(hostWarning(["https://a.test/*", "https://b.test/*"])).toBe("Read and change your data on a.test and b.test");
    expect(hostWarning(["https://a.test/*", "https://b.test/*", "https://c.test/*"])).toBe(
      "Read and change your data on 3 websites",
    );
  });

  test("no host permissions means no host warning", () => {
    expect(hostWarning([])).toBeNull();
  });
});

describe("toNdAccelerator", () => {
  test("Chrome's Ctrl is the platform's primary modifier", () => {
    expect(toNdAccelerator("Ctrl+Shift+X")).toBe("primary+shift+x");
    expect(toNdAccelerator("Command+K")).toBe("primary+k");
  });

  test("Alt and Shift pass through, and the key is lowercased", () => {
    expect(toNdAccelerator("Alt+Shift+D")).toBe("alt+shift+d");
    expect(toNdAccelerator("Alt+Shift+A")).toBe("alt+shift+a");
  });

  test("named keys keep the framework's spelling", () => {
    expect(toNdAccelerator("Ctrl+Comma")).toBe("primary+comma");
    expect(toNdAccelerator("Alt+Up")).toBe("alt+Up");
  });

  test("a shortcut with no modifier or no key is refused", () => {
    expect(toNdAccelerator("D")).toBeNull();
    expect(toNdAccelerator("Ctrl+Alt")).toBeNull();
    expect(toNdAccelerator("")).toBeNull();
  });
});

describe("webStoreId", () => {
  test("takes the id out of a store URL", () => {
    const id = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
    expect(webStoreId(`https://chromewebstore.google.com/detail/dark-reader/${id}`)).toBe(id);
    expect(webStoreId(`https://chrome.google.com/webstore/detail/${id}`)).toBe(id);
  });

  test("accepts a bare id", () => {
    expect(webStoreId("  eimadpbcbfnmbkopoojfekhnkhdbieeh  ")).toBe("eimadpbcbfnmbkopoojfekhnkhdbieeh");
  });

  test("rejects anything that is not a store id", () => {
    expect(webStoreId("https://example.com/detail/not-an-id")).toBeNull();
    expect(webStoreId("dark reader")).toBeNull();
    // z is outside the a-p alphabet Chrome ids use.
    expect(webStoreId("z".repeat(32))).toBeNull();
  });
});
