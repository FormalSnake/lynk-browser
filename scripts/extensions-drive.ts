#!/usr/bin/env bun
// Stage-3 acceptance drive: a real Chrome extension, installed through the real
// install flow, changing real pages. Offline and self-contained — the fixture
// pages come from a local Bun.serve and the extension comes from
// fixtures/darkreader-mv3 (see scripts/fetch-fixtures.ts).
//
// MV3 is the default because it is what the Chrome Web Store ships now;
// NB_EXT_FIXTURE=mv2 runs the same legs against the MV2 build.
//
//   scripts/headless-extensions.sh              # MV3
//   NB_EXT_FIXTURE=mv2 scripts/headless-extensions.sh
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = `${ROOT}/screenshots`;
const WHICH = process.env.NB_EXT_FIXTURE === "mv2" ? "mv2" : "mv3";
const FIXTURE = `${ROOT}/fixtures/darkreader-${WHICH}`;
const PROFILE = `/tmp/nb-ext-profile-${WHICH}`;
const MARKER = WHICH === "mv2" ? "NB_DARKREADER_OK" : "NB_DARKREADER_MV3_OK";
// Every wait here scales off one number: the same drive runs on an idle laptop
// and inside a full framework gate sweep, where everything is several times
// slower. ND_DRIVE_TIMEOUT_MS is what the gate raises.
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
// Which of the extension's own keyboard commands leg 3b drives, and what
// reaching storage looks like for it. MV3 drives the per-site toggle
// (Alt+Shift+A); the MV2 build's addSite handler does not complete under this
// runtime (LEDGER), so that build drives the global toggle (Alt+Shift+D)
// instead — same command channel, same storage round trip, same proof that the
// extension's own shortcut changes the page and the change survives.
const TOGGLE_COMMAND = process.env.NB_EXT_COMMAND ?? (WHICH === "mv2" ? "toggle" : "addSite");
const TOGGLED_OFF = (s: Record<string, unknown>): boolean =>
  TOGGLE_COMMAND === "toggle" ? s.enabled === false : (s.disabledFor as string[] | undefined)?.length === 1;
const TOGGLED_ON = (s: Record<string, unknown>): boolean =>
  TOGGLE_COMMAND === "toggle" ? s.enabled !== false : (s.disabledFor as string[] | undefined)?.length === 0;

// MV2 declares `tabs` and `<all_urls>` in one permissions array; MV3 moves the
// hosts into host_permissions and drops `tabs` entirely. The prompt has to
// reflect what the manifest actually asks for, so the expectation differs.
const WANT_WARNINGS =
  WHICH === "mv2"
    ? ["Read and change all your data on all websites", "Access browser tabs"]
    : ["Read and change all your data on all websites"];

