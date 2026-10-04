#!/usr/bin/env bun
// The command bar against docs/omnibox.md, in both layouts, at a normal and a
// narrow window width. Every state is region-captured for a person to look at,
// and its geometry is asserted through the host's `paletteLayout` so a layout
// regression fails here instead of in a screenshot nobody opened.
//
//   macOS: scripts/mac-drive.sh scripts/omnibox-drive.ts (under the CEF lock)
//   Linux: scripts/headless.sh bun scripts/omnibox-drive.ts
//
// Prints NB_OMNIBOX_OK. Captures land in screenshots/omnibox/.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { type AppHandle, launchApp } from "@nativedesktop/test";

import { fail, listRows, paletteDriver, step } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = `${ROOT}/screenshots/omnibox`;
const PROFILE = process.env.NB_OMNIBOX_PROFILE ?? "/tmp/nb-omnibox-profile";
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const MAC = process.platform === "darwin";

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// A 16 px square favicon, so rows draw a real site icon.
const FAVICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGNgGF5AP//1f2LwqAGjBtDWgKEJALkH/SG/JkD7AAAAAElFTkSuQmCC",
  "base64",
);
const PAGES: Record<string, string> = {
  "/short": "Docs",
  "/long":
    "A deliberately long page title that has to truncate cleanly before it runs into the address or the action hint on the right",
  "/deep/path/that/goes/on/and/on/for/a/while/so/the/address/is/long?query=string&more=values": "Deep page",
};
/// Page loads by path, so a leg can prove a page was NOT loaded again.
const loads: Record<string, number> = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    loads[url.pathname] = (loads[url.pathname] ?? 0) + 1;
    if (url.pathname === "/favicon.png") return new Response(FAVICON, { headers: { "content-type": "image/png" } });
    const title = PAGES[`${url.pathname}${url.search}`] ?? PAGES[url.pathname] ?? "Fixture";
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<link rel="icon" href="/favicon.png"></head>` +
        `<body style="font:16px/1.5 -apple-system,sans-serif;margin:3rem;background:#f4f4f4"><h1>${title}</h1></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;
const host = `127.0.0.1:${server.port}`;

const { goTo, newTab, closePalette } = paletteDriver({ timeoutMs: PATIENCE });

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface RowLayout {
  row: Rect;
  icon: Rect | null;
  title: Rect | null;
  subtitle: Rect | null;
  hint: Rect | null;
  truncated: boolean;
  highlighted: boolean;
}
interface Layout {
  presented: boolean;
  window: Rect | null;
  panel: Rect | null;
  field: Rect | null;
  fieldText: string;
  selectionStart: number;
  selectionLength: number;
  dimmed: boolean;
  rows: RowLayout[];
}

/// The RPC is newer than the published harness, so it goes over the raw client.
async function layoutOf(app: AppHandle): Promise<Layout> {
  const rpc = (app as unknown as { rpc: { call(m: string, p: unknown): Promise<unknown> } }).rpc;
  return (await rpc.call("paletteLayout", { testId: "palette" })) as Layout;
}

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  if (!ok) problems.push(what);
}

const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;
const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

