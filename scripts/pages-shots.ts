#!/usr/bin/env bun
// The panels and the downloads popover: seeds the list with one row per state
// (long names included), opens the popover and the three panels, asserts their
// geometry and captures each. Layout, width and appearance come from argv so
// one run covers one combination:
//
//   bun scripts/pages-shots.ts <compact|sidebar> <normal|narrow> [gtk|appkit] [light|dark]
//
// The GTK run on macOS needs a checkout host: ND_HOST_BINARY=<fw>/zig-out/bin/nd-hello.
// Marker: NB_PAGES_SHOTS_OK.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";
import { homedir } from "node:os";
import { SHOTS, fail, findAcross, walk } from "./drive-lib.ts";

// The ndshot build that serialises its own captures: two at once on one
// executable path livelock ScreenCaptureKit.
const NDSHOT = process.env.ND_NDSHOT ?? join(homedir(), "Developer/NativeDesktop/tools/ndshot/bin/ndshot");

const layout = (process.argv[2] ?? "compact") as "compact" | "sidebar";
const width = process.argv[3] ?? "normal";
const backend = process.argv[4] as "gtk" | "appkit" | undefined;
const appearance = process.argv[5] as "light" | "dark" | undefined;
const tag = `${layout}-${width}${backend ? `-${backend}` : ""}${appearance ? `-${appearance}` : ""}`;
const STORE = join(import.meta.dir, `../.shots-store-${tag}`);
const FILES = join(STORE, "files");
const W = width === "narrow" ? 720 : 1280;

rmSync(STORE, { recursive: true, force: true });
mkdirSync(FILES, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(FILES, "notes.txt"), "notes");

const now = Date.now();
const MB = 1_000_000;
const items = [
  { id: "a", url: "https://files.example.com/q/report", name: "Quarterly report, final revision, signed copy for the board meeting.pdf", path: join(FILES, "q.pdf"), state: "inProgress", received: 4.2 * MB, total: 12 * MB, speed: 1.3 * MB, startedAt: now, engineId: "x1" },
  { id: "b", url: "https://releases.ubuntu.com/ubuntu.iso", name: "ubuntu-24.04.1-desktop-amd64.iso", path: join(FILES, "u.iso"), state: "paused", received: 1200 * MB, total: 5900 * MB, speed: 0, startedAt: now, engineId: "x2" },
  { id: "c", url: "https://stream.example.com/live", name: "stream.bin", path: join(FILES, "s.bin"), state: "inProgress", received: 830_000, total: 0, speed: 210_000, startedAt: now, engineId: "x3" },
  { id: "d", url: "https://get.example.dev/install.sh", name: "install.sh", path: join(FILES, "install.sh"), partPath: join(FILES, "Unconfirmed 123456.crdownload"), state: "dangerous", received: 4000, total: 4000, speed: 0, startedAt: now },
  { id: "e", url: "https://photos.example.com/album.zip", name: "photos.zip", path: join(FILES, "photos.zip"), state: "interrupted", reason: "network", received: 31 * MB, total: 88 * MB, speed: 0, startedAt: now },
  { id: "f", url: "https://notes.example.com/notes.txt", name: "notes.txt", path: join(FILES, "notes.txt"), state: "complete", received: 5, total: 5, speed: 0, startedAt: now },
  { id: "g", url: "https://billing.example.com/invoice", name: "old-invoice.pdf", path: join(FILES, "gone.pdf"), state: "complete", received: 180_000, total: 180_000, speed: 0, startedAt: now },
];
const SEED = join(STORE, "seed.json");
writeFileSync(
  join(STORE, "bookmarks.json"),
  JSON.stringify({
    version: 1,
    data: {
      items: [
        { id: "b1", url: "https://developer.apple.com/design/human-interface-guidelines/", title: "Human Interface Guidelines | Apple Developer Documentation, a very long title that has to truncate", added: now },
        { id: "b2", url: "https://gnome.pages.gitlab.gnome.org/libadwaita/doc/", title: "Adw – 1: Libadwaita", added: now },
        { id: "b3", url: "https://news.ycombinator.com/", title: "Hacker News", added: now },
      ],
    },
  }),
);
{
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(STORE, "history.sqlite"));
  db.run("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)");
  const visits: [string, string, number][] = [
    ["https://example.com/articles/2026/09/a-rather-long-path/that-keeps-going?with=query&and=more", "An article with a long title about native browser chrome and how it should look", now - 60_000],
    ["https://news.ycombinator.com/", "Hacker News", now - 3_600_000],
    ["https://github.com/FormalSnake/NativeDesktop", "FormalSnake/NativeDesktop", now - 86_400_000 - 1000],
    ["https://duckduckgo.com/?q=libadwaita+boxed+list", "", now - 3 * 86_400_000],
  ];
  for (const [url, title, ts] of visits) db.run("INSERT INTO visits (url, title, ts) VALUES (?, ?, ?)", [url, title, ts]);
  db.close();
}
// Icons for some of those sites and none for the rest, so the rows without
// one show whether the slot is kept. GitHub's is the white mark it gives in
// dark mode, which a light row must not draw.
{
  const HN = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4n8ZAEiJN9aiGUQ1DSgMAyh1lEEKSRAcAAAAASUVORK5CYII=";
  const GITHUB_DARK = Buffer.from(`<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="14" fill="white"/></svg>`).toString("base64");
  for (const look of ["light", "dark"]) mkdirSync(join(STORE, "favicons", look), { recursive: true });
  for (const look of ["light", "dark"]) writeFileSync(join(STORE, "favicons", look, encodeURIComponent("https://news.ycombinator.com")), `data:image/png;base64,${HN}`);
  writeFileSync(join(STORE, "favicons", "dark", encodeURIComponent("https://github.com")), `data:image/svg+xml;base64,${GITHUB_DARK}`);
  // An icon neither toolkit can decode: the row keeps its placeholder.
  for (const look of ["light", "dark"]) writeFileSync(join(STORE, "favicons", look, encodeURIComponent("https://duckduckgo.com")), "data:image/x-icon;base64,AAABAAEAEBA=");
}
writeFileSync(SEED, JSON.stringify({ items }));
writeFileSync(
  join(STORE, "settings.json"),
  JSON.stringify({ version: 1, data: { searchEngine: "duckduckgo", homepage: "", restoreOnLaunch: true, layout, sitePermissions: {}, pinnedExtensions: [], downloadDir: FILES, askWhereToSave: false } }),
);
writeFileSync(
  join(STORE, "session.json"),
  JSON.stringify({ version: 2, data: { windows: [{ id: "w1", tabs: [{ id: "t1", url: "", title: "", pinned: false }], activeId: "t1", width: W, height: 820 }], nextTabId: 2, nextWindowId: 2, zoomByHost: {} } }),
);

