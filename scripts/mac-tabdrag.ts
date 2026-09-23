#!/usr/bin/env bun
// Tab dragging on macOS, through the real system cursor (`app.cursor`): the
// press, the drag session and the drop are the window server's, not events
// posted into the app's queue. Two windows side by side in the compact
// layout; a counter page with a filled field is dragged within its window,
// into the other window and back, and the other window's last tab is dragged
// out of it so that window closes. A move between windows must carry the
// LIVE page: the counter keeps counting, the field keeps its value, and the
// fixture serves no second load.
//
// Moves the user's cursor and holds the machine-wide mac gate lock:
//   bash -c '. ~/Developer/nd-startup-window/scripts/mac/cef-gate-lock.sh; cef_gate_lock;
//     trap cef_gate_unlock EXIT; ND_CEF_CACHE=$RUN_DIR/cache bun scripts/mac-tabdrag.ts'
// The host needs Accessibility once: `<host> --nd-grant` with SIP off.
// Marker: NB_MAC_TABDRAG_OK.
//
// Red at leg 2 on NativeDesktop 0.4.16: a drop target inside a header bar
// reports dragOver/dropped x 19 pt left of the pointer (a cursor sweep in
// 1.35 pt steps comes back in the same steps, shifted), so a drop lands one
// slot early. The chips' tree geometry matches a capture, so the aim is right
// and the offset is the host's (DragDrop.swift ndDragPoint).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";

const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
const SHOTS = resolve(import.meta.dir, "../screenshots");
mkdirSync(SHOTS, { recursive: true });
const store = mkdtempSync(join(tmpdir(), "nb-mac-tabdrag-"));

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------- fixture ---

const loads: Record<string, number> = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    loads[key] = (loads[key] ?? 0) + 1;
    const body =
      key === "counter"
        ? '<input id="field"><script>let n = 0; const f = document.getElementById("field");' +
          " const show = () => { document.title = `Counter c=${n} f=${f.value}`; };" +
          ' setInterval(() => { n++; show(); }, 500); f.addEventListener("input", show);' +
          ' window.nbTest = () => { f.value = "typed-by-drive"; f.dispatchEvent(new Event("input")); };</script>'
        : `<h1>${key}</h1>`;
    return new Response(`<!doctype html><title>Page ${key}</title>${body}`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const base = `http://127.0.0.1:${server.port}`;

// Two windows, restored from the store: the counter and page A in w1, page B
// in w2. The compact row is the one that carries draggable tabs.
const tab = (id: string, path: string) => ({ id, url: `${base}/${path}`, title: "", pinned: false });
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [
        { id: "w1", tabs: [tab("t1", "counter"), tab("t2", "a")], activeId: "t1", width: 760, height: 520 },
        { id: "w2", tabs: [tab("t3", "b")], activeId: "t3", width: 760, height: 520 },
      ],
      nextTabId: 4,
      nextWindowId: 3,
      zoomByHost: {},
    },
  }),
);
writeFileSync(
  join(store, "settings.json"),
  JSON.stringify({
    version: 1,
    data: {
      searchEngine: "duckduckgo",
      homepage: "",
      restoreOnLaunch: true,
      layout: "compact",
      pinnedExtensions: [],
      sitePermissions: {},
    },
  }),
);

const moves: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  env: {
    NB_STORE_DIR: store,
    NB_TEST_HOOKS: "1",
    NB_TEST_JS: "window.nbTest && window.nbTest()",
    ND_AUTOMATION_CAPTURE: "region",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    if (/ND_APP (MOVE|DROP) /.test(line)) moves.push(line.trim());
  },
});

// ---------------------------------------------------------------- helpers ---

async function poll<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + PATIENCE;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    await Bun.sleep(150);
    last = await read();
  }
  return last;
}

function find(root: JsonNode, testID: string): JsonNode | null {
  if (root.testID === testID) return root;
  for (const c of root.children) {
    const hit = find(c, testID);
    if (hit) return hit;
  }
  return null;
}

