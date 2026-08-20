#!/usr/bin/env bun
// The Chrome Web Store consent flow, against the live store. NOT part of any
// gate: it needs the network, and what Google serves a European visitor
// changes without notice, so a red run here is a question rather than a
// verdict. The mechanism it covers is gated offline instead — the framework's
// redirect-echo and cookie-persistence checks (scripts/headless-webview.sh)
// and the cookie round trip in scripts/browser-drive.ts.
//
// Run it after touching the store hook, the user agent flip, or anything in the
// engine's navigation path:
//
//   scripts/headless.sh bun scripts/webstore-consent-check.ts
//
// What it asserts, in order: the listing bounces to consent.google.com, the
// consent button lands (one click, not two), the browser ends up on the listing
// with its install control present, and the tab did not thrash getting there.
// The last one is the regression that matters: a listing reached through
// consent used to leave the app and the engine correcting each other's address
// forever, which ate the runtime's memory until it died and took the window
// with it.
import { mkdirSync, rmSync } from "node:fs";

import { launchApp } from "@nativedesktop/test";

import { ENGINE_ENV, paletteDriver } from "./drive-lib.ts";

const STORE_DIR = "/tmp/nb-consent-check-store";
const DATA_HOME = "/tmp/nb-consent-check-data";
const LISTING =
  process.env.NB_CONSENT_LISTING ??
  "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh";
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

// A load that never settles is the failure this script exists to catch, so
// every wait here is bounded and reports what it last saw.
const started = Date.now();
const say = (line: string): void => console.log(`[${String(Date.now() - started).padStart(6, " ")}ms] ${line}`);

function fail(message: string): never {
  throw new Error(message);
}

rmSync(STORE_DIR, { recursive: true, force: true });
rmSync(DATA_HOME, { recursive: true, force: true });
mkdirSync(STORE_DIR, { recursive: true });

/// Every `setUrl` the host issued. One navigation costs one line; the loop this
/// script guards against produced thousands.
const loads: string[] = [];

const app = await launchApp({
  entry: "src/main.tsx",
  env: {
    ...ENGINE_ENV,
    NB_STORE_DIR: STORE_DIR,
    NB_DOWNLOAD_DIR: "/tmp/nb-consent-check-downloads",
    XDG_DATA_HOME: DATA_HOME,
    ND_APP_ID: "dev.nativebrowser.consentcheck",
    ND_WEBVIEW_TRACE: "1",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    if (line.includes("ND_WV") && line.includes("setUrl")) loads.push(line.trim());
  },
});

const PAGE = "page-t1";

/// The tab's view is not queryable the instant the app has been told to
/// navigate — it arms a render later — so a lookup that fails is "not yet",
/// not a verdict. `waitForUrl` is the only caller and it has the deadline.
async function pageUrl(): Promise<string> {
  try {
    const info = await app.rpc.call("webviewInfo", { testId: PAGE });
    return String(info.url ?? "");
  } catch (error) {
    return `<${(error as Error).message}>`;
  }
}

async function evalPage(code: string): Promise<string> {
  const answer = await app.rpc.call("webviewEval", { testId: PAGE, code, timeoutMs: 20_000 });
  return answer.ok ? String(answer.value) : fail(`page eval failed: ${answer.error}`);
}

/// Polls the ENGINE's address rather than the app's, so a drive assertion can
/// never be satisfied by app state the engine disagrees with.
async function waitForUrl(contains: string, what: string): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  while (Date.now() < deadline) {
    last = await pageUrl();
    if (last.includes(contains)) return last;
    await Bun.sleep(250);
  }
  return fail(`timed out waiting for ${what}; the engine is on ${JSON.stringify(last)}`);
}

/// The consent screen has one accept control and several decorative buttons;
/// match on the accessible name the way a person reads it.
const CLICK_ACCEPT = `(function () {
  var all = [].slice.call(document.querySelectorAll('button,[role=button],input[type=submit]'));
  for (var i = 0; i < all.length; i++) {
    var label = (all[i].getAttribute('aria-label') || all[i].textContent || '').trim();
    if (/^accept all/i.test(label)) { all[i].click(); return 'clicked'; }
  }
  return 'not-found';
})()`;

const READ_LISTING = `JSON.stringify({
  href: location.href,
  title: document.title,
  consented: /SOCS=/.test(document.cookie),
  install: [].slice.call(document.querySelectorAll('button,[role=button]'))
    .map(function (b) { return (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim(); })
    .filter(function (l) { return /^(add to|remove from)/i.test(l); })
    .slice(0, 3),
})`;

try {
  await paletteDriver({ timeoutMs: PATIENCE }).goTo(app, LISTING);
  say(`opened ${LISTING}`);

  const consent = await waitForUrl("consent.google.com", "the store to bounce to the consent host");
  say(`1. the listing bounced to ${new URL(consent).host}`);

  // The consent page is a Google app: it renders its buttons after its own
  // scripts run, so the click waits for one rather than assuming it is there.
  const deadline = Date.now() + PATIENCE;
  let clicked = "not-found";
  while (Date.now() < deadline && clicked !== "clicked") {
    clicked = await evalPage(CLICK_ACCEPT);
    if (clicked !== "clicked") await Bun.sleep(500);
  }
  if (clicked !== "clicked") fail("never found an accept control on the consent page");
  say("2. clicked accept, once");

  await waitForUrl("chromewebstore.google.com", "accept to return to the listing");
  const before = loads.length;
  await Bun.sleep(10_000);
  const churn = loads.length - before;
  // Settling costs a handful of loads: the redirect, and the one reload that
  // corrects the user agent the listing was first fetched under.
  if (churn > 4) {
    fail(`the tab is still navigating: ${churn} loads in 10s after the listing committed\n${loads.slice(-8).join("\n")}`);
  }
  say(`3. the tab settled on the listing (${churn} further loads in 10s, ${loads.length} in total)`);

  const state = JSON.parse(await evalPage(READ_LISTING)) as {
    href: string;
    title: string;
    consented: boolean;
    install: string[];
  };
  if (!state.consented) fail(`consent was accepted but no SOCS cookie is set: ${JSON.stringify(state)}`);
  if (state.install.length === 0) {
    fail(`the listing has no install control, so the store hook has nothing to intercept: ${JSON.stringify(state)}`);
  }
  say(`4. the listing is usable: ${JSON.stringify(state.title)}, install control ${JSON.stringify(state.install[0])}`);

  console.log("NB_WEBSTORE_CONSENT_OK");
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  console.error(app.stderrTail(40));
  process.exitCode = 1;
} finally {
  app.kill();
}
