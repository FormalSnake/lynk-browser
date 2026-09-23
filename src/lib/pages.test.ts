import { expect, test } from "bun:test";
import { nativePage } from "./pages.ts";

test("Chromium's own pages map to the app's surfaces", () => {
  expect(nativePage("chrome://downloads")).toBe("downloads");
  expect(nativePage("chrome://downloads/?q=report")).toBe("downloads");
  expect(nativePage("about:downloads")).toBe("downloads");
  expect(nativePage("chrome://newtab/")).toBe("newtab");
  expect(nativePage("chrome://new-tab-page/")).toBe("newtab");
  expect(nativePage("chrome-search://local-ntp/local-ntp.html")).toBe("newtab");
  expect(nativePage("chrome://tab-search.top-chrome/")).toBe("tabSearch");
  expect(nativePage("chrome://history/?q=news")).toBe("history");
  expect(nativePage("chrome://bookmarks/?id=1")).toBe("bookmarks");
});

test("the pages that stay Chromium's are left alone", () => {
  for (const url of ["chrome://settings", "chrome://extensions", "chrome://flags", "chrome://settings/clearBrowserData", "https://downloads.example.com/"]) {
    expect(nativePage(url)).toBeNull();
  }
});