type Box = { x: number; y: number; w: number; h: number };
/// Names up to this long are shown whole in both surfaces; longer ones may
/// be cut in the middle.
const SHORT_ENOUGH = 44;
const problems: string[] = [];
function geo(n: JsonNode | undefined, what: string): Box {
  if (!n?.geometry) {
    problems.push(`${what}: no geometry`);
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return n.geometry;
}

/// Every row: the leading column is one width, names line up, nothing runs
/// into the trailing buttons, and the buttons stay inside the row.
function checkRows(root: JsonNode, prefix: string, where: string): void {
  const byId = new Map<string, JsonNode>();
  walk(root, (n) => {
    if (n.testID) byId.set(n.testID, n);
  });
  const nameXs: number[] = [];
  const leadMids: number[] = [];
  for (const it of items) {
    const id = `${prefix}downloads-${it.id}`;
    const row = byId.get(id);
    if (!row) continue;
    const r = geo(row, `${where} ${id}`);
    const nameNode = byId.get(`${prefix}downloads-item-${it.id}`);
    const name = geo(nameNode, `${where} ${id} name`);
    const status = geo(byId.get(`${prefix}downloads-status-${it.id}`), `${where} ${id} status`);
    if (nameNode?.text !== it.name && !(prefix !== "all-" && it.name.length > 44)) problems.push(`${where} ${id}: the name reads ${JSON.stringify(nameNode?.text)}, not ${JSON.stringify(it.name)}`);
    // A label narrower than 6 px a character cannot be showing its whole
    // text at the body size; "…" alone is about 12 px.
    if (it.name.length <= SHORT_ENOUGH && name.w < it.name.length * 6) problems.push(`${where} ${id}: ${JSON.stringify(it.name)} gets ${name.w} px`);
    nameXs.push(name.x);
    if (Math.abs(status.x - name.x) > 2) problems.push(`${where} ${id}: status x ${status.x} vs name x ${name.x}`);
    const buttons: Box[] = [];
    walk(row, (n) => {
      if (n.testID && /(-(pause|resume|cancel|retry|remove)$|downloads-reveal-)/.test(n.testID) && n.geometry) buttons.push(n.geometry);
    });
    // The name takes the row's free width: up to the first trailing button,
    // or the row's end when there is none.
    const trailing = buttons.filter((b) => b.x >= name.x + 1).map((b) => b.x);
    const room = (trailing.length ? Math.min(...trailing) : r.x + r.w) - name.x;
    if (name.w < room - 16) problems.push(`${where} ${id}: name is ${name.w} wide with ${room} free`);
    for (const b of buttons) {
      if (b.x < name.x + Math.min(name.w, 1)) continue;
      if (name.x + name.w > b.x + 1) problems.push(`${where} ${id}: name runs to ${name.x + name.w}, button at ${b.x}`);
      if (b.x + b.w > r.x + r.w + 1) problems.push(`${where} ${id}: button past row edge`);
      const mid = b.y + b.h / 2 - (r.y + r.h / 2);
      if (Math.abs(mid) > 2) problems.push(`${where} ${id}: button off-centre by ${mid}`);
    }
    // Keep and Discard sit under the warning, on the name's edge.
    const keep = byId.get(`${id}-keep`)?.geometry;
    if (keep) {
      if (Math.abs(keep.x - name.x) > 2) problems.push(`${where} ${id}: Keep at x ${keep.x}, name at ${name.x}`);
      if (keep.y < status.y + status.h - 1) problems.push(`${where} ${id}: Keep overlaps the warning`);
    }
    const lead = byId.get(`${id}-progress`) ?? byId.get(`${id}-icon`);
    if (lead?.geometry) {
      const l = lead.geometry;
      leadMids.push(l.x + l.w / 2);
      const mid = l.y + l.h / 2 - (r.y + r.h / 2);
      if (Math.abs(mid) > 2) problems.push(`${where} ${id}: leading element off-centre by ${mid}`);
    }
  }
  if (leadMids.length > 1 && Math.max(...leadMids) - Math.min(...leadMids) > 1.5) {
    problems.push(`${where}: leading icons are centred at ${[...new Set(leadMids)].join(",")}`);
  }
  if (nameXs.length > 1 && Math.max(...nameXs) - Math.min(...nameXs) > 1) problems.push(`${where}: names start at ${[...new Set(nameXs)].join(",")}`);
}

/// ndshot's region capture: the screen under the window, so a popover hanging
/// off it is in the picture. `title` picks a window by its title; without one
/// the app's largest window is taken.
async function shoot(app: AppHandle, window: number, name: string, title?: string): Promise<void> {
  const out = `${SHOTS}/${name}.png`;
  if (process.platform === "linux") {
    // Xvfb: the root holds every surface, popovers included.
    const shot = Bun.spawnSync(["import", "-window", "root", out]);
    if (shot.exitCode !== 0) fail(`import failed: ${shot.stderr.toString().trim()}`);
    console.log(`  screenshot ${name}.png`);
    return;
  }
  // ndshot's region capture: the screen under the window, so a popover
  // hanging off it is in the picture. Without the Screen Recording grant it
  // falls back to the host's own capture, which draws the window alone.
  const listed = Bun.spawnSync([NDSHOT, "list"], { timeout: 15_000 });
  const target =
    listed.exitCode === 0
      ? listed.stdout
          .toString()
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line) as { pid: number; windowID: number; title: string; onScreen: boolean; width: number; height: number })
          .filter((w) => w.pid === app.pid && w.onScreen && (title ? w.title.includes(title) : true))
          .sort((a, b) => b.width * b.height - a.width * a.height)[0]
      : undefined;
  if (target) {
    const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(target.windowID), "--region", "--no-focus"], { timeout: 30_000 });
    if (shot.exitCode === 0) {
      console.log(`  screenshot ${name}.png (region)`);
      return;
    }
  }
  await app.screenshot(out, { minBytes: 1000, window });
  console.log(`  screenshot ${name}.png (window only)`);
}

