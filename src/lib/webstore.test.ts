import { expect, test } from "bun:test";

import { parseStoreRequest, permissionLines } from "./webstore.ts";

test("a store request names a real extension id", () => {
  const id = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  expect(parseStoreRequest(JSON.stringify({ id, name: "1Password", iconUrl: "", manifest: "{}" }))?.name).toBe("1Password");
  expect(parseStoreRequest(JSON.stringify({ id: "../x", name: "x" }))).toBeNull();
  expect(parseStoreRequest("not json")).toBeNull();
});

test("the prompt says what Chrome's says", () => {
  const all = JSON.stringify({ permissions: ["tabs", "storage", "nativeMessaging", "webNavigation"], host_permissions: ["<all_urls>"] });
  expect(permissionLines(all)).toEqual([
    "Read and change all your data on all websites",
    "Read your browsing history",
    "Communicate with cooperating native applications",
  ]);
  const some = JSON.stringify({ content_scripts: [{ matches: ["https://*.example.com/*", "https://a.test/*"] }] });
  expect(permissionLines(some)).toEqual(["Read and change your data on example.com and a.test"]);
  expect(permissionLines(JSON.stringify({ permissions: ["storage"] }))).toEqual([]);
  expect(permissionLines("{")).toEqual([]);
});