/// Everything docs/omnibox.md promises about how the bar sits and how each row
/// is laid out, for the state on screen now.
function assertLayout(l: Layout, label: string): void {
  if (!l.presented || !l.window || !l.panel || !l.field) {
    problems.push(`${label}: the bar is not presented`);
    return;
  }
  const { window: w, panel, field } = l;
  check(Math.abs(cx(panel) - w.w / 2) <= 1, `${label}: panel off centre by ${(cx(panel) - w.w / 2).toFixed(1)} px`);
  check(panel.x >= 19.5 && panel.x + panel.w <= w.w - 19.5, `${label}: panel ${JSON.stringify(panel)} inside a 20 px margin of ${w.w}`);
  check(panel.w <= 640.5, `${label}: panel ${panel.w} px wide, spec says 640`);
  check(inside(field, panel), `${label}: field ${JSON.stringify(field)} outside the panel ${JSON.stringify(panel)}`);
  check(l.dimmed, `${label}: the page behind is not dimmed`);
  l.rows.forEach((r, i) => {
    const tag = `${label} row ${i}`;
    check(inside(r.row, panel), `${tag}: row outside the panel`);
    check(r.row.h >= 36 && r.row.h <= 44, `${tag}: row ${r.row.h} px tall`);
    const parts = [r.icon, r.title, r.subtitle, r.hint].filter((p): p is Rect => p !== null);
    for (const p of parts) check(inside(p, r.row), `${tag}: part ${JSON.stringify(p)} outside its row ${JSON.stringify(r.row)}`);
    if (r.icon) {
      check(Math.abs(cy(r.icon) - cy(r.row)) <= 1, `${tag}: icon off centre by ${(cy(r.icon) - cy(r.row)).toFixed(1)} px`);
      check(r.icon.w === 16 && r.icon.h === 16, `${tag}: icon ${r.icon.w}x${r.icon.h}, want 16x16`);
    }
    if (r.title) check(Math.abs(cy(r.title) - cy(r.row)) <= 1, `${tag}: title off centre by ${(cy(r.title) - cy(r.row)).toFixed(1)} px`);
    // Same font and baseline: the three texts share a vertical centre.
    for (const p of [r.subtitle, r.hint]) {
      if (p && r.title) check(Math.abs(cy(p) - cy(r.title)) <= 1, `${tag}: text off the title's line by ${(cy(p) - cy(r.title)).toFixed(1)} px`);
    }
    // Left to right, never overlapping: icon, title, subtitle, hint.
    const order = parts.slice().sort((a, b) => a.x - b.x);
    for (let k = 1; k < order.length; k++) {
      check(order[k - 1]!.x + order[k - 1]!.w <= order[k]!.x + 0.5, `${tag}: parts overlap ${JSON.stringify(order[k - 1])} ${JSON.stringify(order[k])}`);
    }
    if (r.title) check(r.title.w <= r.row.w * 0.62 + 1, `${tag}: title ${r.title.w} px takes more than its share of ${r.row.w}`);
  });
}

/// The signed capture CLI from the main checkout: the dev host carries no
/// Screen Recording grant, and its in-process render draws neither the glass
/// card nor the header bar on macOS 26+. `--region` composites what sits over
/// the window, which is the bar itself.
const NDSHOT = process.env.ND_NDSHOT ?? `${process.env.HOME}/Developer/NativeDesktop/tools/ndshot/bin/ndshot`;

async function shot(app: AppHandle, name: string): Promise<void> {
  // Past the open transition, so the capture shows the settled bar.
  await Bun.sleep(300);
  const out = `${OUT}/${name}.png`;
  if (!MAC) {
    const r = await app.screenshot(out);
    console.log(`  captured ${out} ${r.width}x${r.height}`);
    return;
  }
  // The document window by id: `--pid` alone can match a small helper window
  // the host keeps, which captured as a blank 128 px square.
  const list = Bun.spawnSync([NDSHOT, "list"], { timeout: 30_000 });
  const windows = list.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as { pid: number; windowID: number; width: number; height: number; onScreen: boolean })
    .filter((w) => w.pid === app.pid && w.onScreen)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  if (!windows[0]) fail(`ndshot sees no window for pid ${app.pid}`);
  const run = Bun.spawnSync([NDSHOT, "capture", "--region", "--no-focus", "--window-id", String(windows[0].windowID), "--out", out], { timeout: 30_000 });
  if (run.exitCode !== 0) fail(`ndshot capture ${name}: ${run.stderr.toString().trim()}`);
  console.log(`  captured ${out}`);
}

async function waitLayout(app: AppHandle, ok: (l: Layout) => boolean, what: string): Promise<Layout> {
  const deadline = Date.now() + PATIENCE;
  let l = await layoutOf(app);
  while (Date.now() < deadline) {
    if (ok(l)) return l;
    await Bun.sleep(150);
    l = await layoutOf(app);
  }
  return fail(`${what}; last layout ${JSON.stringify({ ...l, rows: l.rows.length })}`);
}

/// No second omnibox: the bar is the only address field in either layout.
async function assertOneOmnibox(app: AppHandle, label: string): Promise<void> {
  check(!(await app.find("omnibox")), `${label}: the window draws an address field besides the bar`);
  const opener = await app.find("new-tab-search");
  check(!opener || opener.type === "Button", `${label}: the new tab page draws a ${opener?.type} field`);
}

/// The tab on show, as the control a click lands on: the only row or chip
/// drawing its close button while the pointer is elsewhere.
async function liveTab(app: AppHandle, layout: "sidebar" | "compact"): Promise<string> {
  let id = "";
  const visit = (n: { testID?: string | null; visible?: boolean; children?: unknown[] }) => {
    const m = n.testID?.match(/^tab-close-(.+)$/);
    if (!id && m && n.visible) id = m[1]!;
    for (const c of (n.children ?? []) as (typeof n)[]) visit(c);
  };
  visit((await app.tree()).root as never);
  if (!id) fail(`${layout}: no tab draws its close button`);
  return layout === "compact" ? `tab-item-${id}` : `tab-${id}`;
}

