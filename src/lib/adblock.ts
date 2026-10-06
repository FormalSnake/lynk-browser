import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStore, ensureAppDataDir, webviewEngine } from "@nativedesktop/react";

import {
  PINNED_UBO,
  buildResources,
  compareVersions,
  defaultLists,
  dropOtherReleases,
  ensureRelease,
  latestRelease,
  listsKey,
  type FilterList,
} from "./ublock.ts";

/// The built-in blocker: uBlock Origin's default lists, scriptlets and
/// redirect resources, run by the host's Chromium engine. On by default; the
/// user can switch it off per site and hide page elements for good (⇧⌘H).
/// Everything here is async file and network work; the lists compile on a
/// host thread, never on this one.

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

/// One thing the user took off a site: the
/// selector the rule is made of, and words for the list of what is hidden.
export interface Veil {
  selector: string;
  label: string;
  note: string;
  date: number;
}

export interface BlockingState {
  /// uBO release in use; a newer one replaces it once downloaded and verified.
  release: { version: string; sha256: string };
  /// When each list was last fetched, by uBO asset key.
  fetched: Record<string, number>;
  lastReleaseCheck: number;
  /// Hostnames (without "www.") blocking is off for.
  offSites: string[];
  hidden: Record<string, Veil[]>;
}

const DEFAULT_STATE: BlockingState = {
  release: PINNED_UBO,
  fetched: {},
  lastReleaseCheck: 0,
  offSites: [],
  hidden: {},
};

export const blocking = createStore<BlockingState>({
  name: "blocking",
  version: 1,
  defaults: DEFAULT_STATE,
  dir: process.env.NB_STORE_DIR,
});

const TRACE = process.env.NB_TEST_HOOKS === "1";

async function root(): Promise<string> {
  const dir = join(process.env.NB_STORE_DIR ?? ensureAppDataDir(), "adblock");
  await mkdir(join(dir, "lists"), { recursive: true });
  return dir;
}

