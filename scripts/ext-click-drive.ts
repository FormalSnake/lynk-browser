#!/usr/bin/env bun
// Extension actions against the real engine, through the sidebar's Extensions
// panel, on macOS and Linux.
//
//   macOS: ND_HOST_BINARY=<NDShellDev.app/Contents/MacOS/NDShell> bun scripts/ext-click-drive.ts
//          (holds the mac CEF gate lock, moves the real cursor)
//   Linux: inside scripts/headless.sh, with ND_HOST_BINARY and ND_CEF_* as for
//          browser-drive.ts; ND_CEF_VIEWS_HOSTED=1 for the onClicked click.
//
// Two fixtures: `nd-action-ext` declares a popup and switches it off at
// runtime, the way 1Password does before it is set up, so its click has to be
// Chrome's (`action.onClicked` with the tab on show and an `activeTab` grant,
// which the fixture proves by marking the page with no host permissions), and
// `nd-test-ext` has a popup, which has to open in the app's own popover. Then
// the popup extension is removed through the app's confirmation (answered by
// ND_AUTOMATION_DIALOG_SCRIPT: Cancel, then Remove), and Chromium must not ask
// again. On macOS every leg also checks that no window outside the app's came
// up. Captures of the panel and the popup at the window's width and at 720 px
// land in screenshots/ext-<platform>-*.png.
//
// Where the engine cannot run onClicked (Linux without the Views-hosted
// embedding) the click opens the extension's setup page instead, and the leg
// says so rather than failing.
//
// NB_EXT_CLICK_REAL names an unpacked copy of a real extension (1Password) to
// click in place of the popup fixture; the leg reports what the click did.
// Marker: NB_EXT_CLICK_OK.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

import { NDSHOT, SHOTS, fail, ndshotWindows, step, walk, type NdshotWindow } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const MAC = process.platform === "darwin";
const PLATFORM = MAC ? "appkit" : "gtk";
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
const real = process.env.NB_EXT_CLICK_REAL ?? "";
const realName = process.env.NB_EXT_CLICK_REAL_NAME ?? "1Password";
const FRAMEWORK_EXTENSION = "pfbmaghgajhpjaobhbamhamgbcelckhd";
const RUN = mkdtempSync(join(tmpdir(), "nb-ext-click-"));
mkdirSync(SHOTS, { recursive: true });

// Page state on macOS is read over CDP: webviewEval does not reach a Chromium
// view on AppKit. launchApp passes no arguments, so the port rides a wrapper
// that execs the host (same pid, same bundle path). app.cursor runs the same
// binary as its input helper (`--nd-input`), whose arguments stay untouched.
const CDP_PORT = Number(process.env.ND_CEF_DEBUG_PORT ?? 9491);
let hostBinary: string | undefined;
if (MAC) {
  const bundled = process.env.ND_HOST_BINARY ?? fail("set ND_HOST_BINARY to a bundled CEF host");
  hostBinary = join(RUN, "host.sh");
  writeFileSync(
    hostBinary,
    `#!/bin/sh\ncase "$1" in --nd-*) exec "${bundled}" "$@" ;; esac\nexec "${bundled}" --remote-debugging-port=${CDP_PORT} "$@"\n`,
  );
  chmodSync(hostBinary, 0o755);
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    return new Response(
      `<!doctype html><title>Page ${key}</title><h1>${key}</h1>` +
        `<form><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"></form>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

mkdirSync(join(RUN, "store"), { recursive: true });
writeFileSync(
  join(RUN, "store", "settings.json"),
  JSON.stringify({ version: 1, data: { restoreOnLaunch: false, homepage: `${base}/action` } }),
);

const lines: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  ...(MAC ? { backend: "appkit" as const, hostBinary } : {}),
  cwd: ROOT,
  env: {
    NB_STORE_DIR: join(RUN, "store"),
    NB_TEST_HOOKS: "1",
    ND_WEBVIEW_ENGINE: "chromium",
    ND_CEF_STYLE: "chrome",
    ...(MAC ? { ND_CEF_CACHE: join(RUN, "cef"), ND_APP_ID: "dev.nativebrowser.extclick" } : {}),
    NB_TEST_EXT_ACTION: resolve(ROOT, "fixtures/nd-action-ext"),
    NB_TEST_EXT: real || resolve(ROOT, "fixtures/nd-test-ext"),
    ND_AUTOMATION_DIALOG_SCRIPT: JSON.stringify({ "window.showAlert": [{ buttonId: "cancel" }, { buttonId: "remove" }] }),
  },
  readyTimeoutMs: 60_000,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => lines.push(line),
});

// ---- page state ----------------------------------------------------------------

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function cdpEval(match: (t: Target) => boolean, expression: string): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Target[];
  const target = list.find(match);
  if (!target) return "";
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => {
      ws.onmessage = (e) => r(JSON.parse(String(e.data)));
    });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    const m = await Promise.race([answer, Bun.sleep(5_000).then(() => ({}) as { result?: { result?: { value?: unknown } } })]);
    return String(m.result?.result?.value ?? "");
  } finally {
    ws.close();
  }
}

async function nodeEval(testId: string | ((id: string) => boolean), code: string): Promise<string> {
  const node = (await nodes()).find((n) => (typeof testId === "string" ? n.testID === testId : testId(n.testID ?? "")) && n.visible);
  if (!node) return "";
  const answer = await app.rpc.call("webviewEval", { ref: node.ref, code, timeoutMs: 5_000 });
  return answer.ok ? String(answer.value ?? "") : "";
}

async function pageEval(code: string): Promise<string> {
  if (MAC) return cdpEval((t) => t.type === "page" && t.url.startsWith(`${base}/action`), code).catch(() => "");
  return nodeEval((id) => id.startsWith("page-") && id !== "page-stack", code);
}

async function popupEval(id: string, code: string): Promise<string> {
  if (MAC) return cdpEval((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${id}/`), code).catch(() => "");
  return nodeEval(`ext-popup-view-${id}`, code);
}

