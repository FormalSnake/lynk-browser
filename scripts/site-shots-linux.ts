#!/usr/bin/env bun
// Landing page captures of the shipped app on Linux: the lynk-browser package
// installed on g815, real sites, Chromium, stock Adwaita dark, captured by grim
// from the live Hyprland session (not Xvfb).
//
//   bun scripts/site-shots-linux.ts
//
// Run from the mac: the script copies itself to g815, runs there with
// `--remote`, and copies the PNGs back into site/src/assets/shots/linux-*.png.
// Marker: NB_SITE_SHOTS_OK.
//
// Everything the app reads lives in one temp dir on g815 and is deleted after:
// the store (NB_STORE_DIR), the CEF profile (ND_CEF_CACHE), and XDG_CONFIG_HOME,
// which hides the owner's GTK CSS.
//
// Window controls: NativeDesktop applies the settings portal's `button-layout`
// on XWayland only when the X display itself has no gtk-decoration-layout
// answer (src/gtk/decoration.zig), and the owner's portal says ':', which
// draws none. So a throwaway xsettingsd answers GNOME's default `menu:close`
// on the owner's XWayland for the moment the host reads it at startup, and is
// killed as soon as the host logs ND_DECORATION_LAYOUT. A private session bus
// would also hide the portal, but there executeJavaScript never answers, so
// reading mode cannot come on.
//
// GTK synthesises no keys, so where the mac script presses keys this one goes
// through the automation socket or the test-only menu items (NB_TEST_HOOKS):
// the palette closes through menu-close-palette. There is no Right press:
// `type` leaves the text unselected but the caret before it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOST = process.env.NB_LINUX_HOST ?? "g815";
const SHOTS = ["linux-hero", "linux-command-bar", "linux-compact", "linux-reader"];

if (!process.argv.includes("--remote")) {
  const out = resolve(import.meta.dir, "../site/src/assets/shots");
  mkdirSync(out, { recursive: true });
  const remote = `/tmp/nb-site-shots-${process.pid}`;
  const run = (cmd: string[]) => {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")} exited ${r.status}`);
  };
  try {
    run(["ssh", HOST, `mkdir -p ${remote}`]);
    run(["scp", "-q", import.meta.path, `${HOST}:${remote}/run.ts`]);
    run(["ssh", HOST, `bun ${remote}/run.ts --remote ${remote}`]);
    run(["scp", "-q", ...SHOTS.map((s) => `${HOST}:${remote}/${s}.png`), `${out}/`]);
    console.log(`wrote ${SHOTS.map((s) => `${out}/${s}.png`).join(" ")}`);
    console.log("NB_SITE_SHOTS_OK");
  } finally {
    spawnSync("ssh", [HOST, `rm -rf ${remote}`], { stdio: "inherit" });
  }
  process.exit(0);
}

// ---- runs on the Linux host ----

const WORK = process.argv[process.argv.indexOf("--remote") + 1] ?? mkdtempSync(join(tmpdir(), "nb-site-shots-"));
const RUNTIME = "/run/user/1000";
const PATIENCE = 60_000;
const HOME = "https://www.formalsnake.dev";
const ARTICLE = `${HOME}/blog/12-my-coding-setup`;
const WIDTH = 1440;
const HEIGHT = 900;

