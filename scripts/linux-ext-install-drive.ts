#!/usr/bin/env bun
// Web Store installs and tabs a page opens, on Linux, run as a drive inside
// the framework's real-app rig (x11: Xvfb and openbox):
//
//   ND_APP_DIR=<this app> ND_ACCEPT_RIGS=x11 NB_TEST_HOOKS=1 \
//     ND_ACCEPT_EXTENSIONS=<this app>/fixtures/nd-tabs-ext \
//     ND_ACCEPT_DRIVE=<path from the framework to this file> \
//     scripts/headless-app-chrome.sh           (in the framework, nix develop)
//
// Legs (NB_EXT_LEGS, default all), the same as scripts/mac-ext-install-drive.ts:
//   tabs    ctrl-click and middle-click open behind the page, right after it
//           and after each other; target=_blank and window.open in front,
//           right after the page; an extension's chrome.tabs.create in front,
//           at the end.
//   store   "Add to Chrome" asks in the app's own dialog; Return adds the
//           extension with Chromium's prompt answered unseen, no download row
//           and no save dialog; Escape on a second one cancels it and
//           Chromium never prompts. Needs the network.
//
// Input is XTEST, page state is read over CDP, captures are of the whole
// screen. Marker: NB_EXT_INSTALL_OK(<rig>), and the rig's ND_APP_CHROME_OK.
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const rig = process.env.ND_ACCEPT_RIG ?? "x11";
const shots = process.env.ND_ACCEPT_SHOTS ?? "/tmp/nb-ext-install-shots";
const hostLog = process.env.ND_ACCEPT_HOST_LOG ?? "";
const cdpPort = process.env.ND_CDP_PORT ?? "9555";
const hostPid = process.env.ND_ACCEPT_HOST_PID ?? "";
const downloads = process.env.ND_ACCEPT_DOWNLOADS ?? "";
const store = hostLog ? join(dirname(hostLog), "store") : "";
const legs = (process.env.NB_EXT_LEGS ?? "tabs,store").split(",");
const ADD_ITEM = process.env.NB_STORE_ITEM ?? "ddkjiahejlhfcafbddmgiahcphecmpfh";
const CANCEL_ITEM = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
/// Chromium names an unpacked extension after its path: sha256, first 32 hex
/// digits, 0-f as a-p.
const TABS_EXT = (process.env.ND_ACCEPT_EXTENSIONS ?? "").split(",").find((p) => p.endsWith("nd-tabs-ext")) ?? "";
const TABS_EXT_ID = [...new Bun.CryptoHasher("sha256").update(TABS_EXT).digest("hex").slice(0, 32)].map((c) => "abcdefghijklmnop"["0123456789abcdef".indexOf(c)]).join("");
mkdirSync(shots, { recursive: true });
let failed = 0;

function sh(...argv: string[]): string {
  const out = Bun.spawnSync(["timeout", "10", ...argv], { env: process.env as Record<string, string> });
  return out.stdout.toString().trim();
}
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${name}: ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}
function capture(name: string): void {
  const path = join(shots, `ext-install-${name}.png`);
  if (rig === "x11") sh("import", "-window", "root", path);
  else sh("grim", path);
  console.log(`  capture ${path}`);
}
function logLines(): string[] {
  return hostLog ? readFileSync(hostLog, "utf8").split("\n") : [];
}
const logged = (pattern: RegExp, from: number) => logLines().slice(from).find((l) => pattern.test(l));
async function waitLog(pattern: RegExp, from: number, ms = 20_000): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = logged(pattern, from);
    if (hit) return hit;
    await Bun.sleep(150);
  }
  return undefined;
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

