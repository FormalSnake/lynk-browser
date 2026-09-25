import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileNameFromUrl } from "./url.ts";

export interface DownloadItem {
  id: string;
  name: string;
  url: string;
  path: string;
  state: "running" | "done" | "failed";
  received?: number;
  /// -1 while the size is unknown.
  total?: number;
}

/// What the engine asks for when it can run a download itself: Chromium does
/// the transfer to a path the app picks and reports progress, which is the
/// only way blob:, data:, POST and cookie-bound downloads can land at all.
export interface EngineDownload {
  id: string;
  respond: (path: string) => void;
}

/// Where a download the engine runs is written, claimed by name up front.
export function downloadTarget(name: string): string {
  return uniquePath(ensureDownloadDir(), name);
}

/// NB_DOWNLOAD_DIR lets a drive run land files somewhere disposable.
export function downloadDir(): string {
  return process.env.NB_DOWNLOAD_DIR ?? resolve(homedir(), "Downloads");
}

/// Settings only reads the path; a transfer needs the folder to exist.
function ensureDownloadDir(): string {
  const dir = downloadDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function uniquePath(dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = resolve(dir, name);
  for (let n = 2; existsSync(candidate); n++) candidate = resolve(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/// The WebKit engine cancels its own download and hands us the URL, so the Bun
/// side does the transfer. Content-Disposition wins over the URL for the
/// filename.
export async function runDownload(url: string, suggested?: string): Promise<{ name: string; path: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = decodeURIComponent(match?.[1] ?? suggested ?? fileNameFromUrl(url));

  const path = uniquePath(ensureDownloadDir(), name);
  await Bun.write(path, response);
  return { name: path.slice(path.lastIndexOf("/") + 1), path };
}
