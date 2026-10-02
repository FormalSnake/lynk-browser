#!/usr/bin/env bun
// History, bookmarks and downloads against the real engine: each panel opened
// by its own chord, searched, and an entry opened from it; every route a
// download takes and every thing its row can do, read back off the disk and
// off the rows. Self-contained fixture; nothing touches the network.
//
//   Linux:  scripts/headless.sh bun scripts/pages-drive.ts   (chromium, X11: chords go through xdotool)
//   macOS:  scripts/mac-drive.sh scripts/pages-drive.ts      (under the mac CEF lock)
//
// Marker: NB_PAGES_OK.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";
import { KEYS } from "../src/lib/keys.ts";
import { fail, paletteDriver, step, walk } from "./drive-lib.ts";

const MAC = process.platform === "darwin";
const SCRATCH = process.env.NB_DRIVE_ROOT ?? "/tmp";
const STORE = `${SCRATCH}/nb-pages-store`;
const DIR = `${SCRATCH}/nb-pages-files`;
const SAVE_AS = `${SCRATCH}/nb-pages-saveas`;
const DATA_HOME = `${SCRATCH}/nb-pages-data`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
for (const d of [STORE, DIR, SAVE_AS, DATA_HOME]) rmSync(d, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(SAVE_AS, { recursive: true });

// As long as the popover shows uncut (44 characters), so a row too narrow for
// it, or one that shows "…" alone, is caught by the width check below.
const LONG_NAME = "quarterly-report-2026-for-the-board.txt";
// A type that runs code when opened on this platform, so the warning shows.
const DANGEROUS = MAC ? "tool.command" : "tool.sh";
const SLOW_SIZE = 2 * 1024 * 1024;

const page = (title: string, body: string): Response =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const attachment = (name: string, body: string): Response =>
  new Response(body, {
    headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` },
  });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    switch (path) {
      case "/home":
        return page("Home page", "<h1>Home</h1>");
      case "/alpha":
        return page("Alpha page", "<h1>Alpha</h1>");
      case "/beta":
        return page("Beta page", "<h1>Beta</h1>");
      case "/links":
        // nbTest is what the Debug menu's "Run test script" calls.
        return page(
          "Links",
          `<a id="named" href="/data" download="named.bin">named</a><script>window.nbTest = () => document.getElementById("named").click();</script>`,
        );
      case "/data":
        return new Response("named payload", { headers: { "content-type": "application/octet-stream" } });
      case "/report":
        return attachment(LONG_NAME, "the board's numbers\n");
      case "/danger":
        return attachment(DANGEROUS, "#!/bin/sh\necho hi\n");
      case "/danger2":
        return attachment(`b-${DANGEROUS}`, "#!/bin/sh\necho hi\n");
      case "/saveas":
        return attachment("pick-me.txt", "saved where asked\n");
      default:
        return new Response("not found", { status: 404 });
    }
  },
});
const base = `http://127.0.0.1:${server.port}`;

// Bun.serve drops a streamed body's Content-Length, and progress, speed and
// time left all need a known size, so the slow file comes from node:http.
const slow = createServer((req, res) => {
  const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  res.writeHead(range ? 206 : 200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${req.url?.includes("two") ? "slow-two.bin" : "slow.bin"}"`,
    "accept-ranges": "bytes",
    etag: '"slow"',
    "content-length": String(SLOW_SIZE - start),
    ...(range ? { "content-range": `bytes ${start}-${SLOW_SIZE - 1}/${SLOW_SIZE}` } : {}),
  });
  let offset = start;
  const timer = setInterval(() => {
    if (res.destroyed) return clearInterval(timer);
    const n = Math.min(32 * 1024, SLOW_SIZE - offset);
    res.write(Buffer.alloc(n, 0x61));
    offset += n;
    if (offset >= SLOW_SIZE) {
      clearInterval(timer);
      res.end();
    }
  }, 50);
  req.on("close", () => clearInterval(timer));
});
await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
const slowBase = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;

const palette = paletteDriver({ timeoutMs: PATIENCE });

function launch(dialogPath?: string): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    env: {
      NB_STORE_DIR: STORE,
      NB_DOWNLOAD_DIR: DIR,
      XDG_DATA_HOME: DATA_HOME,
      NB_TEST_HOOKS: "1",
      NB_TEST_JS: "window.nbTest && window.nbTest()",
      ND_APP_ID: process.env.ND_APP_ID ?? "dev.nativebrowser.pages",
    },
    dialogScript: dialogPath ? { "dialog.saveFile": [dialogPath] } : undefined,
    readyTimeoutMs: PATIENCE,
    rpcTimeoutMs: PATIENCE,
    logPath: `${SCRATCH}/nb-pages-host${dialogPath ? "-2" : ""}.log`,
  });
}

