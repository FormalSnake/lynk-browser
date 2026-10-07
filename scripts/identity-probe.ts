#!/usr/bin/env bun
// What a site sees of this browser. Launches the app the way a user does (no
// NATIVE_AUTOMATION, no debugging port) on a one-tab session pointed at a local
// page, and has that page report navigator, client hints, its request headers
// and any global it did not define itself. Fails on any automation surface or
// an identity that disagrees with itself. The brands stay Chromium's: stock CEF
// has no switch for them, and no site this was checked against needs Google
// Chrome in them (the Web Store's verdict is server side, see webstore.ts).
//
// NB_IDENTITY_SERVE=1 only serves the page and prints its URL, for pointing
// another browser at it. Marker: NB_IDENTITY_OK.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PATIENCE = 60_000;
const HINTS = [
  "Sec-CH-UA",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-Model",
];

const page = `<!doctype html><title>identity probe</title><body>probe<script>
(async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const stock = new Set(Object.getOwnPropertyNames(frame.contentWindow));
  const extra = Object.getOwnPropertyNames(window).filter((k) => !stock.has(k) && !/^\\d+$/.test(k));
  let consoleTouchedStack = false;
  const e = new Error("probe");
  Object.defineProperty(e, "stack", { get() { consoleTouchedStack = true; return ""; } });
  console.debug(e);
  const d = navigator.userAgentData;
  const high = d ? await d.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "model", "platformVersion", "uaFullVersion"]) : null;
  const sub = await (await fetch("/headers")).json();
  const report = {
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    appVersion: navigator.appVersion,
    vendor: navigator.vendor,
    languages: navigator.languages,
    brands: d ? d.brands : null,
    mobile: d ? d.mobile : null,
    platform: d ? d.platform : null,
    high,
    plugins: navigator.plugins.length,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    chrome: typeof window.chrome === "object" ? Object.keys(window.chrome).sort() : null,
    extraGlobals: extra,
    consoleTouchedStack,
    subresourceHeaders: sub,
  };
  await fetch("/report", { method: "POST", body: JSON.stringify(report) });
  document.title = "identity reported";
})();
</script>`;

let docHeaders: Record<string, string> = {};
let resolveReport: (r: Record<string, unknown>) => void;
const reported = new Promise<Record<string, unknown>>((r) => (resolveReport = r));

const pick = (req: Request): Record<string, string> => Object.fromEntries(req.headers.entries());

const server = Bun.serve({
  port: Number(process.env.NB_IDENTITY_PORT ?? 0),
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/headers") return Response.json(pick(req));
    if (path === "/report") {
      resolveReport({ ...(await req.json()), documentHeaders: docHeaders });
      return new Response("ok");
    }
    if (path !== "/probe") return new Response(null, { status: 404 });
    docHeaders = pick(req);
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8", "accept-ch": HINTS.join(", ") },
    });
  },
});
const url = `http://127.0.0.1:${server.port}/probe`;

if (process.env.NB_IDENTITY_SERVE === "1") {
  console.log(`NB_IDENTITY_URL ${url}`);
  const report = await reported;
  console.log(`NB_IDENTITY_REPORT ${JSON.stringify(report)}`);
  process.exit(0);
}

function fail(message: string): never {
  console.log(`NB_IDENTITY_FAIL ${message}`);
  process.exit(1);
}

const host = process.env.ND_HOST_BINARY ?? fail("ND_HOST_BINARY is not set");
const store = mkdtempSync(join(tmpdir(), "nb-identity-"));
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs: [{ id: "t1", url, title: "", pinned: false }], activeId: "t1", width: 1100, height: 760 }],
      nextTabId: 2,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);
writeFileSync(
  join(store, "settings.json"),
  JSON.stringify({ version: 1, data: { searchEngine: "google", homepage: "", restoreOnLaunch: true, pinnedExtensions: [], sitePermissions: {} } }),
);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
delete env.NATIVE_AUTOMATION;
// The host runs the entry as it is, so the Solid transform is preloaded the
// way `nd dev` and a packaged app preload it.
env.BUN_OPTIONS = [env.BUN_OPTIONS, "--preload=@nativedesktop/react/register"].filter(Boolean).join(" ");
// NB_IDENTITY_HOST_ARGS: extra host flags, e.g. --use-mock-keychain on a mac
// run, which keeps a throwaway profile out of the login keychain.
const hostArgs = (process.env.NB_IDENTITY_HOST_ARGS ?? "").split(" ").filter(Boolean);
const app = Bun.spawn([host, ...hostArgs], {
  cwd: join(import.meta.dir, ".."),
  env: { ...env, ND_SCRIPT: "src/main.tsx", NB_STORE_DIR: store },
  stdin: "ignore",
  stdout: "ignore",
  stderr: process.env.NB_IDENTITY_LOG ? Bun.file(process.env.NB_IDENTITY_LOG) : "ignore",
});

const timer = setTimeout(() => {
  app.kill("SIGKILL");
  fail("the page never reported");
}, PATIENCE);
const report = await reported;
clearTimeout(timer);
console.log(`NB_IDENTITY_REPORT ${JSON.stringify(report)}`);
app.kill("SIGTERM");
await Promise.race([app.exited, Bun.sleep(10_000)]);
if (app.exitCode === null) app.kill("SIGKILL");
server.stop(true);

type Brand = { brand: string; version: string };
const problems: string[] = [];
const ua = String(report.userAgent ?? "");
const major = ua.match(/Chrome\/(\d+)\./)?.[1];
const brands = (report.brands as Brand[] | null) ?? [];
const names = brands.map((b) => b.brand);
const doc = report.documentHeaders as Record<string, string>;
const subHeaders = report.subresourceHeaders as Record<string, string>;

if (report.webdriver !== false) problems.push(`navigator.webdriver is ${report.webdriver}`);
if (/headless/i.test(ua) || names.some((n) => /headless/i.test(n))) problems.push("a headless product in the UA or brands");
if (!major) problems.push(`no Chrome/<major> in the UA: ${ua}`);
if (!names.includes("Chromium")) problems.push(`brands lack "Chromium": ${names.join(", ")}`);
for (const b of brands) if (!/not.a.brand/i.test(b.brand) && b.version !== major) problems.push(`brand ${b.brand} is v${b.version}, UA says ${major}`);
const list = (report.high as { fullVersionList?: Brand[] } | null)?.fullVersionList ?? [];
if (!list.some((b) => b.brand === "Chromium" && b.version.startsWith(`${major}.`))) problems.push("fullVersionList disagrees with the UA");
if (!(doc["sec-ch-ua"] ?? "").includes(`"Chromium";v="${major}"`)) problems.push(`sec-ch-ua header disagrees: ${doc["sec-ch-ua"]}`);
if (!(subHeaders["sec-ch-ua-full-version-list"] ?? "").includes(`"Chromium";v="${major}.`)) problems.push("the requested full version list hint disagrees with the UA");
if (doc["user-agent"] !== ua) problems.push("the user-agent header differs from navigator.userAgent");
if (!doc["accept-language"]) problems.push("no accept-language header");
if (!(report.languages as string[]).length) problems.push("navigator.languages is empty");
if ((report.extraGlobals as string[]).length) problems.push(`globals the page did not define: ${(report.extraGlobals as string[]).join(", ")}`);
if (report.consoleTouchedStack) problems.push("console.debug serialised an error's stack (a devtools Runtime session on the page)");

if (problems.length) fail(problems.join("; "));
console.log("NB_IDENTITY_OK");
process.exit(0);
