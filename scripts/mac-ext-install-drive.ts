#!/usr/bin/env bun
// Web Store installs and tabs a page opens, on the real engine, macOS.
//
//   bash -c '. ~/Developer/NativeDesktop/scripts/mac/cef-gate-lock.sh; cef_gate_lock;
//     trap cef_gate_unlock EXIT; ND_HOST_BINARY=<NDShellDev.app/Contents/MacOS/NDShell> bun scripts/mac-ext-install-drive.ts'
//
// Legs (NB_EXT_LEGS, default all):
//   store   "Add to Chrome" asks in the app's own dialog; Return adds the
//           extension with Chromium's prompt answered unseen, no download row
//           and no save panel, and a toast says it was added; Escape on a
//           second one cancels it and Chromium never prompts. Captured at the
//           normal width and at 720 px.
//   tabs    where a page's new tabs land and which one shows, as in Chrome:
//           cmd-click and middle-click behind the page, right after it and
//           after each other; target=_blank and window.open in front, right
//           after the page; an extension's chrome.tabs.create in front, at the
//           end. NB_LAYOUT=compact|sidebar (default sidebar).
//
// Needs the network for the store leg, an idle session (app.cursor is the
// owner's pointer and keyboard) and Screen Recording for tools/ndshot.
// Captures land in screenshots/ext-install-*.png. Marker: NB_EXT_INSTALL_MAC_OK.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { NDSHOT, SHOTS, fail, ndshotWindows } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const bundled = process.env.ND_HOST_BINARY ?? fail("set ND_HOST_BINARY to a bundled CEF host");
const legs = (process.env.NB_EXT_LEGS ?? "store,tabs").split(",");
const layout = process.env.NB_LAYOUT ?? "sidebar";
const ADD_ITEM = process.env.NB_STORE_ITEM ?? "ddkjiahejlhfcafbddmgiahcphecmpfh";
const CANCEL_ITEM = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
const RUN = mkdtempSync(join(tmpdir(), "nb-extinstall-"));
const CDP_PORT = Number(process.env.ND_CEF_DEBUG_PORT ?? 9493);
const DOWNLOADS = join(RUN, "downloads");
const STORE = join(RUN, "store");
const hostBinary = join(RUN, "host.sh");
const TABS_EXT = resolve(ROOT, "fixtures/nd-tabs-ext");
writeFileSync(
  hostBinary,
  `#!/bin/sh\ncase "$1" in --nd-*) exec "${bundled}" "$@" ;; esac\nexec "${bundled}" --remote-debugging-port=${CDP_PORT} --load-extension=${TABS_EXT} "$@"\n`,
);
chmodSync(hostBinary, 0o755);
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
mkdirSync(STORE, { recursive: true });

const idle = Number(
  Bun.spawnSync(["sh", "-c", "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"]).stdout.toString().trim(),
);
if (!process.env.NB_EXT_IGNORE_IDLE && idle < 120) fail(`the mac has been idle ${idle}s; the drive uses the real cursor and keyboard`);

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${name}: ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

// ---- a page that opens tabs -----------------------------------------------------------

