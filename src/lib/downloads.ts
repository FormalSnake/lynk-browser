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
}

/// NB_DOWNLOAD_DIR lets a drive run land files somewhere disposable.
export function downloadDir(): string {
  const dir = process.env.NB_DOWNLOAD_DIR ?? resolve(homedir(), "Downloads");
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

/// The engine cancels its own download and hands us the URL, so the Bun side
/// does the transfer. Content-Disposition wins over the URL for the filename.
export async function runDownload(url: string, suggested?: string): Promise<{ name: string; path: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = decodeURIComponent(match?.[1] ?? suggested ?? fileNameFromUrl(url));

  const path = uniquePath(downloadDir(), name);
  await Bun.write(path, response);
  return { name: path.slice(path.lastIndexOf("/") + 1), path };
}