/// The name a per-site switch and a hidden element are kept under.
export function siteOf(url: string): string {
  if (!/^https?:/.test(url)) return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

// ---- engine ---------------------------------------------------------------

let releaseDir = "";
let lists: FilterList[] = [];
let loading: Promise<void> = Promise.resolve();

function listPath(dir: string, list: FilterList): string {
  const fresh = join(dir, "lists", `${list.key}.txt`);
  return existsSync(fresh) ? fresh : list.bundled;
}

/// Compiles (or restores from the cache) the lists on disk and hands them to
/// the host. Safe to call again whenever a list or the release changed.
async function loadEngine(): Promise<void> {
  const dir = await root();
  const version = blocking.get().release.version;
  const resources = join(dir, `resources-${version}.json`);
  if (!existsSync(resources)) {
    await writeFile(resources, JSON.stringify(await buildResources(releaseDir)));
  }
  const paths = lists.map((l) => listPath(dir, l));
  const result = await webviewEngine.contentBlocking.load({
    lists: lists.map((l, i) => ({ path: paths[i]!, format: l.format })),
    resources,
    cacheFile: join(dir, "engine.bin"),
    cacheKey: listsKey(version, [...paths, resources]),
  });
  console.error(`NB_ADBLOCK_LOADED ${result.source} ${result.ms}ms lists=${lists.length}`);
}

function reload(): Promise<void> {
  loading = loading.then(loadEngine).catch((err) => console.error(`NB_ADBLOCK_WARN ${String(err)}`));
  return loading;
}

/// The rules the user made: every hidden element as `site##selector`.
export function userRules(hidden: Record<string, Veil[]>): string {
  const lines: string[] = [];
  for (const [site, veils] of Object.entries(hidden)) {
    for (const v of veils) lines.push(`${site}##${v.selector}`);
  }
  return lines.join("\n");
}

/// Pushes the per-site switches and hidden elements to the host. Cheap: the
/// lists are not recompiled.
async function applyUserState(): Promise<void> {
  const s = blocking.get();
  await webviewEngine.contentBlocking.configure({
    enabled: true,
    disabledSites: s.offSites,
    userRules: userRules(s.hidden),
  });
}

/// Startup. Never holds the window back: with uBO on disk the engine comes
/// back from its cache on a host thread in well under the time Chromium takes
/// to start; on a fresh profile the download runs in the background and
/// blocking starts when it lands.
export function startContentBlocking(): void {
  void prepare().catch((err) => console.error(`NB_ADBLOCK_WARN ${String(err)}`));
}

/// Before `render()`: the window reads the per-site switches as it draws.
export async function loadBlockingState(): Promise<void> {
  blocking.set({ ...DEFAULT_STATE, ...(await blocking.load()) });
}

async function prepare(): Promise<void> {
  await applyUserState();
  const dir = await root();
  try {
    const release = blocking.get().release;
    releaseDir = await ensureRelease(dir, release.version, release.sha256);
  } catch (err) {
    // A newer release that can no longer be fetched falls back to the pinned one.
    console.error(`NB_ADBLOCK_WARN ${String(err)}`);
    blocking.update((s) => ({ ...s, release: PINNED_UBO }));
    releaseDir = await ensureRelease(dir, PINNED_UBO.version, PINNED_UBO.sha256);
  }
  lists = defaultLists(releaseDir);
  await reload();
  if (process.env.NB_ADBLOCK_NO_REFRESH === "1") return;
  void refresh(false);
  setInterval(() => void refresh(false), 60 * 60 * 1000);
}

// ---- updates ----------------------------------------------------------------

let refreshing: Promise<number> | null = null;

/// Daily list refresh from the addresses uBO itself uses, and a weekly check
/// for a new uBO release (new scriptlets and resources). Each downloaded list
/// replaces the old one only once it arrived whole. Resolves to how many
/// lists changed.
export function refresh(force: boolean): Promise<number> {
  refreshing ??= refreshOnce(force).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshOnce(force: boolean): Promise<number> {
  if (!releaseDir) return 0;
  const dir = await root();
  const now = Date.now();
  let changed = 0;
  for (const list of lists) {
    const last = blocking.get().fetched[list.key] ?? 0;
    if (!force && now - last < DAY) continue;
    for (const url of list.remote) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) continue;
        const text = await response.text();
        // A captive portal or an error page is not a filter list.
        if (text.length < 256 || /^\s*<(!doctype|html)/i.test(text)) continue;
        const out = join(dir, "lists", `${list.key}.txt`);
        const old = existsSync(out) ? await readFile(out, "utf8") : "";
        blocking.update((s) => ({ ...s, fetched: { ...s.fetched, [list.key]: now } }));
        if (old === text) break;
        await writeFile(`${out}.partial`, text);
        await rename(`${out}.partial`, out);
        changed++;
        break;
      } catch {
        // Next mirror.
      }
    }
  }
  if (force || now - blocking.get().lastReleaseCheck > WEEK) {
    blocking.update((s) => ({ ...s, lastReleaseCheck: now }));
    const latest = await latestRelease();
    if (latest && compareVersions(latest.version, blocking.get().release.version) > 0) {
      try {
        releaseDir = await ensureRelease(dir, latest.version, latest.sha256);
        blocking.update((s) => ({ ...s, release: latest }));
        await dropOtherReleases(dir, latest.version);
        lists = defaultLists(releaseDir);
        changed++;
      } catch (err) {
        console.error(`NB_ADBLOCK_WARN ${String(err)}`);
      }
    }
  }
  if (changed) await reload();
  if (TRACE) console.error(`NB_ADBLOCK_REFRESHED changed=${changed}`);
  return changed;
}

/// When the lists in use were last fetched (or the release's own snapshot
/// date), for the command bar's subtitle.
export function listsUpdatedAt(): number {
  const fetched = Object.values(blocking.get().fetched);
  if (fetched.length) return Math.max(...fetched);
  return releaseDir && existsSync(releaseDir) ? statSync(releaseDir).mtimeMs : 0;
}

// ---- per-site switches and hidden elements ------------------------------------

export function blockingOn(site: string, state: BlockingState = blocking.get()): boolean {
  return !state.offSites.includes(site);
}

export async function setBlockingOn(site: string, on: boolean): Promise<void> {
  if (!site) return;
  blocking.update((s) => ({
    ...s,
    offSites: on ? s.offSites.filter((h) => h !== site) : [...new Set([...s.offSites, site])],
  }));
  await applyUserState();
}

export async function hide(site: string, veil: Omit<Veil, "date">): Promise<void> {
  if (!site) return;
  blocking.update((s) => {
    const list = s.hidden[site] ?? [];
    if (list.some((v) => v.selector === veil.selector)) return s;
    return { ...s, hidden: { ...s.hidden, [site]: [...list, { ...veil, date: Date.now() }] } };
  });
  await applyUserState();
}

export async function restoreHidden(site: string, selector?: string): Promise<void> {
  blocking.update((s) => {
    const kept = selector ? (s.hidden[site] ?? []).filter((v) => v.selector !== selector) : [];
    const hidden = { ...s.hidden };
    if (kept.length) hidden[site] = kept;
    else delete hidden[site];
    return { ...s, hidden };
  });
  await applyUserState();
}

export function hiddenOn(site: string, state: BlockingState = blocking.get()): Veil[] {
  return state.hidden[site] ?? [];
}
