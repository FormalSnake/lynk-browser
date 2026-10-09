#!/usr/bin/env bun
// Landing-page captures on Windows: the sidebar with live sites, then the
// command bar with "formal" typed, the blog in the compact layout, and an
// article in reading mode. Copy into a Lynk checkout's scripts/ (it
// imports ./drive-lib.ts) and run it there through gui.ps1.
// Writes screenshots/site/windows-{boot,hero,command-bar,compact,reader}.png.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { type AppHandle, launchApp } from "@nativedesktop/test";
import { SHOTS, fail, paletteDriver, step, walk } from "./drive-lib.ts";

const OUT = join(SHOTS, "site");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 90_000);
const SCRATCH = resolve(tmpdir(), "nb-site-shots");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, "store"), { recursive: true });
mkdirSync(OUT, { recursive: true });

const pinned = ["https://www.formalsnake.dev/", "https://github.com/FormalSnake", "https://www.youtube.com/", "https://en.wikipedia.org/wiki/Web_browser"];
const rows = ["https://www.formalsnake.dev/blog", "https://www.formalsnake.dev/projects", "https://github.com/FormalSnake", "https://en.wikipedia.org/wiki/Web_browser"];
const tabs = [
  ...pinned.map((url, i) => ({ id: `t${i + 1}`, url, title: "", pinned: true, pinnedUrl: url })),
  ...rows.map((url, i) => ({ id: `t${i + 5}`, url, title: "", pinned: false })),
];
writeFileSync(join(SCRATCH, "store", "session.json"), JSON.stringify({
  version: 2,
  data: { windows: [{ id: "w1", tabs, activeId: "t1", width: 1440, height: 900 }], nextTabId: 9, nextWindowId: 2, zoomByHost: {} },
}));

const ARTICLE = "https://www.formalsnake.dev/blog/12-my-coding-setup";
const lines: string[] = [];
const { openPalette, typeQuery, goTo, closePalette } = paletteDriver({ timeoutMs: PATIENCE });
const app: AppHandle = await launchApp({
  entry: "src/main.tsx",
  env: {
    NB_STORE_DIR: join(SCRATCH, "store"),
    NB_DOWNLOAD_DIR: join(SCRATCH, "downloads"),
    APPDATA: join(SCRATCH, "data"),
    NB_TEST_HOOKS: "1",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    lines.push(line);
  },
});

async function shot(name: string): Promise<void> {
  const { windows } = await app.windows();
  const path = join(OUT, `${name}.png`);
  const out = await app.screenshot(path, { window: windows[0]!.ref, minBytes: 1000 });
  console.log(`captured ${path} ${out.width}x${out.height}`);
}

/// View > Tabs lists every tab of the window; its items select them.
async function selectTab(match: (label: string) => boolean): Promise<void> {
  const items: { id: string; label: string }[] = [];
  walk((await app.tree()).root, (n) => {
    if (/^menu-tab-\d+$/.test(n.testID ?? "")) items.push({ id: n.testID!, label: n.text ?? "" });
  });
  const hit = items.find((i) => match(i.label)) ?? fail(`no tab matched among ${JSON.stringify(items.map((i) => i.label))}`);
  await app.click(hit.id);
}

async function readerOn(): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  while (!lines.some((l) => /ND_APP READER t\d+ on/.test(l))) {
    const failed = lines.find((l) => l.includes("ND_APP READER failed"));
    if (failed) fail(failed);
    if (Date.now() > deadline) fail("reading mode never came up");
    await Bun.sleep(150);
  }
}

try {
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  await Bun.sleep(4000);
  await shot("windows-boot");
  // Each restored tab loads on first show; showing every one fills the favicon cache.
  for (const t of tabs.slice(1)) {
    await step(`show ${t.id}`, () => app.click(`tab-${t.id}`)).catch((e) => console.log(`WARN ${e.message}`));
    await Bun.sleep(8000);
  }
  await step("show t1", () => app.click("tab-t1"));
  await Bun.sleep(8000);
  const { windows } = await app.windows();
  console.log(`windows ${JSON.stringify(windows)}`);
  await shot("windows-hero");
  await openPalette(app);
  await typeQuery(app, "formal");
  await Bun.sleep(7000);
  await shot("windows-command-bar");
  // Esc, which the WinUI host cannot synthesise: the test-only item runs its handler.
  await closePalette(app);
  await Bun.sleep(800);

  await step("select the blog", () => selectTab((l) => /blog/i.test(l)));
  await Bun.sleep(6000);
  await step("switch to the compact layout", () => app.click("menu-layout"));
  await Bun.sleep(4000);
  await shot("windows-compact");
  await step("back to the sidebar layout", () => app.click("menu-layout"));
  await Bun.sleep(2000);

  await step("open the article", () => goTo(app, ARTICLE));
  await Bun.sleep(10000);
  await step("enter reading mode", () => app.click("menu-reader"));
  await readerOn();
  await Bun.sleep(3000);
  await shot("windows-reader");
  console.log("NB_SITE_SHOTS_OK");
} catch (e) {
  console.error(`run failed: ${(e as Error).message}`);
  console.error(app.stderrTail(60));
  try { await shot("windows-failed"); } catch {}
} finally {
  await app.close().catch(() => {});
}