// ---- helpers -----------------------------------------------------------------

async function poll<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = PATIENCE): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    await Bun.sleep(150);
    last = await read();
  }
  return last;
}

async function nodes(): Promise<JsonNode[]> {
  const out: JsonNode[] = [];
  walk((await app.tree()).root, (n) => out.push(n));
  return out;
}

async function clickWhenReady(testId: string): Promise<void> {
  await poll(`${testId} to take a click`, () => app.click(testId).then(() => true, () => false), (ok) => ok);
}

/// A real pointer click where there is one (macOS), the automation click
/// elsewhere.
async function press(testId: string): Promise<void> {
  if (MAC) await app.cursor.click(app.getByTestId(testId));
  else await clickWhenReady(testId);
}

async function rows(): Promise<{ id: string; name: string }[]> {
  return (await nodes())
    .filter((n) => n.testID?.startsWith("ext-row-"))
    .map((n) => ({ id: n.testID!.slice("ext-row-".length), name: n.text ?? "" }));
}

async function rowFor(name: string): Promise<string> {
  return poll(
    `a registry row for ${name}`,
    async () => (await rows()).find((r) => r.name.startsWith(name))?.id ?? "",
    (v) => v !== "",
    90_000,
  );
}

async function tabCount(): Promise<number> {
  return (await nodes()).filter((n) => /^tab-(?!slot-|live-|spinner-|drop)[^-]+$/.test(n.testID ?? "")).length;
}

function appWindows(): NdshotWindow[] {
  return MAC ? ndshotWindows(app.pid) : [];
}

/// The app's own window is the largest; everything else it may show is a
/// popover or a panel over it. A Chromium window would sit outside it.
function strayWindows(): NdshotWindow[] {
  const [main, ...rest] = appWindows();
  if (!main) return [];
  return rest.filter(
    (w) => w.x + w.width < main.x || w.x > main.x + main.width || w.y + w.height < main.y || w.y > main.y + main.height,
  );
}

/// The window with whatever popover or panel is up on it.
function shot(name: string): void {
  const out = `${SHOTS}/ext-${PLATFORM}-${name}.png`;
  if (MAC) {
    const main = appWindows()[0] ?? fail("ndshot sees no window for the app");
    const run = Bun.spawnSync(["timeout", "30", NDSHOT, "capture", "--out", out, "--window-id", String(main.windowID), "--region"]);
    if (run.exitCode !== 0) fail(`ndshot capture failed: ${run.stderr.toString().trim()}`);
  } else {
    if (!process.env.DISPLAY) return;
    Bun.spawnSync(["import", "-window", "root", "-silent", out]);
  }
  console.log(`  shot ${out}`);
}

async function panelShown(): Promise<boolean> {
  return !!(await app.find("extensions-panel"))?.visible;
}

async function openPanel(): Promise<void> {
  if (!(await panelShown())) await clickWhenReady("extensions-button");
  await poll("the panel to show", panelShown, (shown) => shown);
}

async function closePanel(): Promise<void> {
  if (await panelShown()) await clickWhenReady("extensions-button");
  await poll("the panel to close", async () => !(await panelShown()), (gone) => gone);
}

