#!/usr/bin/env bun
// Captures the compact row and the new tab page for a side-by-side reading
// against the owner's reference. Not an acceptance drive: it asserts nothing,
// it only puts the app in a known state and shoots it. Run it once per colour
// scheme (ADW_DEBUG_COLOR_SCHEME=prefer-light / prefer-dark), and pass the
// scheme as argv[2] so the captures do not overwrite each other.
//
//   ADW_DEBUG_COLOR_SCHEME=prefer-dark scripts/headless.sh bun scripts/compact-shots.ts dark
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { launchApp } from "@nativedesktop/test";
import { SHOTS, fail, shoot } from "./drive-lib.ts";

const scheme = process.argv[2] ?? "light";
const STORE = `/tmp/nb-shots-${scheme}`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    const title = { "/news": "The Morning Briefing", "/docs": "Widget reference", "/mail": "Inbox (3)" }[path] ?? path;
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font:16px system-ui;margin:48px"><h1>${title}</h1><p>Fixture page for the capture run.</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

const tabs = [
  { id: "t1", url: `${base}/mail`, title: "Inbox (3)", pinned: true },
  { id: "t2", url: `${base}/news`, title: "The Morning Briefing", pinned: false },
  { id: "t3", url: `${base}/docs`, title: "Widget reference", pinned: false },
];

function seed(layout: "compact" | "sidebar", activeId: string): void {
  writeFileSync(
    `${STORE}/settings.json`,
    JSON.stringify({
      version: 1,
      data: { searchEngine: "google", homepage: "", restoreOnLaunch: true, layout, sitePermissions: {}, pinnedExtensions: [] },
    }),
  );
  writeFileSync(
    `${STORE}/session.json`,
    JSON.stringify({
      version: 1,
      data: { tabs, activeId, nextTabId: 4, windowWidth: 1280, windowHeight: 820, zoomByHost: {} },
    }),
  );
}

async function capture(layout: "compact" | "sidebar", activeId: string, name: string): Promise<void> {
  seed(layout, activeId);
  const app = await launchApp({ entry: "src/main.tsx", env: { NB_STORE_DIR: STORE } });
  try {
    await app.waitForPresent("omnibox", { timeoutMs: PATIENCE });
    // The row is drawn from the session, but the titles only settle once each
    // restored tab's own page has reported one.
    if (activeId !== "") await app.waitFor({ testId: "omnibox", state: "present" }, { timeoutMs: PATIENCE });
    await Bun.sleep(6000);
    await shoot(app, `${name}-${scheme}`);
  } finally {
    await app.close().catch(() => {});
  }
}

try {
  await capture("compact", "t2", "shot-compact");
  // Two tabs at the same width: the address field has to take everything the
  // tabs do not, which is what the reference shows.
  const many = tabs.splice(0, tabs.length, ...tabs.slice(1));
  await capture("compact", "t2", "shot-compact-two");
  tabs.splice(0, tabs.length, ...many);
  await capture("sidebar", "t2", "shot-sidebar");
  // A blank active tab, which is the new tab page.
  tabs.push({ id: "t4", url: "", title: "", pinned: false });
  await capture("compact", "t4", "shot-new-tab");
  console.log(`NB_SHOTS_OK ${scheme}`);
} catch (e) {
  fail(`capture run failed: ${(e as Error).message}`);
} finally {
  server.stop(true);
}