const app = await launchApp({
  entry: "src/main.tsx",
  backend: MAC ? "appkit" : "gtk",
  cwd: ROOT,
  env: {
    NB_STORE_DIR: PROFILE,
    NB_TEST_HOOKS: "1",
    ND_AUTOMATION_CAPTURE: "region",
    ND_APP_ID: "dev.nativebrowser.omnibox",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  logPath: `${OUT}/host.log`,
});

try {
  // History and tabs worth ranking: a short title, a long one, a long address.
  await goTo(app, `${base}/short`);
  await Bun.sleep(1200);
  await newTab(app, `${base}/long`);
  await Bun.sleep(1200);
  await newTab(app, `${base}/deep/path/that/goes/on/and/on/for/a/while/so/the/address/is/long?query=string&more=values`);
  // Completion reads history, and a visit is written when its page commits.
  // The bar asks history only as it is typed into, so the three pages have to
  // have loaded (their titles are in the tab list) before anything is typed.
  await step("the three pages have loaded", async () => {
    const want = Object.values(PAGES);
    const deadline = Date.now() + PATIENCE;
    let titles: string[] = [];
    while (Date.now() < deadline) {
      const list = await app.find("tab-list");
      titles = list ? listRows(list).map((r) => r.title) : [];
      if (want.every((t) => titles.includes(t))) return;
      await Bun.sleep(200);
    }
    return fail(`the tab list reads ${JSON.stringify(titles)}`);
  });

  // The tab-stepping chords reach the app menu even with the page focused:
  // they are punctuation, which the engine used to keep for the page.
  // AppKit localizes menu key equivalents to the keyboard in use (on Spanish
  // ISO, Shift+Cmd+] is drawn and matched as Shift+Cmd+´), and a synthetic
  // key event carries no physical key to localize, so the chord is driven
  // only where the menu keeps the US spelling.
  const layout = MAC
    ? Bun.spawnSync(["defaults", "read", "com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"]).stdout.toString().trim()
    : "";
  const usLayout = /\.(US|ABC)$/.test(layout);
  if (MAC && !usLayout) console.log(`  tab-step chord leg skipped: keyboard layout ${layout}`);
  if (MAC && usLayout) {
    const activeTitle = async () => String((await app.windows()).windows[0]?.title ?? "");
    const before = await activeTitle();
    await app.keyboard.press("Meta+Shift+[");
    await Bun.sleep(800);
    const stepped = await activeTitle();
    check(stepped !== before, `Shift+Cmd+[ left the window on ${JSON.stringify(before)}`);
    await app.keyboard.press("Meta+Shift+]");
    await Bun.sleep(800);
    check((await activeTitle()) === before, `Shift+Cmd+] did not step back to ${JSON.stringify(before)}`);
  }

  for (const layout of ["sidebar", "compact"] as const) {
    for (const [width, height, size] of [
      [1280, 820, "normal"],
      [720, 700, "narrow"],
    ] as const) {
      const tag = `${layout}-${size}`;
      await app.setWindowSize(width, height);
      await Bun.sleep(700);

      // ⌘T: an empty bar, the page dimmed behind it.
      await step(`${tag}: Cmd+T`, () => app.click("menu-new-tab"));
      let l = await waitLayout(app, (x) => x.presented && x.rows.length > 0, `${tag}: the bar never presented with rows`);
      check(l.fieldText === "", `${tag}: Cmd+T bar came up holding ${JSON.stringify(l.fieldText)}`);
      assertLayout(l, `${tag} cmd-t`);
      await assertOneOmnibox(app, `${tag} cmd-t`);
      await shot(app, `${tag}-cmd-t`);

      // Typing the start of a visited host completes it inline.
      if (MAC) {
        await app.keyboard.type("127.0");
      } else {
        await app.type("palette", "127.0");
      }
      l = await waitLayout(app, (x) => x.fieldText.length > 5, `${tag}: no inline completion for "127.0"`);
      check(l.fieldText === host, `${tag}: completed to ${JSON.stringify(l.fieldText)}, want ${host}`);
      check(l.selectionStart === 5 && l.selectionLength === host.length - 5, `${tag}: completion selection ${l.selectionStart}+${l.selectionLength}`);
      check(l.rows[0]?.highlighted === true, `${tag}: the completed row is not highlighted`);
      assertLayout(l, `${tag} completion`);
      await shot(app, `${tag}-completion`);

      if (MAC) {
        await app.keyboard.press("Backspace");
        l = await waitLayout(app, (x) => x.fieldText === "127.0", `${tag}: Backspace did not remove the completion`);
        check(l.selectionLength === 0, `${tag}: Backspace left a selection`);
        await Bun.sleep(400);
        l = await layoutOf(app);
        check(l.fieldText === "127.0", `${tag}: the completion came straight back after Backspace (${l.fieldText})`);
        await app.keyboard.type(".");
        l = await waitLayout(app, (x) => x.fieldText === host, `${tag}: typing on did not complete again`);
        await app.keyboard.press("Tab");
        l = await waitLayout(app, (x) => x.selectionLength === 0, `${tag}: Tab did not accept the completion`);
        check(l.fieldText === host && l.selectionStart === host.length, `${tag}: after Tab the field is ${JSON.stringify(l.fieldText)} caret ${l.selectionStart}`);
      }

      // A query that matches the long rows: truncation, not clipping.
      if (MAC) {
        await app.keyboard.press("Meta+A");
        await app.keyboard.type("long");
      } else {
        await app.setValue("palette", "");
        await app.type("palette", "long");
      }
      l = await waitLayout(app, (x) => x.rows.some((r) => r.truncated), `${tag}: no truncated row for the long title`);
      assertLayout(l, `${tag} long`);
      await shot(app, `${tag}-long`);
      await closePalette(app);

      // ⌘K: the switcher, open tabs first and the most recent highlighted.
      await step(`${tag}: Cmd+K`, () => app.click("menu-palette"));
      l = await waitLayout(app, (x) => x.presented && x.rows.length > 0, `${tag}: the switcher never listed rows`);
      check(l.rows[0]?.highlighted === true, `${tag}: the switcher's first row is not highlighted`);
      const switcherIds = ((await app.mustFind("palette")).rows ?? []).map((r) => r.id ?? "");
      check(switcherIds[0]?.startsWith("tab:") === true, `${tag}: the switcher starts with ${switcherIds[0]}`);
      check(switcherIds.includes("cmd:copy-address"), `${tag}: the switcher lacks the commands`);
      assertLayout(l, `${tag} switcher`);
      await shot(app, `${tag}-switcher`);
      await closePalette(app);

      // ⌘L: the address, all of it selected.
      await step(`${tag}: Cmd+L`, () => app.click("menu-address"));
      l = await waitLayout(app, (x) => x.presented && x.fieldText !== "", `${tag}: Cmd+L bar never presented`);
      check(l.fieldText.includes("/deep/path"), `${tag}: Cmd+L holds ${JSON.stringify(l.fieldText)}`);
      check(l.selectionStart === 0 && l.selectionLength === l.fieldText.length, `${tag}: Cmd+L selection ${l.selectionStart}+${l.selectionLength} of ${l.fieldText.length}`);
      assertLayout(l, `${tag} cmd-l`);
      await assertOneOmnibox(app, `${tag} cmd-l`);
      await shot(app, `${tag}-cmd-l`);

      // Opening again while open reseeds it, and it is still one bar.
      await step(`${tag}: Cmd+T over Cmd+L`, () => app.click("menu-new-tab"));
      l = await waitLayout(app, (x) => x.presented && x.fieldText === "", `${tag}: Cmd+T over an open bar kept ${JSON.stringify(l.fieldText)}`);
      await closePalette(app);

      // A click on the tab on show does what Cmd+L does, in both layouts.
      const live = await liveTab(app, layout);
      await step(`${tag}: click ${live}`, () => app.click(live));
      l = await waitLayout(app, (x) => x.presented && x.fieldText !== "", `${tag}: a click on the tab on show never presented the bar`);
      check(l.fieldText.includes("/deep/path"), `${tag}: the tab opened the bar on ${JSON.stringify(l.fieldText)}`);
      check(l.selectionStart === 0 && l.selectionLength === l.fieldText.length, `${tag}: from the tab, selection ${l.selectionStart}+${l.selectionLength} of ${l.fieldText.length}`);
      assertLayout(l, `${tag} from-tab`);
      await assertOneOmnibox(app, `${tag} from-tab`);
      await shot(app, `${tag}-from-tab`);
      await closePalette(app);
    }
    if (layout === "sidebar") {
      await step("switch to the compact layout", () => app.click("menu-layout"));
      await Bun.sleep(1200);
    }
  }
  await step("back to the sidebar layout", () => app.click("menu-layout"));
} finally {
  await app.close();
  server.stop();
}

if (problems.length) {
  console.error(`NB_OMNIBOX_FAIL ${problems.length}\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("NB_OMNIBOX_OK");
