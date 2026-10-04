import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);

/// uBlock Origin's own release is the source of everything the blocker uses:
/// its filter lists (bundled snapshots, refreshed from the CDNs uBO itself
/// fetches from), its scriptlets and its `redirect=` resources. The engine is
/// brave/adblock-rust inside the host; this file only feeds it.
///
/// The pinned release is what a fresh profile downloads. A newer release is
/// picked up weekly, checked against the SHA-256 GitHub publishes for it.
export const PINNED_UBO = {
  version: "1.75.0",
  sha256: "393cf95709d1074d4022970e9014e434395c53a822387f1e25f43be97cf4b582",
};

const RELEASES = "https://api.github.com/repos/gorhill/uBlock/releases/latest";

function zipUrl(version: string): string {
  return `https://github.com/gorhill/uBlock/releases/download/${version}/uBlock0_${version}.chromium.zip`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- zip ------------------------------------------------------------------

/// The central directory is all a release zip needs: stored and deflated
/// entries, no zip64, no encryption. Anything else is refused rather than
/// half-extracted. The release wraps everything in one top folder
/// (`uBlock0.chromium/`), which is dropped.
export async function unzip(bytes: Uint8Array, into: string): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("zip central directory is corrupt");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`zip entry escapes: ${name}`);
    const inner = name.slice(name.indexOf("/") + 1);
    if (!inner) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
    if (!data) throw new Error(`zip method ${method} for ${name}`);
    const out = join(into, inner);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
  }
}

// ---- release --------------------------------------------------------------

/// `<root>/ubo/<version>/` holding the extracted chromium build, downloading
/// and verifying it first when it is not there yet.
export async function ensureRelease(root: string, version: string, digest: string): Promise<string> {
  const dir = join(root, "ubo", version);
  if (existsSync(join(dir, "assets", "assets.json"))) return dir;
  // A drive points this at a copy of the release, so a gate run neither
  // depends on GitHub nor downloads it again.
  const local = process.env.NB_ADBLOCK_ZIP;
  let bytes: Uint8Array;
  if (local) {
    bytes = new Uint8Array(await Bun.file(local).arrayBuffer());
  } else {
    const response = await fetch(zipUrl(version), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`uBlock Origin ${version}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const got = sha256(bytes);
  if (got !== digest) throw new Error(`uBlock Origin ${version}: sha256 ${got}, expected ${digest}`);
  const staging = `${dir}.partial`;
  await rm(staging, { recursive: true, force: true });
  await unzip(bytes, staging);
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  return dir;
}

/// The newest release and its zip's digest, or null when GitHub is out of
/// reach or publishes no digest for it.
export async function latestRelease(): Promise<{ version: string; sha256: string } | null> {
  try {
    const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) return null;
    const release = (await response.json()) as { tag_name: string; assets: { name: string; digest?: string }[] };
    const zip = release.assets.find((a) => a.name.endsWith(".chromium.zip"));
    const digest = zip?.digest?.startsWith("sha256:") ? zip.digest.slice(7) : null;
    return digest ? { version: release.tag_name, sha256: digest } : null;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- lists ----------------------------------------------------------------

export interface FilterList {
  key: string;
  /// Where uBO itself fetches the list; the first that answers wins.
  remote: string[];
  /// The snapshot bundled in the release.
  bundled: string;
  format: "standard" | "hosts";
}

interface AssetEntry {
  content?: string;
  off?: boolean;
  contentURL?: string | string[];
  cdnURLs?: string[];
}

/// The lists uBO enables on a fresh install, read from the release's own
/// assets.json so the set follows uBO's defaults.
export function defaultLists(release: string): FilterList[] {
  const assets = JSON.parse(readFileSync(join(release, "assets", "assets.json"), "utf8")) as Record<string, AssetEntry>;
  const lists: FilterList[] = [];
  for (const [key, entry] of Object.entries(assets)) {
    if (entry.content !== "filters" || entry.off) continue;
    const urls = Array.isArray(entry.contentURL) ? entry.contentURL : entry.contentURL ? [entry.contentURL] : [];
    const bundled = urls.filter((u) => u.startsWith("assets/")).map((u) => join(release, u)).find((p) => existsSync(p));
    if (!bundled) continue;
    const remote = [...(entry.cdnURLs ?? []), ...urls.filter((u) => /^https?:/.test(u))];
    // Peter Lowe's list is fetched in hosts-file form, like uBO does.
    lists.push({ key, remote, bundled, format: key.startsWith("plowe") ? "hosts" : "standard" });
  }
  return lists;
}

// ---- resources ----------------------------------------------------------------

interface Scriptlet {
  name: string;
  aliases?: string[];
  fn: (...args: unknown[]) => unknown;
  dependencies?: string[];
}

interface RedirectEntry {
  alias?: string | string[];
  data?: "text" | "blob";
  params?: string[];
}

const MIME: Record<string, string> = {
  js: "application/javascript",
  gif: "image/gif",
  png: "image/png",
  html: "text/html",
  txt: "text/plain",
  css: "text/css",
  json: "application/json",
  mp3: "audio/mp3",
  mp4: "video/mp4",
  xml: "text/xml",
};

/// adblock-rust's resource list for one release, in the shape Brave builds
/// its own from the same sources: every scriptlet as a function resource with
/// its dependencies, and every web-accessible resource with its aliases.
export async function buildResources(release: string): Promise<unknown[]> {
  const { builtinScriptlets } = (await import(join(release, "js", "resources", "scriptlets.js"))) as {
    builtinScriptlets: Scriptlet[];
  };
  const redirects = (await import(join(release, "js", "redirect-resources.js"))).default as Map<string, RedirectEntry>;
  const out: unknown[] = [];
  for (const [name, entry] of redirects) {
    const file = join(release, "web_accessible_resources", name);
    if (!existsSync(file)) continue;
    const ext = name.slice(name.lastIndexOf(".") + 1);
    const aliases = entry.alias === undefined ? [] : Array.isArray(entry.alias) ? entry.alias : [entry.alias];
    out.push({
      name,
      aliases,
      kind: { mime: MIME[ext] ?? "application/octet-stream" },
      content: readFileSync(file).toString("base64"),
    });
  }
  for (const s of builtinScriptlets) {
    out.push({
      name: s.name,
      aliases: s.aliases ?? [],
      // uBO's "*.fn" entries are helpers other scriptlets depend on, never
      // injected by name; adblock-rust calls a scriptlet whose source starts
      // with `function name(` with the filter's arguments.
      kind: { mime: s.name.endsWith(".fn") ? "fn/javascript" : "application/javascript" },
      content: Buffer.from(s.fn.toString()).toString("base64"),
      dependencies: s.dependencies ?? [],
    });
  }
  return out;
}

/// A key that changes whenever any input to the compiled engine does.
export function listsKey(version: string, paths: string[]): string {
  const parts = [version];
  for (const p of paths) {
    const st = statSync(p);
    parts.push(`${p}:${st.size}:${st.mtimeMs}`);
  }
  return sha256(new TextEncoder().encode(parts.join("\n")));
}

export async function dropOtherReleases(root: string, keep: string): Promise<void> {
  const dir = join(root, "ubo");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name !== keep) await rm(join(dir, name), { recursive: true, force: true });
  }
}
