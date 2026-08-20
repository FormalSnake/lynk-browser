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
import { extensionUrl } from "../src/extensions/scheme.ts";
import {
  SHOTS,
  ENGINE_ENV,
  fail,
  findAcross,
  paletteDriver,
  shoot,
  step,
  textsUnder as textsUnderIn,
  walk,
  waitAcross as waitAcrossIn,
  waitRows as rowsMatching,
} from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE_KIND = process.env.NB_EXT_FIXTURE === "mv2" ? "mv2" : "mv3";
// The Linux gate leaves this unset and stays on gtk; ND_BACKEND=appkit runs the
// same legs against the AppKit host. Each backend keeps its own profile so a
// run on one never reads the other's registry.
const BACKEND = process.env.ND_BACKEND === "appkit" ? "appkit" : "gtk";
const FIXTURE = `${ROOT}/fixtures/darkreader-${FIXTURE_KIND}`;
// The second extension leg 4c installs alongside Dark Reader. Purpose-built and
// tiny: a content script, a background page, storage, and one message round
// trip, which is the whole surface that two extensions at once can break.
const PAIR_FIXTURE = `${ROOT}/fixtures/pair-probe`;
const PROFILE = `/tmp/nb-ext-profile-${FIXTURE_KIND}-${BACKEND}`;
const MARKER = FIXTURE_KIND === "mv2" ? "NB_DARKREADER_OK" : "NB_DARKREADER_MV3_OK";
// Screenshot prefix. The backend is part of it so an AppKit run never
// overwrites the GTK set that a Linux gate just produced, and vice versa.
const WHICH = BACKEND === "gtk" ? FIXTURE_KIND : `${BACKEND}-${FIXTURE_KIND}`;
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
const TOGGLE_COMMAND = process.env.NB_EXT_COMMAND ?? (FIXTURE_KIND === "mv2" ? "toggle" : "addSite");
// Dark Reader's background page: a real one under MV2, the app's service-worker
// wrapper under MV3.
const DARK_READER_BACKGROUND = FIXTURE_KIND === "mv2" ? "/background/index.html" : "/__nd_service_worker.html";
const TOGGLED_OFF = (s: Record<string, unknown>): boolean =>
  TOGGLE_COMMAND === "toggle" ? s.enabled === false : (s.disabledFor as string[] | undefined)?.length === 1;
const TOGGLED_ON = (s: Record<string, unknown>): boolean =>
  TOGGLE_COMMAND === "toggle" ? s.enabled !== false : (s.disabledFor as string[] | undefined)?.length === 0;

// MV2 declares `tabs` and `<all_urls>` in one permissions array; MV3 moves the
// hosts into host_permissions and drops `tabs` entirely. The prompt has to
// reflect what the manifest actually asks for, so the expectation differs.
const WANT_WARNINGS =
  FIXTURE_KIND === "mv2"
    ? ["Read and change all your data on all websites", "Access browser tabs"]
    : ["Read and change all your data on all websites"];