const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const body =
      path === "/opener"
        ? `<a id="plain" href="/plain" style="display:block;font-size:40px">plain</a>
           <a id="blank" href="/blank" target="_blank" style="display:block;font-size:40px">blank</a>
           <button id="pop" onclick="window.open('/popped')" style="font-size:40px">pop</button>`
        : `<p>${path}</p>`;
    return new Response(`<!doctype html><title>${path.slice(1)}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
  },
});
const ORIGIN = `http://127.0.0.1:${fixture.port}`;

const startUrl = legs.includes("tabs") ? `${ORIGIN}/opener` : "https://chromewebstore.google.com/";
writeFileSync(
  join(STORE, "session.json"),
  JSON.stringify({
    version: 1,
    data: {
      tabs: [
        { id: "t1", url: startUrl, title: "", pinned: false },
        { id: "t2", url: `${ORIGIN}/other`, title: "", pinned: false },
      ],
      activeId: "t1",
      nextTabId: 3,
      windowWidth: 1280,
      windowHeight: 860,
      zoomByHost: {},
    },
  }),
);
writeFileSync(join(STORE, "settings.json"), JSON.stringify({ version: 1, data: { layout, restoreOnLaunch: true } }));

const lines: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  hostBinary,
  env: {
    NB_STORE_DIR: STORE,
    NB_DOWNLOAD_DIR: DOWNLOADS,
    NB_TEST_HOOKS: "1",
    NATIVE_AUTOMATION: "1",
    ND_WEBVIEW_ENGINE: "chromium",
    ND_CEF_STYLE: "chrome",
    ND_CEF_CACHE: join(RUN, "cef"),
    ND_APP_ID: "dev.nativebrowser.extinstall",
    ND_WEBVIEW_TRACE: "1",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => lines.push(line),
});
const logged = (pattern: RegExp, from = 0) => lines.slice(from).find((l) => pattern.test(l));
async function waitLog(pattern: RegExp, from: number, ms = 20_000): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = logged(pattern, from);
    if (hit) return hit;
    await Bun.sleep(150);
  }
  return undefined;
}