if (!existsSync(`${FIXTURE}/manifest.json`)) {
  console.error(`missing ${FIXTURE}; run: bun scripts/fetch-fixtures.ts`);
  process.exit(1);
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- fixture ---

function page(title: string, body: string, background: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>html,body{background:${background};color:#111;font:16px system-ui;margin:0;padding:24px}</style>` +
      `</head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    switch (new URL(req.url).pathname) {
      case "/one":
        return page(
          "Fixture one",
          '<h1>Fixture one</h1><p>A light page.</p><iframe id="sub" src="/frame" width="320" height="140"></iframe>',
          "#ffffff",
        );
      case "/two":
        return page("Fixture two", "<h1>Fixture two</h1><p>A second light page.</p>", "#fafafa");
      case "/frame":
        return page("Fixture frame", "<h1>Framed</h1>", "#f0f0f0");
      default:
        return new Response("not found", { status: 404 });
    }
  },
});
const base = `http://127.0.0.1:${server.port}`;

// ---------------------------------------------------------------- helpers ---

function fail(message: string): never {
  throw new Error(message);
}

async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}

async function shoot(app: AppHandle, name: string, window?: number): Promise<void> {
  const shot = await app.screenshot(`${SHOTS}/${name}.png`, { minBytes: 1000, window });
  console.log(`  screenshot ${name}.png ${shot.width}x${shot.height}`);
}

function walk(node: JsonNode, visit: (n: JsonNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/// getTree walks one window at a time, and half of this UI lives in windows
/// that only exist while a flow is open, so lookups sweep every window.
async function findAcross(app: AppHandle, testId: string): Promise<{ node: JsonNode; window: number } | null> {
  const { windows } = await app.windows();
  for (const info of windows) {
    const node = await app.find(testId, { window: info.ref });
    if (node) return { node, window: info.ref };
  }
  return null;
}

async function waitAcross(app: AppHandle, testId: string, timeoutMs = PATIENCE): Promise<{ node: JsonNode; window: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findAcross(app, testId);
    if (found) return found;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${testId} in any window`);
}

async function textsUnder(app: AppHandle, prefix: string, window: number): Promise<string[]> {
  const tree = await app.tree(window);
  const out: string[] = [];
  walk(tree.root, (n) => {
    if (n.testID?.startsWith(prefix) && n.text) out.push(n.text);
  });
  return out;
}

/// The id the app derived for the fixture, read back off the UI rather than
/// recomputed, so the drive asserts what the app actually did.
async function installedId(app: AppHandle): Promise<string> {
  const { windows } = await app.windows();
  for (const info of windows) {
    const tree = await app.tree(info.ref);
    let found: string | null = null;
    walk(tree.root, (n) => {
      if (found) return;
      if (n.testID?.startsWith("ext-row-")) found = n.testID.slice("ext-row-".length);
      else if (n.testID?.startsWith("ext-action-")) found = n.testID.slice("ext-action-".length);
    });
    if (found) return found;
  }
  return fail("no installed extension row or toolbar button in any window");
}

/// What the extension's isolated world in a tab actually contains. The shim is
/// injected there as a document_start user script, so this answers "did the
/// content-script plumbing reach this page at all" independently of whatever
/// the extension then decided to do.
async function worldProbe(app: AppHandle, testId: string, extensionId: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await app
      .evalInPage({ testId }, "(globalThis.__ndextRan || 0) + ' scripts, chrome=' + typeof chrome", {
        world: `ext:${extensionId}`,
        timeoutMs: 8000,
      })
      .catch((error: Error) => ({ ok: false, value: null, error: error.message }));
    if (result.ok) return String(result.value);
    last = String(result.error);
    await Bun.sleep(400);
  }
  return `unavailable (${last})`;
}

async function mainWindow(app: AppHandle): Promise<number> {
  const found = await findAcross(app, "main-window");
  if (!found) return fail("the browser window is gone");
  return found.window;
}

async function openPalette(app: AppHandle): Promise<void> {
  const node = await app.find("palette");
  if (node?.visible) return;
  await app.click("omnibox");
  await app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE });
}

async function goTo(app: AppHandle, url: string): Promise<void> {
  await openPalette(app);
  await app.setValue("palette", "");
  await app.type("palette", url);
  await app.setValue("palette", true);
}

async function tabRows(app: AppHandle): Promise<string[]> {
  const list = await app.mustFind("tab-list");
  return (list.rows ?? []).map((r) => r.title);
}

/// The webview testID of the tab at `index`. Tab ids are handed out by the
/// session store and an extension can create tabs of its own, so nothing here
/// may assume "the first tab is t1".
async function pageTestId(app: AppHandle, index: number): Promise<string> {
  const list = await app.mustFind("tab-list");
  const row = (list.rows ?? [])[index];
  if (!row?.testID) return fail(`no sidebar row at index ${index}`);
  return `page-${row.testID.replace(/^tab-/, "")}`;
}

async function waitRows(app: AppHandle, check: (rows: string[]) => boolean, what: string): Promise<string[]> {
  const deadline = Date.now() + PATIENCE;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await tabRows(app);
    if (check(last)) return last;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${what}; sidebar rows were ${JSON.stringify(last)}`);
}

// --------------------------------------------------------------- darkness ---

/// Every darkening assertion is built on this.
///
/// Dark Reader ships TWO ways of darkening a page and only one of them proves
/// anything here. `inject/fallback.js` paints a flat dark sheet on its own, at
/// document_start, with no background page involved, whenever the system
/// prefers dark — which the headless GTK session does. The real dynamic theme
/// is the one that needs the whole runtime: content script, message bridge,
/// background page, theme response. It is distinguishable by class: the
/// fallback carries `darkreader--fallback`, the real one does not. Counting
/// the non-fallback sheets is what separates "the extension is installed" from
/// "the extension works".
function darknessProbe(documentExpression: string): string {
  return `(function(){
  function luminance(color) {
    var m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(color || "");
    if (!m) return -1;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  }
  var doc = ${documentExpression};
  if (!doc) return JSON.stringify({ theme: -1, fallback: -1, luminance: -1 });
  var all = doc.querySelectorAll("style.darkreader");
  var fallback = doc.querySelectorAll("style.darkreader--fallback");
  return JSON.stringify({
    theme: all.length - fallback.length,
    fallback: fallback.length,
    luminance: luminance(getComputedStyle(doc.documentElement).backgroundColor),
  });
})()`;
}

const PAGE_PROBE = darknessProbe("document");
const FRAME_PROBE = darknessProbe('(document.getElementById("sub") || {}).contentDocument');

interface Darkness {
  /** Dark Reader stylesheets that are NOT the standalone fallback sheet. */
  theme: number;
  fallback: number;
  luminance: number;
}

async function probe(app: AppHandle, testId: string, code = PAGE_PROBE): Promise<Darkness> {
  const result = await app.evalInPage({ testId }, code, { timeoutMs: 8000 });
  if (!result.ok) fail(`probe failed on ${testId}: ${result.error}`);
  return JSON.parse(result.value ?? "{}") as Darkness;
}

async function waitDark(app: AppHandle, testId: string, what: string, code = PAGE_PROBE): Promise<Darkness> {
  const deadline = Date.now() + PATIENCE;
  let last: Darkness = { theme: 0, fallback: 0, luminance: -1 };
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      last = await probe(app, testId, code);
      if (last.theme > 0 && last.luminance >= 0 && last.luminance < 0.35) return last;
    } catch (e) {
      // Mid-navigation the page has no document to probe; keep polling, but
      // keep the reason so a real failure is not reported as "never darkened".
      lastError = (e as Error).message;
    }
    await Bun.sleep(400);
  }
  return fail(
    `${what} never got Dark Reader's theme on ${testId} (last probe ${JSON.stringify(last)}${lastError ? `, last error ${lastError}` : ""})`,
  );
}

/// "Light" means the extension applied no theme. The luminance is deliberately
/// not asserted: with an extension installed and the system preferring dark,
/// Dark Reader's fallback sheet may still be on the page, and that is correct
/// behaviour rather than a failure.
async function waitUnthemed(app: AppHandle, testId: string, what: string): Promise<Darkness> {
  const deadline = Date.now() + PATIENCE;
  let last: Darkness = { theme: -1, fallback: -1, luminance: -1 };
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      last = await probe(app, testId);
      if (last.theme === 0) return last;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await Bun.sleep(400);
  }
  return fail(
    `${what} still carries Dark Reader's theme on ${testId} (last probe ${JSON.stringify(last)}${lastError ? `, last error ${lastError}` : ""})`,
  );
}

