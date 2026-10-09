import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { createStore } from "@nativedesktop/react";
import { fileNameFromUrl, hostOf } from "./url.ts";

/// `pending` is asked for but not yet answered (a save panel is up);
/// `dangerous` has finished into an unconfirmed file that waits for Keep or
/// Discard. The rest are the engine's own states.
export type DownloadState =
  | "pending"
  | "inProgress"
  | "paused"
  | "interrupted"
  | "complete"
  | "cancelled"
  | "dangerous";

export interface DownloadItem {
  /// The app's own id, stable across restarts. The engine's id is per run and
  /// lives in `engineId` while the engine still has the download.
  id: string;
  engineId?: string;
  url: string;
  name: string;
  /// Where the file ends up.
  path: string;
  /// Where a dangerous file sits until it is kept: Chrome's "Unconfirmed"
  /// name, so nothing opens it by accident.
  partPath?: string;
  state: DownloadState;
  received: number;
  /// 0 while the size is unknown.
  total: number;
  /// Bytes per second, as the engine last reported it.
  speed: number;
  startedAt: number;
  endedAt?: number;
  /// Why an interrupted download stopped, in the engine's words.
  reason?: string;
}

export interface DownloadsState {
  items: DownloadItem[];
}

export const downloads = createStore<DownloadsState>({
  name: "downloads",
  version: 1,
  defaults: { items: [] },
  dir: process.env.NB_STORE_DIR,
});

/// Oldest entries past this are dropped from the list, never from the disk.
const KEPT = 200;

/// NB_DOWNLOAD_DIR lets a drive run land files somewhere disposable; a folder
/// picked in Settings wins over both.
export function defaultDownloadDir(): string {
  return process.env.NB_DOWNLOAD_DIR ?? resolve(homedir(), "Downloads");
}

