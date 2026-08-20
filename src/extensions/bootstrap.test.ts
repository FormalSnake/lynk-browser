import { describe, expect, test } from "bun:test";

import { bootstrapSource, bridgeHandler, bridgeSurface, type BootstrapConfig } from "./bootstrap.ts";
import { WEBSTORE_HANDLER, WEBSTORE_SURFACE } from "./webstore.ts";

const ID_A = "aaaabbbbccccddddeeeeffffgggghhhh";
const ID_B = "iiiijjjjkkkkllllmmmmnnnnooooppph";

function config(extensionId: string, scheme = "chrome-extension"): BootstrapConfig {
  return {
    extensionId,
    kind: "content",
    baseUrl: `${scheme}://${extensionId}`,
    scheme,
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

/// getURL is the one place an extension sees which scheme it was served from,
/// so it has to answer on the engine's own origin whichever that is.
describe("runtime.getURL", () => {
  test("resolves a path against the extension's origin on either scheme", () => {
    for (const scheme of ["chrome-extension", "nbext"]) {
      const { chrome } = runShim("background", ID_A, scheme);
      expect(chrome.runtime.getURL("ui/popup.html")).toBe(`${scheme}://${ID_A}/ui/popup.html`);
      expect(chrome.runtime.getURL("/ui/popup.html")).toBe(`${scheme}://${ID_A}/ui/popup.html`);
      expect(chrome.runtime.getURL("")).toBe(`${scheme}://${ID_A}/`);
      expect(chrome.runtime.getURL(`${scheme}://${ID_A}/already.html`)).toBe(`${scheme}://${ID_A}/already.html`);
    }
  });

  test("an extension that hardcodes chrome-extension:// still reaches the served origin", () => {
    const { chrome } = runShim("background", ID_A, "nbext");
    expect(chrome.runtime.getURL(`chrome-extension://${ID_A}/ui/popup.html`)).toBe(`nbext://${ID_A}/ui/popup.html`);
  });
});

interface Envelope {
  k: string;
  id?: string;
  token?: string;
}

/// Runs the shim against stand-in globals. Everything it reaches for is a
/// named parameter, so the real global object is never written to and one
/// run cannot see another's.
function runShim(kind: BootstrapConfig["kind"], id = ID_A, scheme = "chrome-extension") {
  const posted: Envelope[] = [];
  const timers: (() => void)[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const fakeGlobal: Record<string, unknown> = {};
  const win: Record<string, unknown> = {
    webkit: { messageHandlers: { [bridgeHandler(id)]: { postMessage: (e: Envelope) => posted.push(e) } } },
    frames: [],
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      (listeners[name] ??= []).push(fn);
    },
  };
  win.top = win;
  win.parent = win;

  const run = new Function(
    "globalThis",
    "window",
    "document",
    "location",
    "setTimeout",
    bootstrapSource({ ...config(id, scheme), kind }),
  );
  run(
    fakeGlobal,
    win,
    { readyState: "loading" },
    { href: `${scheme}://${id}/background.html` },
    (fn: () => void) => timers.push(fn),
  );

  const token = String(posted[0]?.token);
  const deliver = (env: Record<string, unknown>): void => {
    (fakeGlobal.__ndext as { deliver: (e: Record<string, unknown>) => void }).deliver(env);
  };
  // The broker's answer to `hello`, which is what releases the send queue.
  deliver({ k: "ready", to: token, frameId: 0, documentId: "d0", tabId: -1 });
  return {
    posted,
    deliver,
    chrome: fakeGlobal.chrome as {
      runtime: { getURL: (path: string) => string };
      storage: { local: { get: (keys: unknown) => Promise<unknown> } };
    },
    idles: (): Envelope[] => posted.filter((e) => e.k === "idle"),
    load: () => (listeners.load ?? []).forEach((fn) => fn({})),
    /// Drains one task's worth of timers. That boundary is what the startup
    /// gate is defined against: a request settling queues its caller's next
    /// request as a MICROTASK, so anything checked before the next task sees a
    /// gap that is not really idle.
    tick: () => timers.splice(0).forEach((fn) => fn()),
  };
}

/// The gate that keeps a tab from committing before the extension it belongs
/// to can answer. `load` is not that moment: an extension's own startup runs
/// after it, and a content script that connects inside that window gets an
/// answer nobody retries.
describe("the background startup gate", () => {
  test("reports idle after load, and not before", () => {
    const shim = runShim("background");
    shim.tick();
    expect(shim.idles()).toHaveLength(0);

    shim.load();
    expect(shim.posted.some((e) => e.k === "loaded")).toBe(true);
    // Same task as `load`: the extension has not had a turn yet.
    expect(shim.idles()).toHaveLength(0);
    shim.tick();
    expect(shim.idles()).toHaveLength(1);
  });

  test("an outstanding chrome.* call holds it until it is answered", () => {
    const shim = runShim("background");
    shim.load();
    void shim.chrome.storage.local.get("anything");
    const call = shim.posted.find((e) => e.k === "call");
    expect(call?.id).toBeTruthy();

    shim.tick();
    expect(shim.idles()).toHaveLength(0);

    shim.deliver({ k: "ret", to: shim.posted[0]?.token, id: call?.id, ok: true, value: {} });
    shim.tick();
    expect(shim.idles()).toHaveLength(1);
  });

  test("a content script never reports idle", () => {
    const shim = runShim("content");
    shim.load();
    shim.tick();
    expect(shim.idles()).toHaveLength(0);
  });
});
