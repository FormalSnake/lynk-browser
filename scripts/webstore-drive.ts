#!/usr/bin/env bun
// What the Chrome Web Store shows this browser, on the live store: no "Switch
// to Chrome" banner or promo, and an enabled "Add to Chrome" button. Launches
// the app the way a user does, plus a debugging port to read the page, on a
// one-tab session at an item page.
//
//   ND_HOST_BINARY=<host> bun scripts/webstore-drive.ts
//
// NB_STORE_URL picks another page (a Google search, say) and only reports what
// it saw. NB_STORE_SHOT saves a capture of the page. NB_IDENTITY_HOST_ARGS as
// in identity-probe.ts. Hits the network; not part of any gate.
// Marker: NB_WEBSTORE_OK.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.NB_STORE_PORT ?? 9877);
const ITEM = "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh";
const target = process.env.NB_STORE_URL ?? ITEM;
// Google's accept-all consent cookie: an EU address otherwise lands on
// consent.google.com first, which a returning user has long since answered.
// The tab opens on a static file of the same site so the consent cookie can be
// set before the page under test loads.
const START = "https://www.google.com/robots.txt";
const CONSENT = "CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg";

function fail(message: string): never {
  console.log(`NB_WEBSTORE_FAIL ${message}`);
  process.exit(1);
}

const host = process.env.ND_HOST_BINARY ?? fail("ND_HOST_BINARY is not set");
const store = mkdtempSync(join(tmpdir(), "nb-webstore-"));
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs: [{ id: "t1", url: START, title: "", pinned: false }], activeId: "t1", width: 1300, height: 900 }],
      nextTabId: 2,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
delete env.NATIVE_AUTOMATION;
// The host runs the entry as it is, so the Solid transform is preloaded the
// way `nd dev` and a packaged app preload it.
env.BUN_OPTIONS = [env.BUN_OPTIONS, "--preload=@nativedesktop/react/register"].filter(Boolean).join(" ");
const hostArgs = (process.env.NB_IDENTITY_HOST_ARGS ?? "").split(" ").filter(Boolean);
const app = Bun.spawn([host, `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*", ...hostArgs], {
  cwd: join(import.meta.dir, ".."),
  env: { ...env, ND_SCRIPT: "src/main.tsx", NB_STORE_DIR: store },
  stdout: "ignore",
  stderr: "ignore",
});
const quit = async (): Promise<void> => {
  app.kill("SIGTERM");
  await Promise.race([app.exited, Bun.sleep(8000)]);
  if (app.exitCode === null) app.kill("SIGKILL");
};

let ws: WebSocket | undefined;
for (let i = 0; i < 120 && !ws; i++) {
  await Bun.sleep(500);
  try {
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const page = list.find((t) => t.type === "page" && t.url === START);
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
}
if (!ws) {
  await quit();
  fail("the tab never showed up on the debugging port");
}
const socket = ws;
await new Promise((r) => socket.addEventListener("open", r));
let nextId = 0;
const waiting = new Map<number, (v: { result?: Record<string, unknown> }) => void>();
socket.addEventListener("message", (m) => {
  const d = JSON.parse(String(m.data));
  waiting.get(d.id)?.(d);
});
const call = (method: string, params: object = {}) =>
  new Promise<{ result?: Record<string, unknown> }>((r) => {
    waiting.set(++nextId, r);
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });

for (const domain of [".google.com", ".chromewebstore.google.com"]) {
  await call("Network.setCookie", { name: "SOCS", value: CONSENT, domain, path: "/", secure: true });
}
await call("Page.navigate", { url: target });

const facts = `JSON.stringify({
  url: location.href,
  title: document.title,
  webdriver: navigator.webdriver,
  nag: /Switch to Chrome/.test(document.body.innerText),
  add: [...document.querySelectorAll("button")].filter((b) => /^Add to Chrome$/.test(b.innerText.trim()))
    .map((b) => !(b.disabled || b.getAttribute("aria-disabled") === "true")),
  results: document.querySelectorAll("#search h3").length,
})`;
type Facts = { url: string; title: string; webdriver: boolean; nag: boolean; add: boolean[]; results: number };
let seen: Facts | undefined;
for (let i = 0; i < 40; i++) {
  await Bun.sleep(500);
  const r = await call("Runtime.evaluate", { expression: facts, returnByValue: true });
  const value = (r.result?.result as { value?: string } | undefined)?.value;
  if (!value) continue;
  seen = JSON.parse(value) as Facts;
  if (target === ITEM ? seen.add.length > 0 : seen.results > 0 || /\/sorry\//.test(seen.url)) break;
}
// The banner has its own controller, which settles after the button does.
if (target === ITEM && seen?.add.length) {
  await Bun.sleep(3000);
  const r = await call("Runtime.evaluate", { expression: facts, returnByValue: true });
  const value = (r.result?.result as { value?: string } | undefined)?.value;
  if (value) seen = JSON.parse(value) as Facts;
}
if (process.env.NB_STORE_SHOT) {
  const r = await call("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) writeFileSync(process.env.NB_STORE_SHOT, Buffer.from(String(r.result.data), "base64"));
}
await quit();
console.log(`NB_WEBSTORE_SEEN ${JSON.stringify(seen)}`);
if (!seen) fail("the page never answered");
if (target !== ITEM) process.exit(0);
if (seen.nag) fail("the store still says to switch to Chrome");
if (!seen.add.some(Boolean)) fail("no enabled Add to Chrome button");
console.log("NB_WEBSTORE_OK");
process.exit(0);