if (!existsSync(`${FIXTURE}/manifest.json`)) {
  console.error(`missing ${FIXTURE}; run: bun scripts/fetch-fixtures.ts`);
  process.exit(1);
}
if (!existsSync(`${PAIR_FIXTURE}/manifest.json`)) {
  console.error(`missing ${PAIR_FIXTURE}; it is committed, so this checkout is incomplete`);
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
          "<h1>Fixture one</h1><p>A light page.</p>" +
            '<iframe id="sub" src="/frame" width="320" height="140"></iframe>',
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

async function waitAcross(app: AppHandle, testId: string, timeoutMs = PATIENCE): Promise<{ node: JsonNode; window: number }> {
  return waitAcrossIn(app, testId, timeoutMs);
}

async function textsUnder(app: AppHandle, prefix: string, window: number): Promise<string[]> {
  return textsUnderIn(app, prefix, window);
}

/// Every extension id the UI is showing, read back off the manager rows and
/// toolbar buttons rather than recomputed, so the drive asserts what the app
/// actually did.
async function installedIds(app: AppHandle): Promise<string[]> {
  const { windows } = await app.windows();
  const found = new Set<string>();
  for (const info of windows) {
    // A window listed a moment ago can be gone by the time it is walked: the
    // permission prompt closes itself the instant Add is clicked, which is
    // exactly when this runs.
    const tree = await app.tree(info.ref).catch(() => null);
    if (!tree) continue;
    walk(tree.root, (n) => {
      if (n.testID?.startsWith("ext-row-")) found.add(n.testID.slice("ext-row-".length));
      else if (n.testID?.startsWith("ext-action-")) found.add(n.testID.slice("ext-action-".length));
    });
  }
  return [...found];
}

async function installedId(app: AppHandle): Promise<string> {
  const [first] = await installedIds(app);
  return first ?? fail("no installed extension row or toolbar button in any window");
}

/// Reads an expression inside one extension's isolated world, polling until
/// `check` accepts the answer. Mid-navigation the page has no world to
/// evaluate in, so a failed attempt is a reason to wait rather than a verdict.
async function waitInWorld(
  app: AppHandle,
  testId: string,
  extensionId: string,
  expression: string,
  check: (value: string) => boolean,
  what: string,
): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  while (Date.now() < deadline) {
    const result = await app
      .evalInPage({ testId }, expression, { world: `ext:${extensionId}`, timeoutMs: 8000 })
      .catch((error: Error) => ({ ok: false, value: null, error: error.message }));
    last = result.ok ? String(result.value) : `unavailable (${result.error})`;
    if (result.ok && check(last)) return last;
    await Bun.sleep(400);
  }
  return fail(`${what}; the world read ${JSON.stringify(last)}`);
}

/// What the shim put in an extension's isolated world. It is injected there as
/// a document_start user script, so this answers "did the content-script
/// plumbing reach this page at all" independently of whatever the extension
/// then decided to do.
const WORLD_PROBE = "(globalThis.__ndextRan || 0) + ' scripts, chrome=' + typeof chrome";

/// Read the instant a tab is selected, this answers "0 scripts,
/// chrome=undefined" on a HEALTHY restore as well: the page has not committed
/// yet, so the world is one WebKit makes up for the question. That is how the
/// string came to be recorded as the signature of a bug it does not identify.
/// Waiting for the world to fill in is what makes the line worth printing.
async function worldProbe(app: AppHandle, testId: string, extensionId: string): Promise<string> {
  return waitInWorld(
    app,
    testId,
    extensionId,
    WORLD_PROBE,
    (value) => value.includes("chrome=object"),
    "the world never came up",
  ).catch((e: Error) => e.message);
}

async function mainWindow(app: AppHandle): Promise<number> {
  const found = await findAcross(app, "main-window");
  if (!found) return fail("the browser window is gone");
  return found.window;
}

const { goTo } = paletteDriver({ timeoutMs: PATIENCE });

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
  return rowsMatching(app, "tab-list", check, what, PATIENCE);
}