// ---- CDP ------------------------------------------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
async function targets(): Promise<Target[]> {
  return ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`).catch(() => null))?.json().catch(() => [])) ?? []) as Target[];
}
type Reply = { result?: { result?: { value?: unknown } } };
class Page {
  private seq = 0;
  private waiting = new Map<number, (m: Reply) => void>();
  private constructor(private socket: WebSocket) {
    socket.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    };
  }
  static async open(match: (url: string) => boolean): Promise<Page> {
    for (let i = 0; i < 150; i++) {
      const t = (await targets()).find((x) => x.type === "page" && match(x.url));
      if (t) {
        const socket = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (socket.onopen = r));
        return new Page(socket);
      }
      await Bun.sleep(200);
    }
    return fail("no page target over CDP");
  }
  send(method: string, params: Record<string, unknown>): Promise<Reply | null> {
    const id = ++this.seq;
    const answer = new Promise<Reply>((r) => this.waiting.set(id, r));
    this.socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([answer, Bun.sleep(15_000).then(() => null)]);
  }
  async eval(expression: string, userGesture = false): Promise<string> {
    const m = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
    return m ? String(m.result?.result?.value ?? "") : "(timeout)";
  }
  /// A real click as Chromium's input pipeline sees it, with modifiers
  /// (4 = cmd) or the middle button.
  async click(selector: string, opts: { modifiers?: number; button?: "left" | "middle" } = {}): Promise<void> {
    const [x, y] = JSON.parse(await this.eval(`JSON.stringify((r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()))`)) as [number, number];
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: opts.button ?? "left", clickCount: 1, modifiers: opts.modifiers ?? 0 });
    }
  }
  close(): void {
    this.socket.close();
  }
}

const appWindow = () => ndshotWindows(app.pid)[0] ?? fail("no window on screen");
function capture(name: string): void {
  const out = `${SHOTS}/ext-install-${name}.png`;
  const shot = Bun.spawnSync(["timeout", "30", NDSHOT, "capture", "--out", out, "--window-id", String(appWindow().windowID), "--region", "--no-focus"]);
  console.log(shot.exitCode === 0 ? `  capture ${out}` : `  capture ${name} failed: ${shot.stderr.toString().trim()}`);
}
async function activeTitle(): Promise<string> {
  return (await app.windows()).windows[0]?.title ?? "";
}
function sessionTabs(): { id: string; url: string }[] {
  try {
    const s = JSON.parse(readFileSync(join(STORE, "session.json"), "utf8")) as { data: { windows: { tabs: { id: string; url: string }[] }[] } };
    return s.data.windows[0]?.tabs ?? [];
  } catch {
    return [];
  }
}
async function waitFor<T>(what: string, read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) {
      check(what, false, `last ${JSON.stringify(last)}`);
      return last;
    }
    await Bun.sleep(200);
    last = await read();
  }
  return last;
}
const paths = () => sessionTabs().map((t) => (t.url.startsWith(ORIGIN) ? t.url.slice(ORIGIN.length) : t.url));

try {
  await app.setWindowSize(1280, 860);

  if (legs.includes("tabs")) {
    const opener = await Page.open((u) => u.endsWith("/opener"));
    await waitFor("the opener on show", activeTitle, (t) => t === "opener");
    await opener.click("#plain", { modifiers: 4 });
    await opener.click("#plain", { button: "middle" });
    let order = await waitFor("two tabs behind the page", paths, (p) => p.length === 4);
    check("tabs.behindStaysOnPage", (await activeTitle()) === "opener", await activeTitle());
    check("tabs.behindRightAfterPage", JSON.stringify(order) === JSON.stringify(["/opener", "/plain", "/plain", "/other"]), JSON.stringify(order));
    capture(`tabs-behind-${layout}`);

    await opener.click("#blank");
    order = await waitFor("a tab for target=_blank", paths, (p) => p.length === 5);
    await waitFor("the target=_blank tab on show", activeTitle, (t) => t === "blank");
    check("tabs.blankInFront", (await activeTitle()) === "blank", await activeTitle());
    check("tabs.blankRightAfterPage", order[1] === "/blank", JSON.stringify(order));
    capture(`tabs-blank-${layout}`);

    // Back to the opener, as a person would, and window.open from a click.
    await app.click(layout === "compact" ? "tab-item-t1" : "tab-t1");
    await waitFor("the opener on show again", activeTitle, (t) => t === "opener");
    await opener.click("#pop");
    order = await waitFor("a tab for window.open", paths, (p) => p.length === 6);
    await waitFor("the window.open tab on show", activeTitle, (t) => t === "popped");
    check("tabs.windowOpenInFront", (await activeTitle()) === "popped", await activeTitle());
    check("tabs.windowOpenRightAfterPage", order[1] === "/popped", JSON.stringify(order));

    // An extension's own tab, the way one opens its welcome page: the page
    // asks fixtures/nd-tabs-ext, whose worker calls chrome.tabs.create.
    const TABS_EXT_ID = [...new Bun.CryptoHasher("sha256").update(TABS_EXT).digest("hex").slice(0, 32)].map((c) => "abcdefghijklmnop"["0123456789abcdef".indexOf(c)]).join("");
    const made = await opener.eval(`new Promise((r) => chrome.runtime.sendMessage(${JSON.stringify(TABS_EXT_ID)}, { url: ${JSON.stringify(`${ORIGIN}/from-extension`)} }, (a) => r(String(a ?? (chrome.runtime.lastError && chrome.runtime.lastError.message)))))`);
    order = await waitFor("a tab for chrome.tabs.create", paths, (p) => p.length === 7);
    await waitFor("the extension's tab on show", activeTitle, (t) => t === "from-extension");
    check("tabs.extensionTabInFront", (await activeTitle()) === "from-extension", `${await activeTitle()} (${made})`);
    check("tabs.extensionTabAtEnd", order.at(-1) === "/from-extension", JSON.stringify(order));
    capture(`tabs-front-${layout}`);
    opener.close();
    console.log(`  tab order ${JSON.stringify(paths())}`);
  }

  if (legs.includes("store")) {
    const store = await Page.open((u) => !u.startsWith("chrome") && !u.startsWith("devtools"));
    const openItem = async (id: string): Promise<void> => {
      await store.send("Page.navigate", { url: `https://chromewebstore.google.com/detail/${id}` });
      await Bun.sleep(8000);
      const consent = await store.eval(`(() => {
        const hit = [...document.querySelectorAll("button, [role=button]")].find((e) => /reject all|accept all/i.test(e.innerText || ""));
        if (!hit) return "none";
        hit.click();
        return hit.innerText.trim();
      })()`);
      if (consent !== "none") await Bun.sleep(8000);
      check(`store.page.${id.slice(0, 6)}`, (await store.eval("location.href")).includes(id), consent);
      await store.eval(`(() => {
        window.__ndStore = [];
        const wp = chrome.webstorePrivate;
        for (const name of ["beginInstallWithManifest3", "completeInstall"]) {
          const original = wp[name];
          wp[name] = function (...args) {
            const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
            window.__ndStore.push("call " + name);
            return original.call(wp, ...args, function (...answer) {
              window.__ndStore.push(name + " " + JSON.stringify(answer).slice(0, 80));
              if (cb) cb(...answer);
            });
          };
        }
      })()`);
    };
    const addToChrome = () =>
      store.eval(`(() => {
        const b = [...document.querySelectorAll("button, [role=button]")].find((e) => /add to chrome/i.test(e.innerText || ""));
        if (!b) return "no Add to Chrome button";
        b.scrollIntoView({ block: "center" });
        b.click();
        return "clicked";
      })()`, true);
    const answers = () => store.eval("JSON.stringify(window.__ndStore || [])");

    // Add.
    await openItem(ADD_ITEM);
    let from = lines.length;
    check("store.add.clicked", (await addToChrome()) === "clicked");
    check("store.add.asked", !!(await waitLog(/ND_APP STORE_ASK/, from)), "the app's dialog");
    await Bun.sleep(900);
    capture("store-ask-1280");
    const viewsWindows = () => lines.slice(from).filter((l) => /chrome surface adopted/.test(l));
    check("store.add.noChromeDialogYet", viewsWindows().length === 0, viewsWindows().join(" | "));
    await app.cursor.press("enter");
    check("store.add.answered", !!(await waitLog(/ND_APP STORE_ANSWER .* add/, from, 5000)));
    check("store.add.promptClaimed", !!(await waitLog(/installPrompt claimed/, from)), "Chromium's prompt taken off screen");
    check("store.add.promptAnswered", !!(await waitLog(/installPrompt answered/, from)), logged(/installPrompt unanswered/, from) ?? "");
    const added = await waitFor("store.add.completed", answers, (a) => a.includes("completeInstall ["), 40_000);
    check("store.add.storeSaysAdded", added.includes("completeInstall ["), added);
    check("store.add.toast", !!(await waitLog(/ND_APP STORE_ADDED/, from, 20_000)));
    await Bun.sleep(400);
    capture("store-added-1280");
    check("store.add.neverAdopted", viewsWindows().length === 0, viewsWindows().join(" | "));
    check("store.add.noDownloadRow", !logged(/ND_APP DL request/, from), logged(/ND_APP DL request/, from) ?? "");
    check("store.add.noSavePanel", !logged(/fileDialog|saveFile/i, from));
    check("store.add.downloadsEmpty", readdirSync(DOWNLOADS).length === 0, JSON.stringify(readdirSync(DOWNLOADS)));
    check("store.add.noStrayTab", !logged(/NEW_WINDOW .*new-tab-page/, from), logged(/NEW_WINDOW/, from) ?? "");

    // Cancel, at 720 px.
    await app.setWindowSize(720, 860);
    await openItem(CANCEL_ITEM);
    from = lines.length;
    check("store.cancel.clicked", (await addToChrome()) === "clicked");
    check("store.cancel.asked", !!(await waitLog(/ND_APP STORE_ASK/, from)));
    await Bun.sleep(900);
    capture("store-ask-720");
    await app.cursor.press("escape");
    check("store.cancel.answered", !!(await waitLog(/ND_APP STORE_ANSWER .* cancel/, from, 5000)));
    const cancelled = await waitFor("store.cancel.storeTold", answers, (a) => a.includes("user_cancelled"), 10_000);
    check("store.cancel.storeSaysCancelled", cancelled.includes("user_cancelled"), cancelled);
    await Bun.sleep(1500);
    check("store.cancel.chromeNeverPrompted", !logged(/installPrompt|chrome surface adopted/, from), logged(/installPrompt|chrome surface adopted/, from) ?? "");
    store.close();
  }
} finally {
  await app.close().catch(() => {});
  fixture.stop(true);
}
if (existsSync(DOWNLOADS) && readdirSync(DOWNLOADS).length) console.log(`  downloads ${JSON.stringify(readdirSync(DOWNLOADS))}`);
console.log(failed ? `NB_EXT_INSTALL_MAC_FAIL ${failed}` : "NB_EXT_INSTALL_MAC_OK");