// ---- CDP ------------------------------------------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
async function targets(): Promise<Target[]> {
  return ((await (await fetch(`http://127.0.0.1:${cdpPort}/json`).catch(() => null))?.json().catch(() => [])) ?? []) as Target[];
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
  static async open(match: (t: Target) => boolean): Promise<Page> {
    for (let i = 0; i < 150; i++) {
      const t = (await targets()).find(match);
      if (t) {
        const socket = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (socket.onopen = r));
        return new Page(socket);
      }
      await Bun.sleep(200);
    }
    throw new Error("no matching target over CDP");
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
  /// A real click through Chromium's input pipeline (modifiers: 2 = ctrl).
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

// ---- the app's window --------------------------------------------------------------------

/// The app's own toplevel: the host's biggest visible window.
function appWindow(): { id: string; name: string } {
  let best = { id: "", name: "", area: 0 };
  for (const dec of sh("xdotool", "search", "--onlyvisible", "--pid", hostPid, "").split("\n").filter(Boolean)) {
    const info = sh("xwininfo", "-id", dec);
    const n = (k: string) => Number(info.match(new RegExp(`${k}:\\s+(-?\\d+)`))?.[1] ?? 0);
    const area = n("Width") * n("Height");
    if (area > best.area) best = { id: dec, name: sh("xdotool", "getwindowname", dec), area };
  }
  return best;
}
interface StoredWindow { tabs: { id: string; url: string }[]; activeId: string }
function storedWindow(): StoredWindow {
  try {
    const s = JSON.parse(readFileSync(join(store, "session.json"), "utf8")) as { data: { windows: StoredWindow[] } };
    return s.data.windows[0] ?? { tabs: [], activeId: "" };
  } catch {
    return { tabs: [], activeId: "" };
  }
}
const sessionTabs = () => storedWindow().tabs;
/// The address of the tab on show, as the app stores it.
function activeTitle(): string {
  const w = storedWindow();
  return w.tabs.find((t) => t.id === w.activeId)?.url ?? "";
}
function key(chord: string): void {
  sh("xdotool", "windowactivate", "--sync", appWindow().id);
  sh("xdotool", "key", chord);
}

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
const paths = () => sessionTabs().map((t) => (t.url.startsWith(ORIGIN) ? t.url.slice(ORIGIN.length) : t.url));

try {
  const page = await Page.open((t) => t.type === "page" && /^https?:/.test(t.url) && !t.url.endsWith("?two"));

  if (legs.includes("tabs")) {
    await page.send("Page.navigate", { url: `${ORIGIN}/opener` });
    await waitFor("the opener on show", activeTitle, (t) => t.includes("opener"));
    const start = paths().length;
    const at = () => paths().indexOf("/opener");
    await page.click("#plain", { modifiers: 2 });
    await page.click("#plain", { button: "middle" });
    let order = await waitFor("two tabs behind the page", paths, (p) => p.length === start + 2);
    check("tabs.behindStaysOnPage", activeTitle().includes("opener"), activeTitle());
    check("tabs.behindRightAfterPage", order[at() + 1] === "/plain" && order[at() + 2] === "/plain", JSON.stringify(order));
    capture("tabs-behind");

    await page.click("#blank");
    order = await waitFor("a tab for target=_blank", paths, (p) => p.length === start + 3);
    await waitFor("the target=_blank tab on show", activeTitle, (t) => t.includes("blank"));
    check("tabs.blankInFront", activeTitle().includes("blank"), activeTitle());
    check("tabs.blankRightAfterPage", order[at() + 1] === "/blank", JSON.stringify(order));
    capture("tabs-blank");

    // Back to the opener (ctrl+shift+Tab, the previous tab), then
    // window.open from a click.
    key("ctrl+shift+Tab");
    await waitFor("the opener on show again", activeTitle, (t) => t.includes("opener"));
    await page.click("#pop");
    order = await waitFor("a tab for window.open", paths, (p) => p.length === start + 4);
    await waitFor("the window.open tab on show", activeTitle, (t) => t.includes("popped"));
    check("tabs.windowOpenInFront", activeTitle().includes("popped"), activeTitle());
    check("tabs.windowOpenRightAfterPage", order[at() + 1] === "/popped", JSON.stringify(order));

    // An extension's own tab, the way one opens its welcome page: the page
    // asks fixtures/nd-tabs-ext, whose worker calls chrome.tabs.create.
    const made = await page.eval(`new Promise((r) => chrome.runtime.sendMessage(${JSON.stringify(TABS_EXT_ID)}, { url: ${JSON.stringify(`${ORIGIN}/from-extension`)} }, (a) => r(String(a ?? (chrome.runtime.lastError && chrome.runtime.lastError.message)))))`);
    order = await waitFor("a tab for chrome.tabs.create", paths, (p) => p.length === start + 5);
    await waitFor("the extension's tab on show", activeTitle, (t) => t.includes("from-extension"));
    check("tabs.extensionTabInFront", activeTitle().includes("from-extension"), `${activeTitle()} (${made})`);
    check("tabs.extensionTabAtEnd", order.at(-1) === "/from-extension", JSON.stringify(order));
    capture("tabs-front");
    console.log(`  tab order ${JSON.stringify(paths())}`);
  }

  if (legs.includes("store")) {
    const storePage = await Page.open((t) => t.type === "page" && /^https?:/.test(t.url));
    const openItem = async (id: string): Promise<void> => {
      await storePage.send("Page.navigate", { url: `https://chromewebstore.google.com/detail/${id}` });
      await Bun.sleep(8000);
      const consent = await storePage.eval(`(() => {
        const hit = [...document.querySelectorAll("button, [role=button]")].find((e) => /reject all|accept all/i.test(e.innerText || ""));
        if (!hit) return "none";
        hit.click();
        return hit.innerText.trim();
      })()`);
      if (consent !== "none") await Bun.sleep(8000);
      check(`store.page.${id.slice(0, 6)}`, (await storePage.eval("location.href")).includes(id), consent);
      await storePage.eval(`(() => {
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
      storePage.eval(`(() => {
        const b = [...document.querySelectorAll("button, [role=button]")].find((e) => /add to chrome/i.test(e.innerText || ""));
        if (!b) return "no Add to Chrome button";
        b.scrollIntoView({ block: "center" });
        b.click();
        return "clicked";
      })()`, true);
    const answers = () => storePage.eval("JSON.stringify(window.__ndStore || [])");

    await openItem(ADD_ITEM);
    let from = Math.max(0, logLines().length - 1);
    check("store.add.clicked", (await addToChrome()) === "clicked");
    // The app's stderr reaches the log in batches, so the ask is read back
    // after the answer rather than waited on.
    await Bun.sleep(3000);
    capture("store-ask");
    check("store.add.noChromeDialogYet", !logged(/chromeDialog node/, from), logged(/chromeDialog node/, from) ?? "");
    key("Return");
    check("store.add.answered", !!(await waitLog(/ND_APP STORE_ANSWER .* add/, from, 5000)));
    check("store.add.asked", !!logged(/ND_APP STORE_ASK/, from), "the app's dialog");
    check("store.add.promptClaimed", !!(await waitLog(/installPrompt claimed/, from)), "Chromium's prompt taken off screen");
    await Bun.sleep(600);
    capture("store-prompt-hidden");
    check("store.add.promptAnswered", !!(await waitLog(/installPrompt answered/, from, 15_000)), logged(/installPrompt unanswered/, from) ?? "");
    const added = await waitFor("store.add.completed", answers, (a) => a.includes("completeInstall ["), 40_000);
    check("store.add.storeSaysAdded", added.includes("completeInstall ["), added);
    check("store.add.toast", !!(await waitLog(/ND_APP STORE_ADDED/, from, 20_000)));
    await Bun.sleep(400);
    capture("store-added");
    check("store.add.neverShown", !logged(/chromeDialog node/, from), logged(/chromeDialog node/, from) ?? "");
    check("store.add.noDownloadRow", !logged(/ND_APP DL request/, from), logged(/ND_APP DL request/, from) ?? "");
    check("store.add.noSaveDialog", !logged(/fileDialog|saveFile/i, from), logged(/fileDialog|saveFile/i, from) ?? "");
    check("store.add.downloadsEmpty", !existsSync(downloads) || readdirSync(downloads).length === 0, existsSync(downloads) ? JSON.stringify(readdirSync(downloads)) : "");
    check("store.add.noStrayTab", !logged(/NEW_WINDOW .*new-tab-page/, from), logged(/NEW_WINDOW/, from) ?? "");

    // The cancel leg at 720 px, the narrow width the app supports.
    const app = appWindow().id;
    sh("xdotool", "windowsize", "--sync", app, "720", "800");
    await Bun.sleep(800);
    await openItem(CANCEL_ITEM);
    from = Math.max(0, logLines().length - 1);
    check("store.cancel.clicked", (await addToChrome()) === "clicked");
    await Bun.sleep(3000);
    capture("store-ask-720");
    key("Escape");
    check("store.cancel.answered", !!(await waitLog(/ND_APP STORE_ANSWER .* cancel/, from, 5000)));
    check("store.cancel.asked", !!logged(/ND_APP STORE_ASK/, from));
    const cancelled = await waitFor("store.cancel.storeTold", answers, (a) => a.includes("user_cancelled"), 10_000);
    check("store.cancel.storeSaysCancelled", cancelled.includes("user_cancelled"), cancelled);
    await Bun.sleep(1500);
    check("store.cancel.chromeNeverPrompted", !logged(/installPrompt|chromeDialog node/, from), logged(/installPrompt|chromeDialog node/, from) ?? "");
    for (const l of logLines().filter((l) => /STORE_|installPrompt/.test(l))) console.log(`  log ${l.slice(0, 160)}`);
    storePage.close();
  }
  page.close();
} catch (e) {
  check("drive", false, (e as Error).message);
} finally {
  fixture.stop(true);
}
// The rig's own marker, which it reads to call the rig green.
console.log(failed ? `NB_EXT_INSTALL_FAIL(${rig}) ${failed}` : `NB_EXT_INSTALL_OK(${rig})\nND_APP_CHROME_LEGS_OK(${rig})`);