/// A view that was handed an address and never went there.
///
/// Every `<webview>` this app creates mounts with no url and is given one on
/// the next render, once its content scripts or its shim are registered: a user
/// script added after a load has begun never sees document_start. The chromium
/// engine drops that address. It arrives while the browser is still being
/// created, `ndSetURL` parks it in `pendingURL`, and `adoptBrowser` never loads
/// it (nd-cef-wave swift/Sources/NDShell/NDCefWebView.swift:235 and :163), so
/// the view sits on about:blank forever while a LATER address on the same view
/// loads normally. It costs the app every tab, every background page and every
/// popup.
///
/// Driving the page to the address the app already believes it is on is what
/// gets the rest of the drive past it. The scripts were registered before this
/// load starts, so document_start is still document_start and every extension
/// assertion below still means what it says. It is announced rather than
/// absorbed: a gate reading this output has to see that the engine lost a
/// navigation.
///
/// A settled reading is the only usable one. While the browser is being created
/// the same engine answers `webviewInfo` with the address it was ASKED for
/// rather than the one it is on (`ndPageState` reports `pendingURL`), so the
/// view claims to be on the target for about a second before falling back.
async function ensureCommitted(app: AppHandle, testId: string, url: string): Promise<void> {
  const found = await waitAcross(app, testId);
  const window = found.window;
  // The app holds a tab's first navigation until the extension's background
  // page reports idle, which is NB_BACKGROUND_READY_MS at worst, so a shorter
  // wait than the drive's own patience reads "the app has not asked yet" as
  // "the engine dropped the address".
  const deadline = Date.now() + PATIENCE;
  let last = "";
  // A view the socket never answers for is left alone: this may only act on a
  // view it has actually watched sit still on the wrong address.
  let answered = false;
  while (Date.now() < deadline) {
    const info = await app.webviewInfo({ testId, window }).catch(() => null);
    if (info) {
      answered = true;
      last = String(info.url ?? "");
      if (last === url && info.loading === false) return;
    }
    await Bun.sleep(250);
  }
  if (!answered || last === url) return;
  console.log(
    `ND_SKIP_CHROMIUM ${testId} never left ${JSON.stringify(last)} for ${url}; ` +
      `the engine dropped the address it was given while its browser was being created ` +
      `(NDCefWebView.swift ndSetURL/adoptBrowser). Driving the page there instead.`,
  );
  const kicked = await app.evalInPage({ testId, window }, `location.replace(${JSON.stringify(url)}), "kicked"`);
  if (!kicked.ok) fail(`${testId} is stuck on ${JSON.stringify(last)} and will not navigate: ${kicked.error}`);
  const settled = Date.now() + PATIENCE;
  while (Date.now() < settled) {
    const info = await app.webviewInfo({ testId, window }).catch(() => null);
    if (String(info?.url ?? "") === url) return;
    await Bun.sleep(250);
  }
  // An extension page that will not load at all is a different fault from a
  // dropped address, and it is the one that ends the drive: nothing of an
  // extension runs without its own origin. Naming it here is what keeps the
  // failure from reading as a mystery timeout six legs later.
  const why = url.startsWith("chrome-extension:")
    ? "; Chromium owns chrome-extension:// and blocks it at navigation level (ERR_BLOCKED_BY_CLIENT), " +
      "so registerScheme never gets its factory consulted for this scheme " +
      "(nd-cef-wave swift/Sources/NDShell/NDCefProfiles.swift:295). " +
      "The app serves nbext:// on this engine (src/extensions/scheme.ts), so reaching here means the " +
      "engine handshake did not travel"
    : "";
  fail(`${testId} never reached ${url} even after being driven there${why}`);
}

/// Where an extension's background page lives. MV3 has no page of its own, so
/// the app serves a wrapper at a reserved path (host.ts SERVICE_WORKER_PATH)
/// that hosts the service worker; MV2 declares a real one.
function backgroundUrl(extensionId: string, page = "/__nd_service_worker.html"): string {
  return extensionUrl(extensionId, page);
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
  // A page that never darkened and a page that is not the page are different
  // faults, and the probe alone cannot tell them apart: a blank view answers
  // every darkness question with "light".
  const where = await app
    .evalInPage({ testId }, "location.href + ' | ' + document.title")
    .then((r) => (r.ok ? String(r.value) : `unreadable (${r.error})`))
    .catch((e: Error) => `unreadable (${e.message})`);
  return fail(
    `${what} never got Dark Reader's theme on ${testId} (last probe ${JSON.stringify(last)}${lastError ? `, last error ${lastError}` : ""}; the view is on ${where})${hostDied()}`,
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
    `${what} still carries Dark Reader's theme on ${testId} (last probe ${JSON.stringify(last)}${lastError ? `, last error ${lastError}` : ""})${hostDied()}`,
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
  // The app writes this file while the drive reads it, so a read can land on a
  // held lock. That is a retry, not a failure: sqlite releases within a
  // transaction's lifetime.
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
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
    } catch (e) {
      last = e;
      Bun.sleepSync(50);
    }
  }
  throw last as Error;
}