/// Each window's ref, keyed by its root testID, and its global top-left.
async function windowFrames(): Promise<Map<string, { ref: number; x: number; y: number }>> {
  const { windows } = await app.windows();
  const out = new Map<string, { ref: number; x: number; y: number }>();
  for (const info of windows) {
    const root = (await app.tree(info.ref)).root;
    if (root.testID && info.geometry) out.set(root.testID, { ref: info.ref, x: info.geometry.x, y: info.geometry.y });
  }
  return out;
}

/// A node's centre, or a point along it, in the coordinates `app.cursor`
/// takes: relative to the first window `windows()` lists, whichever window
/// the node is in.
async function pointOn(windowTestID: string, testID: string, fx = 0.5): Promise<{ x: number; y: number }> {
  const frames = await windowFrames();
  const own = frames.get(windowTestID) ?? fail(`no window ${windowTestID}`);
  const { windows } = await app.windows();
  const origin = windows[0]!.geometry!;
  const tree = await app.tree(own.ref);
  const node = find(tree.root, testID) ?? fail(`no ${testID} in ${windowTestID}`);
  const g = node.geometry ?? fail(`${testID} has no geometry`);
  return { x: own.x - origin.x + g.x + g.w * fx, y: own.y - origin.y + g.y + g.h / 2 };
}

/// The tab ids a window's compact row is drawing, in order.
async function rowOf(windowTestID: string, prefix: string): Promise<string[]> {
  const frames = await windowFrames();
  const own = frames.get(windowTestID);
  if (!own) return [];
  const strip = find((await app.tree(own.ref)).root, `${prefix}tab-strip`);
  const ids: string[] = [];
  const walk = (n: JsonNode): void => {
    const m = n.testID?.startsWith(`${prefix}tab-item-`) ? n.testID.slice(`${prefix}tab-item-`.length) : null;
    if (m) ids.push(m);
    n.children.forEach(walk);
  };
  if (strip) walk(strip);
  return ids;
}