const sh = (cmd: string, env: Record<string, string> = {}): string => {
  const r = spawnSync("bash", ["-c", cmd], { env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const signature = JSON.parse(sh(`XDG_RUNTIME_DIR=${RUNTIME} hyprctl -j instances`))[0].instance as string;
const HYPR = { XDG_RUNTIME_DIR: RUNTIME, WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: signature };
const hypr = (args: string) => sh(`hyprctl ${args}`, HYPR);

// Pinned tiles, then rows, the same set as mac-hero.png.
const tabs = [
  { url: `${HOME}/`, pinned: true },
  { url: "https://github.com/FormalSnake", pinned: true },
  { url: "https://www.youtube.com/", pinned: true },
  { url: "https://en.wikipedia.org/wiki/Web_browser", pinned: true },
  { url: `${HOME}/blog`, pinned: false },
  { url: `${HOME}/projects`, pinned: false },
  { url: "https://github.com/FormalSnake", pinned: false },
  { url: "https://en.wikipedia.org/wiki/Web_browser", pinned: false },
].map((t, i) => ({ id: `t${i + 1}`, title: "", ...t, ...(t.pinned ? { pinnedUrl: t.url } : {}) }));

mkdirSync(join(WORK, "store"), { recursive: true });
mkdirSync(join(WORK, "xdgconfig"), { recursive: true });
writeFileSync(
  join(WORK, "store", "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs, activeId: "t1", width: WIDTH, height: HEIGHT }],
      nextTabId: tabs.length + 1,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);
writeFileSync(join(WORK, "xsettingsd.conf"), 'Gtk/DecorationLayout "menu:close"\n');

const LOG = join(WORK, "host.log");
const log = () => readFileSync(LOG, "utf8");
async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + PATIENCE;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(250);
  }
}

const xsettingsdBin = `${sh("nix build nixpkgs#xsettingsd --no-link --print-out-paths")}/bin/xsettingsd`;
const xsettingsd = Bun.spawn([xsettingsdBin, "-c", join(WORK, "xsettingsd.conf")], {
  env: { ...process.env, DISPLAY: ":0" },
  stdout: "ignore",
  stderr: "pipe",
});
await Bun.sleep(1000);
if (xsettingsd.exitCode !== null) {
  // Most likely another manager owns _XSETTINGS_S0; that one is not ours to replace.
  throw new Error(`xsettingsd exited ${xsettingsd.exitCode}: ${await new Response(xsettingsd.stderr).text()}`);
}

try {
  sh(`setsid nohup /run/current-system/sw/bin/lynk-browser > ${LOG} 2>&1 < /dev/null &`, {
    ...HYPR,
    DISPLAY: ":0",
    NB_STORE_DIR: join(WORK, "store"),
    ND_CEF_CACHE: join(WORK, "cef"),
    NATIVE_AUTOMATION: "1",
    NB_TEST_HOOKS: "1",
    XDG_CONFIG_HOME: join(WORK, "xdgconfig"),
    GTK_THEME: "Adwaita:dark",
    ADW_DEBUG_COLOR_SCHEME: "prefer-dark",
  });
  const layout = await until("the decoration layout", () => /ND_DECORATION_LAYOUT .*/.exec(log())?.[0]);
  if (!layout.includes("source=display value=menu:close")) throw new Error(`window controls: ${layout}`);
  console.log(layout);
} finally {
  xsettingsd.kill();
}

const pid = await until("the automation socket", () => /ND_AUTOMATION_LISTENING path=\S*nd-automation-(\d+)\.sock/.exec(log())?.[1]);
const SOCKET = `${RUNTIME}/nd-automation-${pid}.sock`;

let nextId = 1;
function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((done, failed) => {
    const id = nextId++;
    const c = connect(SOCKET);
    let buf = Buffer.alloc(0);
    c.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      c.write(Buffer.concat([head, body]));
    });
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
      const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
      c.end();
      msg.error ? failed(new Error(`${method} ${JSON.stringify(params)}: ${msg.error.message}`)) : done(msg.result);
    });
    c.on("error", failed);
  });
}
const click = (testId: string) => rpc("click", { testId });

type Node = { testID: string | null; text: string | null; visible: boolean; children?: Node[] };
async function nodes(): Promise<Node[]> {
  const all: Node[] = [];
  const walk = (n: Node) => {
    all.push(n);
    n.children?.forEach(walk);
  };
  walk((await rpc("getTree")).root);
  return all;
}

/// No row spinner left, then a settle for favicons and web fonts.
async function settled(settleMs = 3000): Promise<void> {
  await until("the page to finish loading", async () =>
    (await nodes()).some((n) => n.visible && /(^|-)tab-spinner-t\d+$/.test(n.testID ?? "")) ? undefined : true,
  );
  await Bun.sleep(settleMs);
}