/// Reads a value out of the background page. The automation socket refuses to
/// evaluate inside a widget it cannot see, and a background page is mounted
/// hidden by design, so this goes through the app's NB_TEST_HOOKS probe menu:
/// the drive writes the expression, the app runs it there, and parks the
/// answer in a label.
/// The extension's chrome.storage, read straight out of the app's SQLite file.
/// The background page is hidden by design and cannot be evaluated in, so this
/// is how a drive checks what actually persisted.
function storedSettings(extensionId: string, area = "sync"): Record<string, unknown> {
  const db = new Database(`${PROFILE}/extensions.sqlite`, { readonly: true });
  try {
    const rows = db
      .query<{ key: string; value: string }, [string, string]>(
        "SELECT key, value FROM extension_storage WHERE ext_id = ? AND area = ?",
      )
      .all(extensionId, area);
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  } finally {
    db.close();
  }
}

/// Waits for something to reach the database. Extensions debounce their own
/// writes (Dark Reader batches settings saves), so "the page changed" is not
/// the same as "the change is on disk" — and only the second survives a
/// restart.
async function waitStored(
  extensionId: string,
  check: (settings: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PATIENCE;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = storedSettings(extensionId);
    if (check(last)) return last;
    await Bun.sleep(300);
  }
  return fail(`${what} never reached chrome.storage (last ${JSON.stringify(last).slice(0, 300)})`);
}