const counterRe = /Counter c=(\d+) f=([^\s(]*)/;
async function counter(windowTestID: string, prefix: string): Promise<{ c: number; f: string } | null> {
  const frames = await windowFrames();
  const own = frames.get(windowTestID);
  if (!own) return null;
  const item = find((await app.tree(own.ref)).root, `${prefix}tab-item-t1`);
  // A titled chip shows the title; one narrowed to its icon reports the title
  // and address through its text instead.
  const m = counterRe.exec(item?.label ?? item?.text ?? "");
  return m ? { c: Number(m[1]), f: m[2]! } : null;
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // A pause on each side: AppKit starts a drag session only once the press
  // has been held and moved, and a drop needs one draggingUpdated first.
  await app.cursor.move(from, { steps: 8 });
  await app.cursor.down();
  await Bun.sleep(150);
  await app.cursor.move({ x: from.x + 12, y: from.y + 4 }, { steps: 6 });
  await app.cursor.move(to, { steps: 30 });
  await Bun.sleep(250);
  await app.cursor.up();
}

async function shot(name: string, windowTestID: string): Promise<void> {
  const own = (await windowFrames()).get(windowTestID);
  if (own) await app.screenshot(`${SHOTS}/${name}.png`, { window: own.ref }).catch(() => {});
}

// ------------------------------------------------------------------ drive ---

try {
  await app.waitForWindows(2, PATIENCE);
  const frames = await windowFrames();
  const w1 = frames.get("main-window") ?? fail(`windows are ${JSON.stringify([...frames.keys()])}`);
  const w2 = frames.get("w2-window") ?? fail(`windows are ${JSON.stringify([...frames.keys()])}`);
  // Side by side, so each window's row is on screen for the other's drag.
  await app.setWindowFrame({ window: w1.ref, x: 40, y: 80, width: 760, height: 520 });
  await app.setWindowFrame({ window: w2.ref, x: 820, y: 80, width: 760, height: 520 });
  await poll("the counter page running", () => counter("main-window", ""), (v) => v !== null);
  await app.click("menu-run-test-js");
  const start = await poll("the field filled", () => counter("main-window", ""), (v) => v?.f === "typed-by-drive");
  if (loads.counter !== 1) fail(`the counter loaded ${loads.counter} times before any drag`);
  console.log(`1. two windows side by side, counter at c=${start!.c} with its field filled`);

  // Within w1: t1 dragged past the middle of t2 lands after it.
  await drag(await pointOn("main-window", "tab-item-t1"), await pointOn("main-window", "tab-item-t2", 0.85));
  await poll("t1 after t2 in w1", () => rowOf("main-window", ""), (ids) => ids.join() === "t2,t1");
  if (loads.counter !== 1) fail(`reordering reloaded the page: ${loads.counter} loads`);
  console.log(`2. drag within the window reorders it: ${moves.at(-1)}`);

  // Into w2, after its one tab: the live page moves.
  await drag(await pointOn("main-window", "tab-item-t1"), await pointOn("w2-window", "w2-tab-item-t3", 0.9));
  await poll("t1 in w2", () => rowOf("w2-window", "w2-"), (ids) => ids.join() === "t3,t1");
  if ((await rowOf("main-window", "")).includes("t1")) fail("t1 is still drawn in w1");
  const inW2 = await poll("the counter ticking on in w2", () => counter("w2-window", "w2-"), (v) => (v?.c ?? -1) > start!.c);
  if (inW2!.f !== "typed-by-drive") fail(`the field came across as ${JSON.stringify(inW2!.f)}`);
  if (loads.counter !== 1) fail(`the move into w2 reloaded the page: ${loads.counter} loads`);
  await shot("mac-tabdrag-w2", "w2-window");
  console.log(`3. drag into the other window moved the live page: c ${start!.c} -> ${inW2!.c}, field kept, loads=1; ${moves.at(-1)}`);

  // Back to w1, before its one tab.
  await drag(await pointOn("w2-window", "w2-tab-item-t1"), await pointOn("main-window", "tab-item-t2", 0.1));
  await poll("t1 back first in w1", () => rowOf("main-window", ""), (ids) => ids.join() === "t1,t2");
  const back = await poll("the counter ticking on in w1", () => counter("main-window", ""), (v) => (v?.c ?? -1) > inW2!.c);
  if (back!.f !== "typed-by-drive" || loads.counter !== 1) fail(`came back as ${JSON.stringify(back)}, loads ${loads.counter}`);
  console.log(`4. and back: c ${inW2!.c} -> ${back!.c}, field kept, loads=1`);

  // w2's last tab into w1: the emptied window closes.
  await drag(await pointOn("w2-window", "w2-tab-item-t3"), await pointOn("main-window", "tab-item-t2", 0.9));
  await app.waitForWindows(1, PATIENCE);
  await poll("t3 in w1", () => rowOf("main-window", ""), (ids) => ids.join() === "t1,t2,t3");
  if (loads.b !== 1) fail(`page B reloaded on its move: ${loads.b} loads`);
  await shot("mac-tabdrag-w1", "main-window");
  console.log("5. dragging a window's last tab out closes that window; page B kept its one load");

  console.log("NB_MAC_TABDRAG_OK");
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  for (const [w, prefix] of [["main-window", ""], ["w2-window", "w2-"]] as const) {
    const own = (await windowFrames().catch(() => new Map())).get(w);
    if (!own) continue;
    const root = (await app.tree(own.ref)).root;
    const strip = find(root, `${prefix}tab-strip`);
    const chips = (await rowOf(w, prefix)).map((id) => `${id}@${JSON.stringify(find(root, `${prefix}tab-slot-${id}`)?.geometry)}`);
    console.error(`${w} strip=${JSON.stringify(strip?.geometry)} ${chips.join(" ")}`);
  }
  console.error(moves.join("\n"));
  process.exitCode = 1;
} finally {
  await app.close();
  server.stop(true);
}
