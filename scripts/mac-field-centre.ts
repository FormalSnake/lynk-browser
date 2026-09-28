#!/usr/bin/env bun
// The compact row's address field on macOS: its text, placeholder and leading
// glyph sit on the middle of the capsule the toolbar draws around it. Captures
// the live window with ndshot at a normal and a narrow width, empty and with a
// long URL and while editing, and reads the rows off each capture with the framework's
// scripts/mac/field-ink.swift: the caps (top to baseline) and the glyph must
// each share the capsule's middle within 1 px.
//
//   ND_APPEARANCE=dark bun scripts/mac-field-centre.ts
//
// Needs ND_FRAMEWORK_DIR on a checkout that has field-ink.swift. Captures land
// in screenshots/field-centre/. Prints NB_FIELD_CENTRE_OK.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findNode, launchApp } from "@nativedesktop/test";

import { FRAMEWORK, fail, ndshotCapture, ndshotWindows, step } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = `${ROOT}/screenshots/field-centre`;
const appearance = process.env.ND_APPEARANCE ?? "light";
const STORE = `/tmp/nb-field-centre-${appearance}`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const LONG = "/articles/2026/09/a-rather-long-path-that-runs-past-the-end-of-the-address-field?utm_source=field-centre";

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(`<!doctype html><title>Fixture</title><body style="font:16px system-ui;margin:48px">Fixture</body>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
});
const url = `http://127.0.0.1:${server.port}${LONG}`;

writeFileSync(
  `${STORE}/settings.json`,
  JSON.stringify({
    version: 1,
    data: { searchEngine: "google", homepage: "", restoreOnLaunch: true, layout: "compact", sitePermissions: {}, pinnedExtensions: [] },
  }),
);
writeFileSync(
  `${STORE}/session.json`,
  JSON.stringify({
    version: 1,
    data: { tabs: [{ id: "t1", url, title: "Fixture", pinned: false }], activeId: "t1", nextTabId: 2, windowWidth: 1280, windowHeight: 820, zoomByHost: {} },
  }),
);

const app = await launchApp({ entry: "src/main.tsx", env: { NB_STORE_DIR: STORE, ND_APPEARANCE: appearance } });
let bad = 0;
try {
  await app.waitForPresent("omnibox", { timeoutMs: PATIENCE });
  const field = async () => {
    const g = findNode((await app.tree()).root, "omnibox")?.geometry;
    if (!g || g.w <= 0) fail(`the address field never laid out (${JSON.stringify(g)})`);
    return g;
  };
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 820);
    await Bun.sleep(800);
    for (const [state, text] of [["filled", url], ["empty", ""], ["editing", "example.com"]] as const) {
      await step(`${width} ${state}`, async () => {
        await app.getByTestId("omnibox").fill(text);
        // Editing draws through the field editor, which AppKit places apart
        // from the cell's own text. Focus selects the whole address, so there
        // the "text" rows are the selection band around it.
        if (state === "editing") await app.getByTestId("omnibox").focus();
        await Bun.sleep(400);
        const f = await field();
        const win = ndshotWindows(app.pid).find((w) => w.title !== "Private Browsing") ?? fail("ndshot saw no app window");
        const path = ndshotCapture(win.windowID, `field-centre/${appearance}-${width}-${state}`);
        const s = (await Bun.file(path).arrayBuffer().then((b) => new DataView(b).getUint32(16))) / win.width;
        const px = (v: number) => String(Math.round(v * s));
        // Glyph columns from 10pt in, clear of the capsule's round end; text
        // from the cell's 30pt inset to 40pt short of the end, where the
        // cancel button starts.
        const probe = Bun.spawnSync(
          ["swift", `${FRAMEWORK}/scripts/mac/field-ink.swift`, path, px(f.x), px(f.y), px(f.w), px(f.h), px(f.x + 10), px(f.x + 30), px(f.x + f.w - 40)],
          { env: { ...process.env, SDKROOT: undefined, DEVELOPER_DIR: undefined } },
        );
        if (probe.exitCode !== 0) fail(`field-ink: ${probe.stderr.toString().trim()}`);
        const ink = JSON.parse(probe.stdout.toString()) as { bezel: [number, number]; icon: [number, number] | null; text: [number, number, number] };
        if (!ink.icon) fail(`no leading glyph ink (${path})`);
        const mid = (ink.bezel[0] + ink.bezel[1]) / 2;
        const textOff = (ink.text[0] + ink.text[1]) / 2 - mid;
        const iconOff = (ink.icon[0] + ink.icon[1]) / 2 - mid;
        const ok = Math.abs(textOff) <= 1 && Math.abs(iconOff) <= 1;
        if (!ok) bad++;
        console.log(
          `  ${ok ? "ok  " : "FAIL"} ${appearance} ${width} ${state}: field ${f.w}x${f.h}pt, capsule rows ${ink.bezel.join("..")}, ` +
            `text ${ink.text[0]}..${ink.text[1]} (above ${ink.text[0] - ink.bezel[0]}px, below ${ink.bezel[1] - ink.text[1]}px) off ${textOff.toFixed(1)}px, ` +
            `glyph ${ink.icon.join("..")} (above ${ink.icon[0] - ink.bezel[0]}px, below ${ink.bezel[1] - ink.icon[1]}px) off ${iconOff.toFixed(1)}px  ${path}`,
        );
      });
    }
  }
  if (bad > 0) fail(`${bad} state(s) off the capsule's middle`);
  console.log(`NB_FIELD_CENTRE_OK ${appearance}`);
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
