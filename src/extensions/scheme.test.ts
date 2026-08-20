import { afterEach, describe, expect, test } from "bun:test";

import {
  CHROMIUM_SCHEME,
  WEBKIT_SCHEME,
  extensionOrigin,
  extensionScheme,
  extensionUrl,
  isExtensionUrl,
  retargetExtensionUrl,
} from "./scheme.ts";

const ID = "aaaabbbbccccddddeeeeffffgggghhhh";

/// The env var IS the engine handshake, so every case here sets it the way the
/// host reads it rather than through an injected parameter.
function onEngine<T>(engine: string | undefined, run: () => T): T {
  const previous = process.env.ND_WEBVIEW_ENGINE;
  if (engine === undefined) delete process.env.ND_WEBVIEW_ENGINE;
  else process.env.ND_WEBVIEW_ENGINE = engine;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.ND_WEBVIEW_ENGINE;
    else process.env.ND_WEBVIEW_ENGINE = previous;
  }
}

afterEach(() => {
  delete process.env.ND_WEBVIEW_ENGINE;
});

describe("the extension origin", () => {
  test("is Chrome's own scheme on a WebKit engine", () => {
    onEngine(undefined, () => {
      expect(extensionScheme()).toBe(WEBKIT_SCHEME);
      expect(extensionOrigin(ID)).toBe(`chrome-extension://${ID}`);
      expect(extensionUrl(ID, "/popup.html")).toBe(`chrome-extension://${ID}/popup.html`);
    });
  });

  test("moves to nbext on Chromium, same id and same path", () => {
    onEngine("chromium", () => {
      expect(extensionScheme()).toBe(CHROMIUM_SCHEME);
      expect(extensionOrigin(ID)).toBe(`nbext://${ID}`);
      expect(extensionUrl(ID, "/popup.html")).toBe(`nbext://${ID}/popup.html`);
    });
  });

  test("an engine name that is not chromium keeps the WebKit scheme", () => {
    onEngine("webkit", () => expect(extensionScheme()).toBe(WEBKIT_SCHEME));
  });

  test("a path without a leading slash gets one", () => {
    onEngine(undefined, () => expect(extensionUrl(ID, "ui/popup/index.html")).toBe(`chrome-extension://${ID}/ui/popup/index.html`));
    onEngine("chromium", () => expect(extensionUrl(ID, "ui/popup/index.html")).toBe(`nbext://${ID}/ui/popup/index.html`));
  });

  test("the default path is the root", () => {
    onEngine(undefined, () => expect(extensionUrl(ID)).toBe(`chrome-extension://${ID}/`));
  });
});

describe("recognizing an extension URL", () => {
  test("covers both schemes whichever engine is running", () => {
    onEngine(undefined, () => {
      expect(isExtensionUrl(`chrome-extension://${ID}/x`)).toBe(true);
      expect(isExtensionUrl(`nbext://${ID}/x`)).toBe(true);
    });
    expect(isExtensionUrl("https://example.com/")).toBe(false);
    expect(isExtensionUrl("about:blank")).toBe(false);
    expect(isExtensionUrl("")).toBe(false);
  });
});

/// Persisted state outlives the engine that wrote it: a session written under
/// one scheme has to load under the other.
describe("retargeting a stored URL", () => {
  test("rewrites the foreign scheme and leaves the id and path alone", () => {
    onEngine("chromium", () => {
      expect(retargetExtensionUrl(`chrome-extension://${ID}/ui/popup/index.html?a=1`)).toBe(
        `nbext://${ID}/ui/popup/index.html?a=1`,
      );
    });
    onEngine(undefined, () => {
      expect(retargetExtensionUrl(`nbext://${ID}/ui/popup/index.html?a=1`)).toBe(
        `chrome-extension://${ID}/ui/popup/index.html?a=1`,
      );
    });
  });

  test("leaves a URL already on this engine's scheme untouched", () => {
    onEngine("chromium", () => expect(retargetExtensionUrl(`nbext://${ID}/x`)).toBe(`nbext://${ID}/x`));
    onEngine(undefined, () =>
      expect(retargetExtensionUrl(`chrome-extension://${ID}/x`)).toBe(`chrome-extension://${ID}/x`),
    );
  });

  test("leaves everything that is not an extension URL alone", () => {
    onEngine("chromium", () => {
      expect(retargetExtensionUrl("https://example.com/")).toBe("https://example.com/");
      expect(retargetExtensionUrl("")).toBe("");
    });
  });
});