export function downloadDir(chosen: string): string {
  return chosen || defaultDownloadDir();
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/// A name nothing on disk and no download still running has taken. The
/// engine only creates the target when it finishes, so the running ones
/// have to be counted too, or two downloads of one file would race for it.
export function uniquePath(dir: string, name: string, taken: Set<string>): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = resolve(dir, name);
  for (let n = 2; existsSync(candidate) || taken.has(candidate); n++) candidate = resolve(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/// Paths the list still expects to create.
export function reservedPaths(items: DownloadItem[]): Set<string> {
  return new Set(items.filter((d) => isActive(d) || d.state === "dangerous").map((d) => d.path));
}

/// File types that run code the moment they are opened on this platform. A
/// .dmg or .pkg is left alone the way Chrome leaves it: Gatekeeper and the
/// installer already stand between it and the system, and a warning on every
/// app download teaches people to click through warnings.
const DANGEROUS_ANY = ["jar", "jnlp"];
const DANGEROUS: Set<string> = new Set(
  process.platform === "darwin"
    ? [...DANGEROUS_ANY, "app", "command", "tool", "terminal", "workflow", "action", "scpt", "applescript", "sh", "zsh", "bash"]
    : [...DANGEROUS_ANY, "sh", "bash", "zsh", "csh", "ksh", "run", "desktop", "appimage", "py", "pl", "rb", "deb", "rpm"],
);

export function isDangerous(name: string): boolean {
  return DANGEROUS.has(extname(name).slice(1).toLowerCase());
}

export function isActive(d: DownloadItem): boolean {
  return d.state === "pending" || d.state === "inProgress" || d.state === "paused";
}

/// The name a download is saved under when nothing better is known.
export function downloadName(url: string, suggested?: string): string {
  const raw = suggested || fileNameFromUrl(url);
  // A name is a name, never a path: a server can suggest "../x".
  return basename(raw).replace(/^\.+/, "") || "download";
}

const PAGE_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml", "php", "asp", "aspx", "jsp", "cgi"]);

/// Save Page As names a web page after its title, as Chrome does. A file that
/// is not a page (a PDF, an image) keeps its own name.
export function savedPageName(title: string, url: string, suggested?: string): string {
  const own = downloadName(url, suggested);
  const ext = extname(own).slice(1).toLowerCase();
  if (ext && !PAGE_EXTENSIONS.has(ext)) return own;
  const clean = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 200);
  if (clean) return `${clean}.html`;
  return ext ? own : `${own}.html`;
}

let seq = 0;
export function newDownloadId(): string {
  return `d${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export function addDownload(item: DownloadItem): void {
  downloads.update((s) => ({ items: [item, ...s.items.filter((d) => d.id !== item.id)].slice(0, KEPT) }));
}

export function patchDownload(id: string, part: Partial<DownloadItem>): void {
  downloads.update((s) => ({ items: s.items.map((d) => (d.id === id ? { ...d, ...part } : d)) }));
}

export function removeDownload(id: string): void {
  downloads.update((s) => ({ items: s.items.filter((d) => d.id !== id) }));
}

/// Clear keeps whatever is still running or waiting on the user.
export function clearDownloads(): void {
  downloads.update((s) => ({ items: s.items.filter((d) => isActive(d) || d.state === "dangerous") }));
}

/// Keep: the unconfirmed file takes its real name.
export function keepDangerous(d: DownloadItem): DownloadItem {
  if (!d.partPath) return d;
  const dir = resolve(d.path, "..");
  const taken = reservedPaths(downloads.get().items.filter((x) => x.id !== d.id));
  const path = existsSync(d.path) ? uniquePath(dir, d.name, taken) : d.path;
  renameSync(d.partPath, path);
  return { ...d, path, name: basename(path), partPath: undefined, state: "complete" };
}

/// Discard: the unconfirmed file goes, and so does the row.
export function discardDangerous(d: DownloadItem): void {
  if (d.partPath) rmSync(d.partPath, { force: true });
  removeDownload(d.id);
}

/// What a run that ended mid-download left behind: the engine is gone, so an
/// unfinished download can only be retried.
export function normalizeDownloads(state: DownloadsState): DownloadsState {
  const items = Array.isArray(state.items) ? state.items : [];
  return {
    items: items
      .filter((d) => d && typeof d.id === "string" && typeof d.url === "string")
      .map((d) => {
        const { engineId: _gone, ...rest } = d;
        if (isActive(d)) return { ...rest, state: "interrupted" as const, speed: 0, reason: "shutdown" };
        return rest;
      }),
  };
}

// ------------------------------------------------------------------ text ---

/// A long name cut in the middle, so the extension survives, for the
/// popover. AppKit sizes a truncating label's natural width from its whole
/// text, so an uncut name would widen the popover to the longest file name.
export function shortName(name: string, max = 44): string {
  if (name.length <= max) return name;
  const tail = Math.min(16, Math.floor(max / 3));
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/// Decimal units, as Finder and Files report sizes.
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  let v = n;
  let u = 0;
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${UNITS[u]}`;
}

export function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

const REASONS: Record<string, string> = {
  network: "Network error",
  server: "Server problem",
  file: "Unable to save the file",
  noSpace: "Disk full",
  shutdown: "Stopped when the browser quit",
  crash: "Stopped unexpectedly",
  cancelled: "Cancelled",
};

/// The one line under a download's name.
export function downloadStatus(d: DownloadItem, fileExists: boolean): string {
  const size = d.total > 0 ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
  switch (d.state) {
    case "pending":
      return "Waiting for a location";
    case "inProgress": {
      if (d.speed <= 0) return size;
      const rate = `${formatBytes(d.speed)}/s`;
      if (d.total <= 0) return `${size} · ${rate}`;
      return `${size} · ${rate} · ${formatRemaining((d.total - d.received) / d.speed)}`;
    }
    case "paused":
      return `Paused · ${size}`;
    case "interrupted":
      return `${REASONS[d.reason ?? ""] ?? "Failed"} · ${size}`;
    case "cancelled":
      return "Cancelled";
    case "dangerous":
      return "Can harm your computer";
    case "complete": {
      if (!fileExists) return "Moved or deleted";
      const host = hostOf(d.url);
      return host ? `${formatBytes(d.total || d.received)} · ${host}` : formatBytes(d.total || d.received);
    }
  }
}

/// A generic icon by kind of file: the freedesktop name, which the AppKit
/// backend maps to an SF Symbol.
export function fileIcon(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "bmp", "tiff", "avif"].includes(ext)) return "image-x-generic-symbolic";
  if (["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)) return "video-x-generic-symbolic";
  if (["mp3", "m4a", "wav", "flac", "ogg", "aac", "opus"].includes(ext)) return "audio-x-generic-symbolic";
  if (["zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "zst", "dmg", "pkg", "deb", "rpm"].includes(ext)) return "package-x-generic-symbolic";
  return "text-x-generic-symbolic";
}

/// The system engine hands a download over rather than running it, so the
/// Bun side does the transfer. It carries no cookies, which is why the
/// Chromium engine runs its own downloads.
export async function fetchToFile(
  url: string,
  path: string,
  progress: (received: number, total: number) => void,
): Promise<number> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0) || 0;
  const writer = Bun.file(path).writer();
  let received = 0;
  for await (const chunk of response.body) {
    writer.write(chunk);
    received += chunk.byteLength;
    progress(received, total);
  }
  await writer.end();
  return received;
}