// ------------------------------------------------------------------ keys ---

function sh(...argv: string[]): string {
  const out = Bun.spawnSync(argv, { timeout: 10_000 });
  return out.stdout.toString().trim();
}

/// A chord as the user presses it. GTK synthesises no key input in process,
/// so on Linux it goes through the X server to the focused app window.
async function press(app: AppHandle, keys: string): Promise<void> {
  const parts = keys.split("+");
  if (MAC) {
    const names: Record<string, string> = { primary: "Meta", shift: "Shift", alt: "Alt", ctrl: "Control", return: "Enter", escape: "Escape" };
    await app.keyboard.press(parts.map((p) => names[p] ?? p.toUpperCase()).join("+"));
  } else {
    const names: Record<string, string> = { primary: "ctrl", return: "Return", escape: "Escape" };
    // The GTK toplevel, not one of Chromium's windows: a key sent to the page
    // goes to Chromium, which answers a panel's search field's Return itself.
    // The largest visible nd-hello window with a title is the app's; the
    // untitled ones are GTK and Chromium surfaces.
    let win = "";
    let area = 0;
    for (const id of sh("xdotool", "search", "--onlyvisible", "--classname", "nd-hello").split("\n").filter(Boolean)) {
      if (!sh("xdotool", "getwindowname", id)) continue;
      const m = /Geometry: (\d+)x(\d+)/.exec(sh("xdotool", "getwindowgeometry", id));
      const a = m ? Number(m[1]) * Number(m[2]) : 0;
      if (a > area) [win, area] = [id, a];
    }
    if (win) sh("xdotool", "windowfocus", "--sync", win);
    sh("xdotool", "key", "--clearmodifiers", parts.map((p) => names[p] ?? p).join("+"));
  }
  await Bun.sleep(300);
}

// --------------------------------------------------------------- queries ---

async function everywhere(app: AppHandle, visit: (n: JsonNode) => void): Promise<void> {
  for (const w of (await app.windows()).windows) {
    const tree = await app.tree(w.ref).catch(() => null);
    if (tree) walk(tree.root, visit);
  }
}

