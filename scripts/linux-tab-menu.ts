#!/usr/bin/env bun
// The tab right-click menus on Linux GTK, with real X11 input (xdotool), in
// one layout per run: NB_TAB_MENU_LAYOUT=sidebar|compact. At a normal and a
// narrow width it right-clicks a tab and the pinned one, reads each menu off
// the host's ND_CONTEXT_MENU trace, checks its items and shape (no label
// twice, no leading, trailing or doubled separator, no submenu), captures the
// screen, then picks Duplicate Tab with the keyboard and reads the new tab back.
//
// Run through scripts/linux-tab-menu.sh (Xvfb + openbox). Marker:
// NB_LINUX_TAB_MENU_OK.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

const compact = process.env.NB_TAB_MENU_LAYOUT === "compact";
const layout = compact ? "compact" : "sidebar";
const SHOTS = process.env.NB_TAB_MENU_SHOTS ?? "screenshots/tab-menu-linux";
const PATIENCE = 30_000;
mkdirSync(SHOTS, { recursive: true });
const store = mkdtempSync(join(tmpdir(), "nb-linux-tab-menu-"));

function fail(message: string): never {
  throw new Error(message);
}

function sh(...argv: string[]): string {
  const run = Bun.spawnSync(argv);
  if (run.exitCode !== 0) fail(`${argv.join(" ")}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().trim();
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    return new Response(`<!doctype html><title>Page ${key}</title><h1>${key}</h1>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}/${path}`;
const tab = (id: string, path: string) => ({ id, url: url(path), title: "", pinned: false });
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [
        {
          id: "w1",
          tabs: [{ id: "t9", url: url("away"), title: "", pinned: true, pinnedUrl: url("home") }, tab("t1", "a"), tab("t2", "b"), tab("t3", "c")],
          activeId: "t1",
          width: 900,
          height: 600,
        },
      ],
      nextTabId: 10,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);
writeFileSync(
  join(store, "settings.json"),
  JSON.stringify({
    version: 1,
    data: { searchEngine: "duckduckgo", homepage: "", restoreOnLaunch: true, layout, pinnedExtensions: [], sitePermissions: {} },
  }),
);

const traced: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  env: { NB_STORE_DIR: store, NB_TEST_HOOKS: "1", NATIVE_AUTOMATION: "1" },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    if (line.includes("ND_CONTEXT_MENU ")) traced.push(line.trim());
  },
});

/// A tab's right-clickable widget: the sidebar's row or tile, or the compact
/// layout's tab in the header bar.
const T = (id: string) => (compact ? `tab-item-${id}` : `tab-${id}`);

async function testIDs(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const w of (await app.windows()).windows) {
    const walk = (n: JsonNode): void => {
      if (n.testID) ids.add(n.testID);
      n.children.forEach(walk);
    };
    walk((await app.tree(w.ref)).root);
  }
  return ids;
}

async function poll<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + PATIENCE;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await Bun.sleep(150);
    last = await read();
  }
  return last;
}

function xwindow(): string {
  const ids = sh("xdotool", "search", "--onlyvisible", "--pid", String(app.pid)).split("\n").filter(Boolean);
  const named = ids.find((id) => Bun.spawnSync(["xdotool", "getwindowname", id]).stdout.toString().trim() !== "");
  return named ?? ids[0] ?? fail("no X11 window of the app");
}

async function rightClick(testID: string): Promise<void> {
  const box = (await app.getByTestId(testID).boundingBox()) ?? fail(`${testID} has no geometry`);
  const win = xwindow();
  sh("xdotool", "windowactivate", "--sync", win);
  sh("xdotool", "mousemove", "--window", win, String(Math.round(box.x + box.width / 2)), String(Math.round(box.y + box.height / 2)));
  sh("xdotool", "click", "3");
}

interface Item { index: number; kind: string; enabled: boolean; label: string }

async function open(testID: string): Promise<Item[]> {
  const before = traced.length;
  const opened = () => traced.slice(before).some((l) => l.includes(" index=0 "));
  // A press right after a popover closed or the window resized can be spent
  // on the grab coming back, so a second one is made once.
  for (let attempt = 0; attempt < 2 && !opened(); attempt++) {
    await rightClick(testID);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !opened()) await Bun.sleep(100);
  }
  await Bun.sleep(300);
  const lines = traced.slice(before);
  const start = lines.findLastIndex((l) => l.includes(" index=0 "));
  if (start < 0) {
    capture(`no-menu-${testID}`);
    fail(`right-clicking ${testID} opened no menu`);
  }
  return lines.slice(start).map((l) => {
    const f = /index=(\d+) kind=(\w+) enabled=(\d) label=(.*)$/.exec(l)!;
    return { index: Number(f[1]), kind: f[2]!, enabled: f[3] === "1", label: f[4]! };
  });
}

function shapeProblems(items: Item[]): string[] {
  const problems: string[] = [];
  const labels = items.filter((i) => i.kind === "item").map((i) => i.label);
  const twice = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (twice.length) problems.push(`duplicate labels ${JSON.stringify(twice)}`);
  const odd = items.filter((i) => i.kind !== "item" && i.kind !== "separator");
  if (odd.length) problems.push(`submenus or unknown kinds ${JSON.stringify(odd)}`);
  if (items[0]?.kind === "separator") problems.push("leading separator");
  if (items.at(-1)?.kind === "separator") problems.push("trailing separator");
  items.forEach((it, i) => {
    if (i > 0 && it.kind === "separator" && items[i - 1]!.kind === "separator") problems.push(`adjacent separators at ${i}`);
  });
  return problems;
}

function capture(name: string): void {
  const path = `${SHOTS}/gtk-${layout}-${name}.png`;
  sh("import", "-window", "root", "-silent", path);
  console.log(`captured ${path}`);
}

function key(name: string, times = 1): void {
  for (let i = 0; i < times; i++) sh("xdotool", "key", "--clearmodifiers", name);
}

const results: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

const ROW = ["Reload", "Duplicate Tab", "Copy Address", "Pin Tab", "Move Tab to New Window", "Put Tab to Sleep", "Close Tab", "Close Other Tabs"];
const TILE = ["Reset to Pinned Page", "Unpin Tab", "Put Tab to Sleep", "Close Tab"];

try {
  await poll("the active tab", testIDs, (ids) => ids.has(T("t1")));
  const [w] = (await app.windows()).windows;
  for (const width of [900, 720]) {
    await app.setWindowFrame({ window: w!.ref, x: 40, y: 40, width, height: 600 });
    await Bun.sleep(800);
    const ids = await testIDs();
    const shown = ["t9", "t1", "t2", "t3"].filter((t) => ids.has(T(t)));
    results.push(`info shown at ${width}: ${shown.join(",")}`);
    const row = shown.includes("t2") ? "t2" : "t1";
    for (const [id, name, want] of [[row, "row", ROW], ["t9", "tile", TILE]] as const) {
      if (!shown.includes(id)) {
        // A narrow compact row keeps only the tab on show.
        if (compact && width < 900) results.push(`info ${name} at ${width}: not drawn in a narrow compact row`);
        else check(`${name}Shown${width}`, false, `${T(id)} is not in the tree`);
        continue;
      }
      const items = await open(T(id));
      capture(`tab-menu-${name}-${width}`);
      key("Escape");
      await Bun.sleep(400);
      const labels = items.filter((i) => i.kind === "item").map((i) => i.label);
      check(`${name}Items${width}`, JSON.stringify(labels) === JSON.stringify(want), labels.join(" | "));
      check(`${name}Shape${width}`, shapeProblems(items).length === 0, shapeProblems(items).join(", ") || "clean");
    }
  }

  // GTK's popover menu opens with its first item focused.
  await app.setWindowFrame({ window: w!.ref, x: 40, y: 40, width: 900, height: 600 });
  await Bun.sleep(800);
  const items = await open(T("t1"));
  const target = items.find((i) => i.label === "Duplicate Tab") ?? fail("no Duplicate Tab");
  key("Down", items.filter((i) => i.index < target.index && i.kind === "item" && i.enabled).length);
  key("Return");
  const ids = await poll("the duplicate", testIDs, (v) => v.has(T("t10")));
  check("duplicateTab", ids.has(T("t10")), `${T("t10")} shown`);
} finally {
  for (const line of results) console.log(line);
  await app.close().catch(() => {});
  server.stop(true);
}

const failed = results.filter((l) => l.startsWith("FAIL"));
if (failed.length) {
  console.log(`NB_LINUX_TAB_MENU_FAIL ${layout} ${failed.length} of ${results.length}`);
  process.exit(1);
}
console.log(`NB_LINUX_TAB_MENU_OK ${layout} ${results.length} checks`);