function noStrayWindow(when: string): void {
  const stray = strayWindows();
  if (stray.length > 0) fail(`${when}, a window outside the app came up: ${JSON.stringify(stray)}`);
}

const WIDTHS: [string, number][] = [
  ["normal", 1200],
  ["720", 720],
];

try {
  await poll("the page", () => pageEval("location.href"), (href) => href.includes("/action"), 60_000);
  const windowsAtStart = appWindows().length;

  // 1. The registry reaches the panel: both fixtures listed, the framework's
  //    own extension not. One install at a time: an install parks its path on
  //    the registry view until Chromium's directory chooser asks for it.
  const { action, other } = await step("1. registry rows", async () => {
    await openPanel();
    await clickWhenReady("extensions-install-action-test");
    const action = await rowFor("ND Action Extension");
    await openPanel();
    await clickWhenReady("extensions-install-test");
    const other = await rowFor(real ? realName : "NB Test Extension");
    const listed = await rows();
    if (listed.some((r) => r.id === FRAMEWORK_EXTENSION)) fail("the framework's own extension is listed");
    if (listed.length !== 2) fail(`want 2 rows, got ${JSON.stringify(listed)}`);
    for (const [label, width] of WIDTHS) {
      await app.setWindowSize(width, 760);
      await Bun.sleep(700);
      await openPanel();
      await Bun.sleep(400);
      shot(`panel-${label}`);
    }
    await app.setWindowSize(1200, 760);
    console.log(`1. registry lists ${listed.map((r) => r.name).join(", ")} (framework extension filtered)`);
    return { action, other };
  });

  // 2. A click on an action whose popup was switched off: onClicked with the
  //    tab on show and activeTab on it, on the pinned button.
  await step("2. onClicked + activeTab", async () => {
    await openPanel();
    await clickWhenReady(`ext-pin-toggle-${action}`);
    await closePanel();
    await app.waitFor({ testId: `ext-action-${action}`, state: "present" }, { timeoutMs: PATIENCE });
    const before = await tabCount();
    await press(`ext-action-${action}`);
    const trigger = await poll(
      "the click to reach the engine",
      async () => lines.find((l) => l.includes("ND_APP ACTION_TRIGGER ") && l.includes(`id=${action}`)) ?? "",
      (l) => l !== "",
    );
    if (!trigger.trimEnd().endsWith(" ok")) {
      if (MAC) fail(`the engine refused the click: ${trigger}`);
      await poll("the setup page instead", tabCount, (n) => n === before + 1);
      console.log(`2. the engine cannot run onClicked here (${trigger.slice(trigger.indexOf("ND_APP"))}); the setup page opened`);
      return;
    }
    const mark = await poll(
      "onClicked to mark the page through activeTab",
      () => pageEval("document.documentElement.dataset.ndActionClicked || ''"),
      (m) => m.includes("/action"),
    );
    await Bun.sleep(1000);
    if ((await tabCount()) !== before) fail("the click opened a tab as well");
    noStrayWindow("after the click");
    shot("clicked");
    console.log(`2. the click ran onClicked with activeTab: page marked ${JSON.stringify(mark)}`);
  });

  // 3. An action with a popup: the popup renders in the app's own popover,
  //    anchored under the Extensions button, and nowhere else.
  // A real extension decides for itself whether it has a popup (1Password
  // has none until an account is set up), so leg 4 clicks it instead.
  if (!real) await step("3. popup in the app's popover", async () => {
    for (const [label, width] of WIDTHS) {
      await app.setWindowSize(width, 760);
      await Bun.sleep(700);
      await openPanel();
      await press(`ext-row-${other}`);
      await app.waitFor({ testId: `ext-popup-view-${other}`, state: "present" }, { timeoutMs: PATIENCE });
      const text = await poll(
        "the popup to render",
        () => popupEval(other, "document.body ? document.body.innerText.trim() : ''"),
        (t) => real !== "" || t.length > 0,
      );
      await Bun.sleep(1500);
      noStrayWindow("with the popup open");
      const body = (await app.find(`ext-popup-body-${other}`))?.geometry;
      shot(`popup-${label}`);
      console.log(`3. popup (${label}) in the app's popover, ${body?.w}x${body?.h}: ${JSON.stringify(text.slice(0, 40))}`);
      await clickWhenReady("extensions-button");
      await poll("the popup to close", async () => !(await app.find(`ext-popup-view-${other}`)), (gone) => gone).catch(() => {});
      await closePanel().catch(() => {});
    }
    await app.setWindowSize(1200, 760);
  });

  // 4. Removal: the app asks, Cancel keeps it, Remove removes it, and
  //    Chromium asks nothing.
  if (!real) {
    await step("4. uninstall through the app's confirmation", async () => {
      // The extension's own page from its install, open in a tab, has to
      // close with it, as in Chrome.
      const ownTab = async () => (await nodes()).some((n) => /^tab-[^-]+$/.test(n.testID ?? "") && n.text === "ND Gate options");
      await poll("the extension's own tab", ownTab, (open) => open);
      const tabsBefore = await tabCount();

      // Remove from the row's menu, each time through the real pointer on
      // macOS: the ⋯ button, then the menu item.
      const remove = async (): Promise<void> => {
        await openPanel();
        if (MAC) {
          await press(`ext-more-${other}`);
          await Bun.sleep(800);
          // An NSMenu item has no view to locate. The menu drops from the
          // button's leading edge with Options then Remove, and Remove's
          // middle sits this far from the button's, measured in
          // ext-appkit-row-menu.png.
          const more = await app.getByTestId(`ext-more-${other}`).boundingBox();
          if (!more) fail("the row's menu button has no geometry");
          await app.cursor.click({ x: more.x + more.width / 2 + 33, y: more.y + more.height / 2 + 53 });
        } else {
          await clickWhenReady(`ext-remove-${other}`);
        }
      };
      // GTK's automation takes a menu item without its menu open, and has no
      // click for the button that opens it, so the capture is best effort.
      await openPanel();
      if (MAC) await press(`ext-more-${other}`);
      else await app.click(`ext-more-${other}`).catch(() => {});
      await Bun.sleep(800);
      shot("row-menu");
      if (MAC) await app.cursor.click({ x: 900, y: 400 });
      await Bun.sleep(500);

      await remove();
      await Bun.sleep(1500);
      if (lines.some((l) => l.includes(`EXT_REMOVED id=${other}`))) fail("Cancel removed the extension");
      await openPanel();
      if (!(await rows()).some((r) => r.id === other)) fail("Cancel removed the row");
      await remove();
      const landed = await poll(
        "the removal to land",
        async () => lines.find((l) => l.includes(`ND_APP EXT_REMOVED id=${other}`) || l.includes(`EXT_REMOVE failed id=${other}`)) ?? "",
        (l) => l !== "",
        60_000,
      );
      if (landed.includes("failed")) fail(landed.slice(landed.indexOf("ND_APP")));
      await Bun.sleep(1500);
      noStrayWindow("after the removal");
      // Nothing of the panel or its menu may be left up.
      if (await panelShown()) fail("the panel stayed open after Remove");
      if (MAC && appWindows().length !== windowsAtStart) {
        fail(`${appWindows().length} windows up after Remove, ${windowsAtStart} at start: a menu or panel stayed`);
      }
      shot("removed");
      if (await ownTab()) fail("the extension's own tab is still open");
      if ((await tabCount()) !== tabsBefore - 1) fail(`tabs ${tabsBefore} -> ${await tabCount()}, want the extension's one closed`);
      await openPanel();
      const left = await rows();
      if (left.some((r) => r.id === other)) fail("the extension is still listed");
      shot("removed-panel");
      console.log(`4. Cancel kept it; Remove took it and its tab out, closed the panel and menu, no Chromium dialog; ${left.length} row(s) left`);
    });
  } else {
    await step("4. real extension click", async () => {
      await openPanel();
      await clickWhenReady(`ext-pin-toggle-${other}`);
      await closePanel();
      await Bun.sleep(3000);
      const before = await tabCount();
      await press(`ext-action-${other}`);
      await Bun.sleep(5000);
      const trigger = lines.find((l) => l.includes("ND_APP ACTION_TRIGGER ") && l.includes(`id=${other}`)) ?? "no trigger";
      const decided = lines.find((l) => l.includes("ND_APP ACTION ") && l.includes(`id=${other}`)) ?? "";
      const popup = !!(await app.find(`ext-popup-view-${other}`));
      shot("real-clicked");
      console.log(
        `4. ${realName} ${other}: ${decided.slice(decided.indexOf("ND_APP"))}; ${trigger.slice(trigger.indexOf("ND_APP"))}; popup ${popup ? "open in the app" : "not open"}; tabs ${before} -> ${await tabCount()}`,
      );
      noStrayWindow("after the click");
    });
  }
  console.log("NB_EXT_CLICK_OK");
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`);
  console.log(lines.filter((l) => /ND_APP (ACTION |ACTION_TRIGGER|EXT)|ND_WARN|uninstall/.test(l)).slice(-20).join("\n"));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
