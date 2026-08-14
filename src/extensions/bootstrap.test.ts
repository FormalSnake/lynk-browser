import { describe, expect, test } from "bun:test";

import { bootstrapSource, bridgeHandler, bridgeSurface, type BootstrapConfig } from "./bootstrap.ts";
import { WEBSTORE_HANDLER, WEBSTORE_SURFACE } from "./webstore.ts";

const ID_A = "aaaabbbbccccddddeeeeffffgggghhhh";
const ID_B = "iiiijjjjkkkkllllmmmmnnnnooooppph";

function config(extensionId: string): BootstrapConfig {
  return {
    extensionId,
    kind: "content",
    baseUrl: `chrome-extension://${extensionId}`,
    manifest: { name: "Fixture", version: "1.0.0" },
    messages: {},
    uiLocale: "en",
    commands: [],
    granted: [],
  };
}

/// The whole two-extension case rests on this: a script-message handler name
/// is per view on both engines, so a name shared by two worlds takes one of
/// them down. Nothing else in the app can catch a regression here without two
/// extensions actually installed.
describe("the bridge handler name", () => {
  test("is distinct per surface, and says which surface it belongs to", () => {
    expect(bridgeHandler(ID_A)).not.toBe(bridgeHandler(ID_B));
    expect(bridgeSurface(bridgeHandler(ID_A))).toBe(ID_A);
    expect(bridgeSurface(bridgeHandler(ID_B))).toBe(ID_B);
  });

  test("the store hook is one of these names, not an exception to them", () => {
    expect(WEBSTORE_HANDLER).toBe(bridgeHandler(WEBSTORE_SURFACE));
    expect(bridgeSurface(WEBSTORE_HANDLER)).toBe(WEBSTORE_SURFACE);
    expect(WEBSTORE_HANDLER).not.toBe(bridgeHandler(ID_A));
  });

  test("a name the app did not mint is not claimed", () => {
    expect(bridgeSurface("ndwebstore")).toBeNull();
    expect(bridgeSurface("__ndInternal")).toBeNull();
    expect(bridgeSurface("")).toBeNull();
  });
});

describe("the injected shim", () => {
  test("posts to its own extension's handler and no other", () => {
    const source = bootstrapSource(config(ID_A));
    expect(source).toContain(bridgeHandler(ID_A));
    expect(source).not.toContain(bridgeHandler(ID_B));
    expect(() => new Function(source)).not.toThrow();
  });
});