const app = await launchApp({
  entry: "src/main.tsx",
  backend,
  hostBinary: process.env.ND_HOST_BINARY,
  env: {
    NB_STORE_DIR: STORE,
    NB_TEST_HOOKS: "1",
    NB_DOWNLOADS_SEED: SEED,
    ND_AUTOMATION_CAPTURE: process.env.ND_AUTOMATION_CAPTURE,
    ...(appearance ? { ND_APPEARANCE: appearance } : {}),
  },
});
try {
  const p = layout === "compact" ? "compact-" : "";
  const button = (await findAcross(app, `${p}downloads-button`)) ?? (await findAcross(app, "downloads-button"));
  if (!button) fail("no downloads button");
  await app.click({ testId: button.node.testID! });
  await Bun.sleep(1200);
  const panel = (await findAcross(app, `${button.node.testID!.replace("downloads-button", "")}downloads-panel`)) ?? fail("popover did not open");
  const tree = await app.tree(panel.window);
  const panelNode = (() => {
    let found: JsonNode | undefined;
    walk(tree.root, (n) => {
      if (n.testID === panel.node.testID) found = n;
    });
    return found!;
  })();
  checkRows(panelNode, button.node.testID!.replace("downloads-button", ""), "popover");
  await shoot(app, button.window, `downloads-popover-${tag}`);

  const all = (await findAcross(app, `${button.node.testID!.replace("downloads-button", "")}downloads-all`)) ?? fail("no Show All");
  await app.click({ testId: all.node.testID! });
  const inPanel = async (id: string, what: string): Promise<{ node: JsonNode; window: number }> => {
    for (let i = 0; i < 40; i++) {
      const found = await findAcross(app, id);
      if (found) return found;
      await Bun.sleep(150);
    }
    return fail(`${what} did not open`);
  };
  const subtree = async (found: { node: JsonNode; window: number }): Promise<JsonNode> => {
    const t = await app.tree(found.window);
    let out: JsonNode | undefined;
    walk(t.root, (n) => {
      if (n.ref === found.node.ref) out = n;
    });
    return out ?? found.node;
  };
  /// Nothing in a panel runs past the panel's own edges.
  const contained = (root: JsonNode, where: string): void => {
    // The dialog is a handle with no frame of its own on AppKit; its content
    // box is the panel's extent there.
    const frame = root.geometry && root.geometry.w > 0 ? root : root.children.find((c) => (c.geometry?.w ?? 0) > 0);
    const box = frame?.geometry;
    if (!box) return problems.push(`${where}: no geometry`), undefined;
    walk(root, (n) => {
      const g = n.geometry;
      if (!g || !n.visible || g.w === 0) return;
      if (g.x < box.x - 1 || g.x + g.w > box.x + box.w + 1) problems.push(`${where}: ${n.testID ?? n.type} spans ${g.x}..${g.x + g.w}, panel ${box.x}..${box.x + box.w}`);
    });
  };

  const downloadsPanel = await inPanel("downloads-panel", "the Downloads panel");
  await Bun.sleep(1000);
  const dRoot = await subtree(downloadsPanel);
  checkRows(dRoot, "all-", "panel");
  contained(dRoot, "downloads panel");
  await shoot(app, downloadsPanel.window, `downloads-panel-${tag}`);
  await app.click("menu-downloads");
  await Bun.sleep(600);

  for (const name of ["history", "bookmarks"] as const) {
    const item = name === "history" ? "menu-show-history" : `menu-${name}`;
    await app.click(item);
    const found = await inPanel(`${name}-panel`, `the ${name} panel`);
    await Bun.sleep(1000);
    const root = await subtree(found);
    contained(root, `${name} panel`);
    let rows = 0;
    walk(root, (n) => {
      if (!n.testID?.startsWith(`${name}-row-`)) return;
      rows++;
      // One line of title and one of address: a wrapped row is a third taller.
      if ((n.geometry?.h ?? 0) > 72) problems.push(`${name} panel: ${n.testID} is ${n.geometry?.h} px tall, so a line wrapped`);
    });
    if (rows === 0) problems.push(`${name} panel: no rows`);
    await shoot(app, found.window, `${name}-panel-${tag}`);
    await app.click(item);
    await Bun.sleep(600);
    if ((await findAcross(app, `${name}-panel`))?.node.visible) problems.push(`${name} panel: its keystroke did not put it away`);
  }
} finally {
  await app.close().catch(() => {});
}
if (problems.length) {
  for (const p of problems) console.log(`  GEOMETRY ${p}`);
  fail(`${problems.length} geometry problems`);
}
console.log(`NB_PAGES_SHOTS_OK ${tag}`);