async function present(app: AppHandle, testId: string): Promise<JsonNode | null> {
  let found: JsonNode | null = null;
  await everywhere(app, (n) => {
    if (!found && n.testID === testId) found = n;
  });
  return found ?? (await app.find(testId).catch(() => null)) ?? null;
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | false>, timeoutMs = PATIENCE): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > deadline) return fail(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

type Row = { id: string; name: JsonNode; status: string; ids: string[] };

/// A download's row by the name it shows, in the popover (`downloads-`) or
/// the panel (`all-downloads-`).
async function row(app: AppHandle, name: string, prefix = "all-"): Promise<Row | null> {
  let found: Row | null = null;
  await everywhere(app, (n) => {
    const m = n.testID?.match(new RegExp(`^${prefix}downloads-item-(.+)$`));
    if (!found && m && n.text === name) found = { id: m[1]!, name: n, status: "", ids: [] };
  });
  if (!found) return null;
  const r = found as Row;
  const stem = `${prefix}downloads-${r.id}`;
  await everywhere(app, (n) => {
    if (n.testID === `${prefix}downloads-status-${r.id}`) r.status = String(n.text ?? "");
    if (n.testID?.startsWith(`${stem}-`) || n.testID === `${prefix}downloads-reveal-${r.id}`) r.ids.push(n.testID!);
  });
  return r;
}

async function waitRow(app: AppHandle, name: string, check: (r: Row) => boolean, what: string, prefix = "all-"): Promise<Row> {
  let last: Row | null = null;
  return waitFor(`${name}: ${what}`, async () => {
    last = await row(app, name, prefix);
    return last && check(last) ? last : null;
  }).catch((e) => fail(`${(e as Error).message}; last seen ${JSON.stringify(last && { ...last, name: last.name.text })}`));
}

const stemOf = (r: Row, prefix = "all-") => `${prefix}downloads-${r.id}`;
const reveals = (r: Row, prefix = "all-") => r.ids.includes(`${prefix}downloads-reveal-${r.id}`);

async function waitFile(path: string, body?: string): Promise<void> {
  await waitFor(`${path} to land${body ? ` holding ${JSON.stringify(body)}` : ""}`, async () =>
    existsSync(path) && (body === undefined || readFileSync(path, "utf8") === body),
  );
}

/// The name label shows the whole name: at the body text size a character
/// averages over 6 px, so a label narrower than that per character is
/// cut, and one showing "…" alone is about 12 px.
function wholeName(n: JsonNode, name: string, where: string): void {
  const w = n.geometry?.w ?? 0;
  if (w < name.length * 6) fail(`${where}: the name label is ${w} px wide for ${name.length} characters, so it cannot show ${JSON.stringify(name)}`);
}

async function panelOpen(app: AppHandle, panel: string, open: boolean): Promise<void> {
  await waitFor(`${panel} to ${open ? "open" : "close"}`, async () => {
    // Presence, not `visible`: a sheet's content reports its own window's
    // visibility, which AppKit leaves unset for a sheet.
    const n = await present(app, `${panel}-search`);
    return open ? n !== null : n === null;
  });
  // The node is in the tree before libadwaita has presented the dialog, and a
  // key pressed in between reaches whatever had the keyboard before it.
  if (open) await step(`${panel}'s search field to take the keyboard`, () => app.waitForFocused(`${panel}-search`, { timeoutMs: PATIENCE }));
}

/// A download started from the command bar, then the Downloads panel over
/// it: the bar does not present over the panel's sheet.
async function downloadThenPanel(app: AppHandle, url: string): Promise<void> {
  if (await present(app, "downloads-search")) {
    await press(app, KEYS.downloads);
    await panelOpen(app, "downloads", false);
  }
  await palette.goTo(app, url);
  await Bun.sleep(500);
  await press(app, "escape");
  await press(app, KEYS.downloads);
  await panelOpen(app, "downloads", true);
}

/// The window title follows the active tab's page title.
async function activeTitle(app: AppHandle): Promise<string> {
  return String((await app.windows()).windows[0]?.title ?? "");
}

/// The screen when a leg fails, for whoever reads the log.
function captureFailure(): void {
  const out = `${SCRATCH}/nb-pages-failure.png`;
  if (MAC) Bun.spawnSync([join(process.env.HOME ?? "", "Developer/NativeDesktop/tools/ndshot/bin/ndshot"), "capture", "--out", out, "--pid", String(app.pid), "--region", "--no-focus"], { timeout: 30_000 });
  else Bun.spawnSync(["import", "-window", "root", out], { timeout: 30_000 });
  console.log(`failure capture ${out}`);
}

let app = await launch();
try {
  await app.waitForPresent("main-window", { timeoutMs: PATIENCE });

  await step("1. History: its chord, a search, Return opens the match", async () => {
    await palette.goTo(app, `${base}/alpha`);
    await waitFor("Alpha page to load", async () => (await activeTitle(app)).includes("Alpha page"));
    await palette.goTo(app, `${base}/beta`);
    await waitFor("Beta page to load", async () => (await activeTitle(app)).includes("Beta page"));
    await press(app, KEYS.history);
    await panelOpen(app, "history", true);
    await waitFor("both visits listed", async () => (await present(app, `history-row-${base}/alpha`)) && (await present(app, `history-row-${base}/beta`)));
    await app.type("history-search", "alpha");
    await waitFor("the search to leave Alpha alone", async () => !(await present(app, `history-row-${base}/beta`)) && (await present(app, `history-row-${base}/alpha`)));
    await press(app, "return");
    await panelOpen(app, "history", false);
    await waitFor("the tab to go to Alpha", async () => (await activeTitle(app)).includes("Alpha page"));
    // The chord that opens it also puts it away.
    await press(app, KEYS.history);
    await panelOpen(app, "history", true);
    await press(app, KEYS.history);
    await panelOpen(app, "history", false);
    console.log("1. history: chord opened it, 'alpha' left one row, Return went there, chord closed it");
  });

  await step("2. Bookmarks: keep two pages, search, open one", async () => {
    await palette.goTo(app, `${base}/home`);
    await waitFor("Home page to load", async () => (await activeTitle(app)).includes("Home page"));
    await press(app, KEYS["bookmark-page"]);
    await palette.goTo(app, `${base}/beta`);
    await waitFor("Beta page to load", async () => (await activeTitle(app)).includes("Beta page"));
    await press(app, KEYS["bookmark-page"]);
    await press(app, KEYS.bookmarks);
    await panelOpen(app, "bookmarks", true);
    await waitFor("both bookmarks listed", async () => (await present(app, `bookmarks-row-${base}/home`)) && (await present(app, `bookmarks-row-${base}/beta`)));
    await app.type("bookmarks-search", "home");
    await waitFor("the search to leave Home alone", async () => !(await present(app, `bookmarks-row-${base}/beta`)));
    await press(app, "return");
    await panelOpen(app, "bookmarks", false);
    await waitFor("the tab to go Home", async () => (await activeTitle(app)).includes("Home page"));
    await press(app, KEYS.bookmarks);
    await panelOpen(app, "bookmarks", true);
    await app.click(`bookmarks-remove-${base}/beta`);
    await waitFor("the removed bookmark to go", async () => !(await present(app, `bookmarks-row-${base}/beta`)));
    await press(app, "escape");
    await panelOpen(app, "bookmarks", false);
    console.log("2. bookmarks: ⇧⌘B kept two pages, 'home' left one, Return went there, remove and Esc");
  });

  await step("3. Downloads: a real download shows its whole name, found by search, opened", async () => {
    await palette.goTo(app, `${base}/report`);
    await waitFile(join(DIR, LONG_NAME), "the board's numbers\n");
    // The popover opens by itself when the download starts; a drive's own
    // clicks can have put it away since, and the button brings it back.
    await Bun.sleep(1500);
    if (!(await row(app, LONG_NAME, ""))) await app.click("downloads-button");
    const pop = await waitRow(app, LONG_NAME, (r) => reveals(r, ""), "the popover row never finished", "").catch(async (e) => {
      const ids: string[] = [];
      await everywhere(app, (n) => {
        if (n.testID?.includes("download")) ids.push(`${n.testID}=${JSON.stringify(n.text ?? "")}`);
      });
      return fail(`${(e as Error).message}; download nodes: ${ids.join(" ")}`);
    });
    wholeName(pop.name, LONG_NAME, "popover");
    await press(app, "escape");
    await press(app, KEYS.downloads);
    await panelOpen(app, "downloads", true);
    const listed = await waitRow(app, LONG_NAME, (r) => reveals(r) && r.status.includes("127.0.0.1"), "the panel row is not finished");
    wholeName(listed.name, LONG_NAME, "panel");
    await app.type("downloads-search", "quarterly");
    await waitFor("the search to keep the report", async () => (await row(app, LONG_NAME)) !== null);
    await press(app, "return");
    await waitFor("the report to open", async () => readFileSync(`${SCRATCH}/nb-pages-host.log`, "utf8").includes(`ND_APP DL open ${join(DIR, LONG_NAME)}`));
    await press(app, KEYS.downloads);
    await panelOpen(app, "downloads", false);
    console.log(`3. downloads: ${LONG_NAME} landed, whole in the popover (${pop.name.geometry?.w} px) and the panel (${listed.name.geometry?.w} px), Return opened it`);
  });

  await step("4. <a download> names the file", async () => {
    await palette.goTo(app, `${base}/links`);
    await Bun.sleep(800);
    await app.click("menu-run-test-js");
    await waitFile(join(DIR, "named.bin"), "named payload");
    await waitRow(app, "named.bin", (r) => r.status.includes("127.0.0.1"), "status does not name the site", "");
    console.log("4. <a download> saved as named.bin");
  });

  await step("5. progress, pause and resume", async () => {
    await downloadThenPanel(app, `${slowBase}/slow.bin`);
    const moving = await waitRow(app, "slow.bin", (r) => / of .*\/s/.test(r.status), "no size and speed while running");
    if (!moving.ids.includes(`${stemOf(moving)}-progress`)) fail("a running download shows no progress");
    await app.click(`${stemOf(moving)}-pause`);
    await waitRow(app, "slow.bin", (r) => r.status.startsWith("Paused"), "pause did not take");
    await Bun.sleep(800);
    await app.click(`${stemOf(moving)}-resume`);
    await waitRow(app, "slow.bin", (r) => reveals(r), "never finished after resume");
    const size = Bun.file(join(DIR, "slow.bin")).size;
    if (size !== SLOW_SIZE) fail(`slow.bin is ${size} bytes, want ${SLOW_SIZE}`);
    console.log(`5. paused and resumed; ${size} bytes`);
  });

  await step("6. cancel, then try again", async () => {
    await downloadThenPanel(app, `${slowBase}/two`);
    const moving = await waitRow(app, "slow-two.bin", (r) => r.ids.includes(`${stemOf(r)}-cancel`), "no cancel while running");
    await app.click(`${stemOf(moving)}-cancel`);
    const stopped = await waitRow(app, "slow-two.bin", (r) => r.status === "Cancelled", "cancel did not take");
    await Bun.sleep(500);
    if (existsSync(join(DIR, "slow-two.bin"))) fail("a cancelled download left its file");
    await app.click(`${stemOf(stopped)}-retry`);
    await waitRow(app, "slow-two.bin", (r) => reveals(r), "retry never finished");
    if (Bun.file(join(DIR, "slow-two.bin")).size !== SLOW_SIZE) fail("the retried file is the wrong size");
    console.log("6. cancelled, retried from the row, finished");
  });

  await step("7. a dangerous file waits for Keep or Discard", async () => {
    await downloadThenPanel(app, `${base}/danger`);
    const warned = await waitRow(app, DANGEROUS, (r) => r.ids.includes(`${stemOf(r)}-keep`), "no Keep/Discard");
    if (existsSync(join(DIR, DANGEROUS))) fail("the dangerous file has its real name before it was kept");
    const unconfirmed = readdirSync(DIR).filter((f) => f.startsWith("Unconfirmed "));
    if (unconfirmed.length !== 1) fail(`want one Unconfirmed file, have ${JSON.stringify(readdirSync(DIR))}`);
    await app.click(`${stemOf(warned)}-keep`);
    await waitFile(join(DIR, DANGEROUS));
    await downloadThenPanel(app, `${base}/danger2`);
    const second = await waitRow(app, `b-${DANGEROUS}`, (r) => r.ids.includes(`${stemOf(r)}-discard`), "no Discard on the second");
    await app.click(`${stemOf(second)}-discard`);
    await Bun.sleep(600);
    if (readdirSync(DIR).some((f) => f.startsWith("Unconfirmed ") || f === `b-${DANGEROUS}`)) {
      fail(`discard left a file: ${JSON.stringify(readdirSync(DIR))}`);
    }
    if (await row(app, `b-${DANGEROUS}`)) fail("the discarded download is still listed");
    await press(app, KEYS.downloads);
    await panelOpen(app, "downloads", false);
    console.log("7. dangerous file: kept one under its name, discarded the other");
  });

  await step("8. Chromium's pages land on the app's panels", async () => {
    await palette.goTo(app, `${base}/home`);
    await waitFor("Home page to load", async () => (await activeTitle(app)).includes("Home page"));
    for (const [url, panel] of [
      ["chrome://downloads", "downloads"],
      ["chrome://history", "history"],
      ["chrome://bookmarks", "bookmarks"],
    ] as const) {
      await palette.goTo(app, url);
      await panelOpen(app, panel, true);
      if (!(await activeTitle(app)).includes("Home page")) fail(`${url}: the tab left Home for ${JSON.stringify(await activeTitle(app))}`);
      await press(app, "escape");
      await panelOpen(app, panel, false);
    }
    console.log("8. chrome://downloads, history and bookmarks opened their panels and left the tab on Home");
  });
} catch (e) {
  captureFailure();
  throw e;
} finally {
  await app.close().catch(() => {});
}

await step("9. the list survives a restart, and Ask Where to Save asks", async () => {
  const saved = JSON.parse(readFileSync(join(STORE, "settings.json"), "utf8"));
  saved.data.askWhereToSave = true;
  writeFileSync(join(STORE, "settings.json"), JSON.stringify(saved));
  const target = join(SAVE_AS, "chosen.txt");
  app = await launch(target);
  try {
    await app.waitForPresent("main-window", { timeoutMs: PATIENCE });
    await app.click("menu-downloads");
    await waitRow(app, LONG_NAME, () => true, "the list did not survive the restart");
    await app.click("menu-downloads");
    await panelOpen(app, "downloads", false);
    await palette.goTo(app, `${base}/saveas`);
    await waitFile(target, "saved where asked\n");
    await waitRow(app, "chosen.txt", (r) => reveals(r, ""), "the row does not follow the chosen name", "");
    console.log("9. list restored after restart; Ask Where to Save saved at the chosen path");
  } finally {
    await app.close().catch(() => {});
  }
});

server.stop(true);
slow.close();
console.log("NB_PAGES_OK");