async function window() {
  return await until("the app window", () =>
    JSON.parse(hypr("-j clients")).find((c: { pid: number }) => c.pid === Number(pid)),
  );
}

function capture(name: string, win: { at: number[]; size: number[] }): void {
  const out = join(WORK, `${name}.png`);
  sh(`grim -g "${win.at[0]},${win.at[1]} ${win.size[0]}x${win.size[1]}" ${out}`, HYPR);
  console.log(`captured ${name} (${win.size[0]}x${win.size[1]})`);
}

async function openPalette(): Promise<void> {
  await click("menu-palette");
  await until("the palette", async () => {
    try {
      await rpc("setValue", { testId: "palette", value: "" });
      return true;
    } catch {
      return undefined;
    }
  });
  // The palette selects its entry text a beat after it presents; a query
  // typed before that comes back selected.
  await Bun.sleep(1500);
  await rpc("setValue", { testId: "palette", value: "" });
  await Bun.sleep(500);
}

try {
  // Float the window so its size is ours, centred on the focused monitor.
  const first = await window();
  const target = `window = "address:${first.address}"`;
  const mon = JSON.parse(hypr("-j monitors")).find((m: { focused: boolean }) => m.focused);
  hypr(`dispatch 'hl.dsp.window.float({ action = "enable", ${target} })'`);
  hypr(`dispatch 'hl.dsp.window.resize({ x = ${WIDTH}, y = ${HEIGHT}, relative = false, ${target} })'`);
  const x = mon.x + Math.round((mon.width / mon.scale - WIDTH) / 2);
  const y = mon.y + Math.round((mon.height / mon.scale - HEIGHT) / 2);
  hypr(`dispatch 'hl.dsp.window.move({ x = ${x}, y = ${y}, relative = false, ${target} })'`);

  // Every tab once, so each has its page title and favicon, ending on the
  // homepage. A click on the tab already on show opens the address bar, so the
  // homepage is only clicked after another tab.
  for (const t of [...tabs.slice(1), tabs[0]!]) {
    await click(`tab-${t.id}`);
    await settled(2000);
  }
  await settled(4000);
  const win = await window();
  if (win.size[0] !== WIDTH || win.size[1] !== HEIGHT) throw new Error(`window is ${win.size.join("x")}`);
  capture("linux-hero", win);

  await openPalette();
  await rpc("type", { testId: "palette", text: "formal" });
  await Bun.sleep(1500);
  capture("linux-command-bar", win);
  await click("menu-close-palette");
  await Bun.sleep(800);

  await click("tab-t5");
  await settled(1500);
  await click("menu-layout");
  await Bun.sleep(2500);
  capture("linux-compact", win);
  await click("menu-layout");
  await Bun.sleep(1500);

  await openPalette();
  await rpc("type", { testId: "palette", text: ARTICLE });
  await rpc("setValue", { testId: "palette", value: true });
  await until("the article", async () =>
    (await nodes()).some((n) => n.testID === "tab-t5" && /coding setup/i.test(n.text ?? "")) ? true : undefined,
  );
  await settled(3000);
  await click("menu-reader");
  await until("reading mode", () => {
    const failed = log().split("\n").find((l) => l.includes("ND_APP READER failed"));
    if (failed) throw new Error(failed);
    return /ND_APP READER t\d+ on/.test(log()) ? true : undefined;
  });
  await Bun.sleep(2000);
  capture("linux-reader", win);
} catch (e) {
  console.error(`capture run failed: ${(e as Error).message}`);
  // Chromium's own lines drown the app's, so only the app's are shown.
  console.error(log().split("\n").filter((l) => /^(ND_|nd:)/.test(l)).slice(-40).join("\n"));
  throw e;
} finally {
  spawnSync("kill", [String(pid)]);
  await Bun.sleep(3000);
  rmSync(SOCKET, { force: true });
  for (const dir of ["store", "cef", "xdgconfig"]) rmSync(join(WORK, dir), { recursive: true, force: true });
}