/// Waits for something to reach the database. Extensions debounce their own
/// writes (Dark Reader batches settings saves), so "the page changed" is not
/// the same as "the change is on disk" — and only the second survives a
/// restart.
async function waitStored(
  extensionId: string,
  check: (settings: Record<string, unknown>) => boolean,
  what: string,
  area = "sync",
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PATIENCE;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline && !hostFatal) {
    last = storedSettings(extensionId, area);
    if (check(last)) return last;
    await Bun.sleep(300);
  }
  return fail(`${what} never reached chrome.storage (last ${JSON.stringify(last).slice(0, 300)})${hostDied()}`);
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

/// The popup is loaded when its URL is the extension's popup page AND that
/// page has finished BUILDING ITSELF. The load event is not that line: Dark
/// Reader's popup reports 20 characters of text when the document finishes
/// loading and 437 once its bundle has rendered the UI, and a capture taken
/// between the two is of an empty window. Any nonzero count used to satisfy
/// this, which is exactly how the final review got a 91%-flat popup shot.
///
/// Settled, not merely nonempty: two consecutive readings the same, at least
/// one poll apart, with the count above a floor that a bare document body
/// cannot reach on its own.
const POPUP_MIN_CHARS = 100;

async function waitPopupLoaded(app: AppHandle, id: string): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  let previous = -1;
  while (Date.now() < deadline) {
    const { windows } = await app.windows();
    for (const window of windows) {
      if (!(await app.find(`ext-popup-view-${id}`, { window: window.ref }))) continue;
      // A window one frame old is in the tree but not yet mapped, and the
      // socket answers "not actionable" for a widget it cannot see yet.
      const info = await app.webviewInfo({ testId: `ext-popup-view-${id}`, window: window.ref }).catch(() => null);
      if (!info) continue;
      last = `${info.title ?? ""} @ ${info.url ?? ""}`;
      if (!(info.url ?? "").includes("/ui/popup/index.html")) continue;
      const painted = await app
        .evalInPage(
          { testId: `ext-popup-view-${id}`, window: window.ref },
          "String(document.body ? document.body.innerText.trim().length : 0)",
        )
        .catch(() => null);
      const chars = Number(painted?.value ?? 0);
      last = `${last} (${chars} chars)`;
      if (chars >= POPUP_MIN_CHARS && chars === previous) return last;
      previous = chars;
    }
    await Bun.sleep(300);
  }
  return fail(`the popup never rendered the extension page (last ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ drive ---

/// Every `ND_APP CTXMENU` line the app has printed, newest last. This is how
/// the context-menu tree is asserted: no automation can open a real menu (GTK4
/// synthesises no pointer input, and WebKit's menu wants a live right-click),
/// so what the app SENDS the engine is the observable.
const menuTraces: string[] = [];

/// The host's dying words, if it printed any. GDK treats an X protocol error as
/// fatal, so a host that hits one is gone: every later widget command lands
/// nowhere and every wait in here runs its full timeout before blaming the
/// extension for something it never saw. Latching the line is what turns that
/// into a diagnosis.
let hostFatal = "";
const FATAL_HOST_LINES = ["Gdk-ERROR", "X Window System error", "ND_RUNTIME_ERROR"];

function hostDied(): string {
  return hostFatal ? `; the host process died first: ${hostFatal}` : "";
}

function menuTraceFor(tabId: string): unknown[] | null {
  for (let i = menuTraces.length - 1; i >= 0; i--) {
    const line = menuTraces[i]!;
    const head = `ND_APP CTXMENU tab=${tabId} `;
    const at = line.indexOf(head);
    if (at < 0) continue;
    return JSON.parse(line.slice(at + head.length)) as unknown[];
  }
  return null;
}

function launch(folders: string[] = [FIXTURE]): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    backend: BACKEND,
    cwd: ROOT,
    // A D-Bus name, so no hyphens: GTK accepts an invalid application id and
    // then degrades silently. Distinct per fixture so two runs never collide on
    // GApplication's single-instance check.
    env: {
      ...ENGINE_ENV,
      NB_STORE_DIR: PROFILE,
      NB_TEST_HOOKS: "1",
      ND_APP_ID: `dev.nativebrowser.ext.${WHICH.replace(/-/g, "")}`,
      // The restored-tab leg races the background page's boot: a tab that
      // gives up waiting loads without content scripts and comes back
      // unthemed. Under a full gate sweep the product's 8s is not enough.
      // Half the drive's patience, so a background page that is genuinely
      // broken still prints its diagnostic before the drive times out.
      NB_BACKGROUND_READY_MS: String(Math.max(8000, Math.floor(PATIENCE / 2))),
    },
    // One entry per "Install from…" click, in order: the folder picker answers
    // with an unpacked fixture, which is exactly what a person would have
    // chosen. A session that installs two extensions passes two folders.
    dialogScript: { "dialog.openFile": folders.map((folder) => [folder]) },
    readyTimeoutMs: PATIENCE,
    rpcTimeoutMs: PATIENCE,
    // The app narrates its extension plumbing on stderr under NB_TEST_HOOKS.
    // Surfacing it here is what makes a failure diagnosable from one run.
    // NB_EXT_VERBOSE=1 mirrors the whole host log, which is the only way to see
    // the widget-command traffic a failing extension leg turns on.
    onStderr: (line) => {
      if (!hostFatal && FATAL_HOST_LINES.some((mark) => line.includes(mark))) hostFatal = line.trim();
      if (line.includes("ND_APP CTXMENU")) menuTraces.push(line.trim());
      if (process.env.NB_EXT_VERBOSE === "1") console.log(`   host | ${line.trimEnd()}`);
      else if (line.includes("ND_APP") || line.includes("[nativebrowser]")) console.log(`   app | ${line.trim()}`);
    },
  });
}

let app = await launch();

try {
  console.log(`fixture: ${FIXTURE} on ${BACKEND}`);

  // 0 — a tab already open on a light page, before anything is installed. This
  // is what "an existing tab" means in leg 2, and the baseline every later
  // probe is compared against.
  await goTo(app, `${base}/one`);
  const firstTab = await pageTestId(app, 0);
  await ensureCommitted(app, firstTab, `${base}/one`);
  await waitRows(app, (r) => r[0]!.startsWith("Fixture one"), "the first fixture page");
  const baseline = await probe(app, firstTab);
  if (baseline.theme !== 0 || baseline.fallback !== 0) {
    fail(`the page carries Dark Reader styles before anything is installed: ${JSON.stringify(baseline)}`);
  }
  console.log(`0. a tab is open on a light page with no extension installed ${JSON.stringify(baseline)}`);

  // 1 — install through the real flow: manager, folder picker, permission prompt.
  await step("open the extensions manager", () => app.click("menu-extensions-manage"));
  const manager = await waitAcross(app, "ext-manager-window");
  await app.mustFind("ext-manager-empty", { window: manager.window });
  await shoot(app, `${WHICH}-01-manager-empty`, manager.node.ref);

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
  await shoot(app, `${WHICH}-02-permission-prompt`, prompt.node.ref);
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
  await ensureCommitted(app, `ext-background-${id}`, backgroundUrl(id, DARK_READER_BACKGROUND));

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
  const secondTab = await pageTestId(app, 1);
  await ensureCommitted(app, secondTab, `${base}/two`);
  await waitRows(app, (r) => r[1]!.startsWith("Fixture two"), "the second fixture page");
  const fresh = await waitDark(app, secondTab, "a freshly opened tab");
  console.log(`2c. a tab opened after install darkened with no reload ${JSON.stringify(fresh)}`);

  // 3 — the action popup: the extension's own page in a native window.
  await step("open the action popup", () => app.click(`ext-action-${id}`));
  const popup = await waitAcross(app, "ext-popup-window");
  await ensureCommitted(app, `ext-popup-view-${id}`, extensionUrl(id, "/ui/popup/index.html"));
  const popupTitle = await waitPopupLoaded(app, id);
  await shoot(app, `${WHICH}-05-popup`, popup.node.ref);
  console.log(`3. popup window loaded the extension's own page (${popupTitle})`);
  await step("close the popup", () => app.click(`ext-action-${id}`));

  // 3b — the extension's own keyboard command. The popup's DOM is compiled and
  // its controls carry no stable selectors, so the command is the honest
  // equivalent: it runs the same background code path the popup's toggle calls,
  // through chrome.commands, chrome.storage and the background-to-content hop.
  //
  // The reload waits on STORAGE, not on a delay. A page that reloads before
  // the extension has recorded the toggle connects to a background still
  // holding the old answer, and the answer a document gets on connect is the
  // one it keeps. Same shape as the restore race, on a user action instead
  // of a launch.
  await step(`run the ${TOGGLE_COMMAND} command`, () =>
    app.click(`menu-ext-cmd-${id}-${TOGGLE_COMMAND}`),
  );
  await waitStored(id, TOGGLED_OFF, `the ${TOGGLE_COMMAND} command's effect`);
  await step("reload the page", () => app.click("menu-reload"));
  const toggledOff = await waitUnthemed(app, secondTab, `the page after the ${TOGGLE_COMMAND} command`);
  console.log(`3b. ${TOGGLE_COMMAND} command: the page loses the theme ${JSON.stringify(toggledOff)}, and storage agrees`);

  await step(`run ${TOGGLE_COMMAND} again`, () => app.click(`menu-ext-cmd-${id}-${TOGGLE_COMMAND}`));
  await waitStored(id, TOGGLED_ON, `the ${TOGGLE_COMMAND} command being undone`);
  await step("reload the page", () => app.click("menu-reload"));
  const toggledOn = await waitDark(app, secondTab, `the page after running ${TOGGLE_COMMAND} again`);
  console.log(`3c. ${TOGGLE_COMMAND} again: the theme is back ${JSON.stringify(toggledOn)}, and storage agrees`);

  // 4 — state survives a restart: the registry row, the grant and storage. The
  // relaunch arms the folder picker with the SECOND extension, which leg 4c
  // installs on top of the one that just came back.
  await app.close();
  app = await launch([PAIR_FIXTURE]);
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  await waitRows(app, (r) => r.length === 2, "the restored tabs");
  const restartedId = await installedId(app);
  if (restartedId !== id) fail(`after a restart the extension id is ${restartedId}, was ${id}`);
  await ensureCommitted(app, `ext-background-${id}`, backgroundUrl(id, DARK_READER_BACKGROUND));
  // The toolbar button only exists for an enabled extension, so its presence
  // is the assertion that the grant survived rather than just the row.
  await step("the toolbar button is back", () => app.waitForPresent(`ext-action-${id}`, { timeoutMs: PATIENCE }));
  // Only the active tab is actionable, so pick the one being asserted on.
  await step("select the first restored tab", () => app.click("menu-tab-0"));
  const restoredTab = await pageTestId(app, 0);
  await ensureCommitted(app, restoredTab, `${base}/one`);
  console.log(`   content world after restart: ${await worldProbe(app, restoredTab, id)}`);
  const settings = storedSettings(id);
  if (Object.keys(settings).length === 0) fail("the extension's chrome.storage.sync did not survive the restart");
  if (!TOGGLED_ON(settings)) fail(`the toggle state did not survive the restart: ${JSON.stringify(settings).slice(0, 200)}`);
  const afterRestart = await waitDark(app, restoredTab, "the restored tab");
  console.log(`4. restart: ${id} still enabled, page still darkens ${JSON.stringify(afterRestart)}`);
  console.log(`4b. chrome.storage.sync survived the restart (${Object.keys(settings).length} keys)`);
  await shoot(app, `${WHICH}-06-after-restart`, await mainWindow(app));

  // 4c — a SECOND extension, installed while the first one is enabled and
  // running in the same tab. This is the case a single-extension drive cannot
  // see: a script-message handler name is per VIEW on both engines, so two
  // extensions sharing one name means the second registration takes the
  // first's bus down (AppKit) or is refused with its messages delivered to the
  // wrong world (GTK). Every assertion below is per world, per extension.
  await step("open the manager for the second extension", () => app.click("menu-extensions-manage"));
  await waitAcross(app, "ext-manager-add-folder");
  await step("choose the second extension's folder", () => app.click("ext-manager-add-folder"));
  const pairPrompt = await waitAcross(app, "ext-prompt-window");
  const pairName = await app.mustFind("ext-prompt-name", { window: pairPrompt.window });
  if (!String(pairName.text ?? "").includes("Pair Probe")) {
    fail(`the second prompt names ${JSON.stringify(pairName.text)}, want Pair Probe`);
  }
  await step("add the second extension", () => app.click("ext-prompt-add"));
  const pairId = await step("the second extension appears in the manager", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const other = (await installedIds(app)).find((each) => each !== id);
      if (other) return other;
      await Bun.sleep(200);
    }
    return fail(`only ${id} is installed; the second extension never appeared`);
  });
  await ensureCommitted(app, `ext-background-${pairId}`, backgroundUrl(pairId));

  // Chrome does not retrofit an already-loaded page either, so the tab is
  // reloaded once and then carries both extensions' content scripts.
  await step("select the first tab", () => app.click("menu-tab-0"));
  await step("reload it so both extensions inject", () => app.click("menu-reload"));

  const pairDark = await waitDark(app, restoredTab, "the first extension with a second one installed");
  const firstWorld = await waitInWorld(
    app,
    restoredTab,
    id,
    WORLD_PROBE,
    (v) => v.includes("chrome=object") && !v.startsWith("0 "),
    "the first extension's world is empty with two extensions installed",
  );
  const pairAnswer = await waitInWorld(
    app,
    restoredTab,
    pairId,
    "String(globalThis.__ndpair)",
    (v) => v.startsWith("pong:"),
    "the second extension's content script never completed its round trip",
  );
  if (!pairAnswer.includes(pairId)) {
    fail(`the second extension's round trip was answered by ${pairAnswer}, want ${pairId}`);
  }
  const pairStored = await waitStored(
    pairId,
    (s) => Number(s.pings ?? 0) >= 1,
    "the second extension's ping",
    "local",
  );
  // Cross-talk is what a shared handler name produces: one extension's
  // envelopes attributed to the other, which lands in the other's storage.
  if ("pings" in storedSettings(id) || "pings" in storedSettings(id, "local")) {
    fail("the first extension's storage holds the second extension's key");
  }
  const strayKeys = Object.keys(pairStored).filter((key) => key !== "pings" && key !== "lastUrl");
  if (strayKeys.length > 0) {
    fail(`the second extension's storage holds keys it never wrote: ${JSON.stringify(strayKeys)}`);
  }
  console.log(
    `4c. two extensions at once: ${id} world ${JSON.stringify(firstWorld)} and still themes ` +
      `${JSON.stringify(pairDark)}; ${pairId} answered ${JSON.stringify(pairAnswer)} with ` +
      `${JSON.stringify(pairStored)} in its own storage`,
  );
  await shoot(app, `${WHICH}-06b-two-extensions`, await mainWindow(app));

  // 4d, the page context menu. The menu itself is the ENGINE's now, and no
  // automation can open one (GTK4 synthesises no pointer input, WebKit's menu
  // wants a live right-click), so the two halves the app owns are asserted
  // instead: the tree it pushes to the view, and what a click on an item does.
  const menuTabId = restoredTab.replace(/^page-/, "");
  const tree = await step("the app pushed this tab's context-menu tree", async () => {
    const deadline = Date.now() + PATIENCE;
    let last: unknown[] | null = null;
    while (Date.now() < deadline) {
      last = menuTraceFor(menuTabId);
      if (last && JSON.stringify(last).includes("pair-parent")) return last;
      await Bun.sleep(250);
    }
    return fail(`Pair Probe's items never reached the view (last ${JSON.stringify(last)})`);
  });
  const labels = (tree as { label?: string }[]).map((i) => i.label ?? "");
  for (const wanted of ["Open Link in New Tab", "Save Image"]) {
    if (!labels.includes(wanted)) fail(`the app's own item ${JSON.stringify(wanted)} is missing from ${JSON.stringify(labels)}`);
  }
  // Two roots from one extension group under its name, which is what Chrome
  // does; one root would ride inline.
  const group = (tree as { label?: string; children?: unknown[] }[]).find((i) => i.label === "Pair Probe");
  if (!group) fail(`no group for Pair Probe in ${JSON.stringify(labels)}`);
  const groupChildren = (group!.children ?? []) as { id?: string; label?: string; children?: unknown[]; targetUrlGlobs?: string[] }[];
  const tools = groupChildren.find((c) => c.label === "Pair Probe tools");
  if (!tools) fail(`no "Pair Probe tools" submenu in ${JSON.stringify(groupChildren.map((c) => c.label))}`);
  const toolChildren = (tools!.children ?? []) as { id?: string; label?: string; type?: string; checked?: boolean }[];
  if (toolChildren.length !== 2) fail(`the submenu should carry two items, got ${JSON.stringify(toolChildren)}`);
  const sticky = toolChildren.find((c) => c.type === "checkbox");
  if (!sticky || sticky.checked !== false) fail(`the checkbox item is wrong: ${JSON.stringify(toolChildren)}`);
  const linkOnly = groupChildren.find((c) => c.label === "Pair: only local links");
  if (!linkOnly?.targetUrlGlobs?.length) fail(`the link-only item lost its target patterns: ${JSON.stringify(linkOnly)}`);
  console.log(
    `4d. context menu for ${menuTabId}: ${labels.length} entries, Pair Probe grouped with ` +
      `${groupChildren.length} of its own (${JSON.stringify(toolChildren.map((c) => c.label))} nested one deeper)`,
  );

  // The click itself rides the menubar, which lists the same items and runs the
  // same broker path: a checkbox toggles the model, and the extension is told
  // both states, exactly as Chrome reports them.
  await step("click the extension's checkbox item", () => app.click(`menu-ext-menu-${pairId}-pair-sticky`));
  const firstClick = await waitStored(
    pairId,
    (s) => typeof s.lastMenu === "string" && (s.lastMenu as string).startsWith("pair-sticky|"),
    "the extension's contextMenus.onClicked",
    "local",
  );
  if (!String(firstClick.lastMenu).startsWith(`pair-sticky|pair-parent|true|false|${base}`)) {
    fail(`the first click reported ${JSON.stringify(firstClick.lastMenu)}`);
  }
  const rechecked = await step("the toggled state reaches the view", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const current = menuTraceFor(menuTabId);
      if (current && JSON.stringify(current).includes('"checked":true')) return true;
      await Bun.sleep(250);
    }
    return false;
  });
  if (!rechecked) fail("the toggled checkbox state never reached the view");
  await step("click it again", () => app.click(`menu-ext-menu-${pairId}-pair-sticky`));
  const secondClick = await waitStored(
    pairId,
    (s) => typeof s.lastMenu === "string" && (s.lastMenu as string).includes("|false|true|"),
    "the checkbox toggling back",
    "local",
  );
  console.log(
    `4d. checkbox round trip: ${JSON.stringify(firstClick.lastMenu)} then ` +
      `${JSON.stringify(secondClick.lastMenu)}, and the checked state reached the view in between`,
  );
  // Dark Reader declares contextMenus as an OPTIONAL permission and only
  // registers its own menu when its `enableContextMenus` setting is on, which
  // is off by default and only reachable from its own page UI, which is not
  // clickable on GTK. So the assertion is the honest one: it contributes
  // nothing until it asks, and nothing phantom shows up in its name.
  if (JSON.stringify(tree).includes(id)) {
    fail(`${id} contributed context-menu items without ever registering any`);
  }

  // 5 — disabling it in the manager puts the page back.
  await step("open the manager", () => app.click("menu-extensions-manage"));
  const manager2 = await waitAcross(app, `ext-toggle-${id}`);
  await step("switch the extension off", () => app.setValue({ testId: `ext-toggle-${id}` }, false));
  await step("reload the page", () => app.click("menu-reload"));
  const light = await waitUnthemed(app, restoredTab, "the page after disabling the extension");
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