async function listTestIds(app: AppHandle): Promise<string[]> {
  const { windows } = await app.windows();
  const out: string[] = [];
  for (const info of windows) {
    const tree = await app.tree(info.ref);
    walk(tree.root, (n) => {
      if (n.testID) out.push(n.testID);
    });
  }
  return out;
}

async function waitPopupLoaded(app: AppHandle, id: string): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  while (Date.now() < deadline) {
    const { windows } = await app.windows();
    for (const window of windows) {
      if (!(await app.find(`ext-popup-view-${id}`, { window: window.ref }))) continue;
      // A window one frame old is in the tree but not yet mapped, and the
      // socket answers "not actionable" for a widget it cannot see yet.
      const info = await app.webviewInfo({ testId: `ext-popup-view-${id}`, window: window.ref }).catch(() => null);
      if (!info) continue;
      last = `${info.title ?? ""} @ ${info.url ?? ""}`;
      if ((info.url ?? "").includes("/ui/popup/index.html")) return last;
    }
    await Bun.sleep(300);
  }
  return fail(`the popup never loaded the extension page (last ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ drive ---

function launch(): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    backend: "gtk",
    cwd: ROOT,
    // A D-Bus name, so no hyphens: GTK accepts an invalid application id and
    // then degrades silently. Distinct per fixture so two runs never collide on
    // GApplication's single-instance check.
    env: { NB_STORE_DIR: PROFILE, NB_TEST_HOOKS: "1", ND_APP_ID: `dev.nativebrowser.ext.${WHICH}` },
    // One entry per "Install from…" click: the folder picker answers with the
    // unpacked fixture, which is exactly what a person would have chosen.
    dialogScript: { "dialog.openFile": [[FIXTURE], [FIXTURE]] },
    readyTimeoutMs: PATIENCE,
    rpcTimeoutMs: PATIENCE,
    // The app narrates its extension plumbing on stderr under NB_TEST_HOOKS.
    // Surfacing it here is what makes a failure diagnosable from one run.
    // NB_EXT_VERBOSE=1 mirrors the whole host log, which is the only way to see
    // the widget-command traffic a failing extension leg turns on.
    onStderr: (line) => {
      if (process.env.NB_EXT_VERBOSE === "1") console.log(`   host | ${line.trimEnd()}`);
      else if (line.includes("ND_APP") || line.includes("[nativebrowser]")) console.log(`   app | ${line.trim()}`);
    },
  });
}

let app = await launch();

try {
  console.log(`fixture: ${FIXTURE}`);

  // 0 — a tab already open on a light page, before anything is installed. This
  // is what "an existing tab" means in leg 2, and the baseline every later
  // probe is compared against.
  await goTo(app, `${base}/one`);
  await waitRows(app, (r) => r[0]!.startsWith("Fixture one"), "the first fixture page");
  const firstTab = await pageTestId(app, 0);
  const baseline = await probe(app, firstTab);
  if (baseline.theme !== 0 || baseline.fallback !== 0) {
    fail(`the page carries Dark Reader styles before anything is installed: ${JSON.stringify(baseline)}`);
  }
  console.log(`0. a tab is open on a light page with no extension installed ${JSON.stringify(baseline)}`);

  // 1 — install through the real flow: manager, folder picker, permission prompt.
  await step("open the extensions manager", () => app.click("menu-extensions-manage"));
  const manager = await waitAcross(app, "ext-manager-window");
  await app.mustFind("ext-manager-empty", { window: manager.window });
  await shoot(app, `${WHICH}-01-manager-empty`, manager.window);

  await step("choose the unpacked extension folder", () => app.click("ext-manager-add-folder"));
  const prompt = await waitAcross(app, "ext-prompt-window");
  const name = await app.mustFind("ext-prompt-name", { window: prompt.window });
  if (!String(name.text ?? "").includes("Dark Reader")) {
    fail(`the prompt names ${JSON.stringify(name.text)}, want Dark Reader`);
  }
  const warnings = await textsUnder(app, "ext-prompt-warning-", prompt.window);
  for (const wanted of WANT_WARNINGS) {
    if (!warnings.includes(wanted)) fail(`the prompt is missing "${wanted}"; it showed ${JSON.stringify(warnings)}`);
  }
  await shoot(app, `${WHICH}-02-permission-prompt`, prompt.window);
  console.log(`1. install flow: folder picker -> permission prompt listing ${JSON.stringify(warnings)}`);

  // Nothing of the extension runs until Add.
  await step("add the extension", () => app.click("ext-prompt-add"));
  const id = await step("the extension appears in the manager", async () => {
    await waitAcross(app, "ext-manager-list");
    return installedId(app);
  });
  const managerAfter = await waitAcross(app, `ext-row-${id}`);
  await shoot(app, `${WHICH}-03-manager-installed`, managerAfter.window);
  console.log(`1b. installed as ${id}`);

  // 1c — Dark Reader opens its own welcome tab from runtime.onInstalled, which
  // is chrome.tabs.create arriving from the background page. Chrome does the
  // same thing; close it so the rest of the drive stays offline.
  await waitRows(app, (r) => r.length === 2, "the welcome tab the extension opens on install");
  await step("select the welcome tab", () => app.click("menu-tab-1"));
  await step("close the welcome tab", () => app.click("menu-close-tab"));
  await waitRows(app, (r) => r.length === 1, "the welcome tab to close");
  console.log("1c. runtime.onInstalled fired in the background page and opened a tab (closed again)");

  // 2 — the tab that was already open darkens, and so does a freshly opened one.
  await step("select the fixture tab", () => app.click("menu-tab-0"));
  await step("reload the tab so its content scripts run", () => app.click("menu-reload"));
  const dark = await waitDark(app, firstTab, "the tab that was already open");
  console.log(`2. existing tab: before ${JSON.stringify(baseline)}, after reload ${JSON.stringify(dark)}`);
  await shoot(app, `${WHICH}-04-darkened`, await mainWindow(app));

  const framed = await waitDark(app, firstTab, "the iframe inside the fixture", FRAME_PROBE);
  console.log(`2b. all_frames: the iframe darkened too ${JSON.stringify(framed)}`);

  await step("open a second tab", () => app.click("menu-new-tab"));
  await waitRows(app, (r) => r.length === 2, "a second tab row");
  await goTo(app, `${base}/two`);
  await waitRows(app, (r) => r[1]!.startsWith("Fixture two"), "the second fixture page");
  const secondTab = await pageTestId(app, 1);
  const fresh = await waitDark(app, secondTab, "a freshly opened tab");
  console.log(`2c. a tab opened after install darkened with no reload ${JSON.stringify(fresh)}`);

  // 3 — the action popup: the extension's own page in a native window.
  await step("open the action popup", () => app.click(`ext-action-${id}`));
  const popup = await waitAcross(app, "ext-popup-window");
  const popupTitle = await waitPopupLoaded(app, id);
  await shoot(app, `${WHICH}-05-popup`, popup.window);
  console.log(`3. popup window loaded the extension's own page (${popupTitle})`);
  await step("close the popup", () => app.click(`ext-action-${id}`));

  // 3b — the extension's own keyboard command. The popup's DOM is compiled and
  // its controls carry no stable selectors, so the command is the honest
  // equivalent: it runs the same background code path the popup's toggle calls,
  // through chrome.commands, chrome.storage and the background-to-content hop.
  await step(`run the ${TOGGLE_COMMAND} command`, () =>
    app.click(`menu-ext-cmd-${id}-${TOGGLE_COMMAND}`),
  );
  await Bun.sleep(1500);
  await step("reload the page", () => app.click("menu-reload"));
  const toggledOff = await waitUnthemed(app, secondTab, `the page after the ${TOGGLE_COMMAND} command`);
  await waitStored(id, TOGGLED_OFF, `the ${TOGGLE_COMMAND} command's effect`);
  console.log(`3b. ${TOGGLE_COMMAND} command: the page loses the theme ${JSON.stringify(toggledOff)}, and storage agrees`);

  await step(`run ${TOGGLE_COMMAND} again`, () => app.click(`menu-ext-cmd-${id}-${TOGGLE_COMMAND}`));
  await step("reload the page", () => app.click("menu-reload"));
  const toggledOn = await waitDark(app, secondTab, `the page after running ${TOGGLE_COMMAND} again`);
  await waitStored(id, TOGGLED_ON, `the ${TOGGLE_COMMAND} command being undone`);
  console.log(`3c. ${TOGGLE_COMMAND} again: the theme is back ${JSON.stringify(toggledOn)}, and storage agrees`);

  // 4 — state survives a restart: the registry row, the grant and storage.
  await app.close();
  app = await launch();
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  await waitRows(app, (r) => r.length === 2, "the restored tabs");
  const restartedId = await installedId(app);
  if (restartedId !== id) fail(`after a restart the extension id is ${restartedId}, was ${id}`);
  // The toolbar button only exists for an enabled extension, so its presence
  // is the assertion that the grant survived rather than just the row.
  await step("the toolbar button is back", () => app.waitForPresent(`ext-action-${id}`, { timeoutMs: PATIENCE }));
  // Only the active tab is actionable, so pick the one being asserted on.
  await step("select the first restored tab", () => app.click("menu-tab-0"));
  console.log(`   content world after restart: ${await worldProbe(app, await pageTestId(app, 0), id)}`);
  const settings = storedSettings(id);
  if (Object.keys(settings).length === 0) fail("the extension's chrome.storage.sync did not survive the restart");
  if (!TOGGLED_ON(settings)) fail(`the toggle state did not survive the restart: ${JSON.stringify(settings).slice(0, 200)}`);
  const afterRestart = await waitDark(app, await pageTestId(app, 0), "the restored tab");
  console.log(`4. restart: ${id} still enabled, page still darkens ${JSON.stringify(afterRestart)}`);
  console.log(`4b. chrome.storage.sync survived the restart (${Object.keys(settings).length} keys)`);
  await shoot(app, `${WHICH}-06-after-restart`, await mainWindow(app));

  // 5 — disabling it in the manager puts the page back.
  await step("open the manager", () => app.click("menu-extensions-manage"));
  const manager2 = await waitAcross(app, `ext-toggle-${id}`);
  await step("switch the extension off", () => app.setValue({ testId: `ext-toggle-${id}` }, false));
  await step("reload the page", () => app.click("menu-reload"));
  const light = await waitUnthemed(app, await pageTestId(app, 0), "the page after disabling the extension");
  console.log(`5. disabled in the manager: the page renders light again ${JSON.stringify(light)}`);
  await shoot(app, `${WHICH}-07-disabled`, manager2.window);
  await shoot(app, `${WHICH}-08-light-again`, await mainWindow(app));

  console.log(MARKER);
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  console.error("--- host stderr tail ---");
  console.error(app.stderrTail(80));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
