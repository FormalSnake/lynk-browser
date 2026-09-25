import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ensureAppDataDir } from "@nativedesktop/react";

/// Favicons are cached by ORIGIN, not by page: one icon per site is what a
/// sidebar shows, and it means a tab restored before its page loads already has
/// its icon. The cache is a directory of `<encoded origin>` files holding the
/// `data:` URL verbatim, which is exactly what `SourceTreeNode.iconData` takes.

const memory = new Map<string, string>();
let dir: string | null = null;

function fileFor(origin: string): string {
  return `${dir}/${encodeURIComponent(origin)}`;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/// Reads the whole cache into memory once. Small by construction (one small
/// PNG per site visited), and a sidebar row must render its icon in the same
/// frame it renders its title.
export function openFavicons(): void {
  dir = `${process.env.NB_STORE_DIR ?? ensureAppDataDir()}/favicons`;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    try {
      memory.set(decodeURIComponent(name), readFileSync(`${dir}/${name}`, "utf8"));
    } catch {
      // A half-written entry is a cache miss, never a startup failure.
    }
  }
}

export function faviconFor(url: string): string | undefined {
  return memory.get(originOf(url));
}

/// GTK's `faviconChanged` hands over a `data:` URL; macOS hands over the icon's
/// own address, which has to be fetched. Both land here as a data URL.
export function rememberFavicon(url: string, dataUrl: string): boolean {
  const origin = originOf(url);
  if (!origin || !dataUrl || memory.get(origin) === dataUrl) return false;
  memory.set(origin, dataUrl);
  if (dir) {
    try {
      writeFileSync(fileFor(origin), dataUrl);
    } catch {
      // An unwritable cache still works for this session.
    }
  }
  return true;
}

export async function fetchFavicon(url: string, iconUrl: string): Promise<boolean> {
  try {
    const response = await fetch(iconUrl);
    if (!response.ok) return false;
    const type = response.headers.get("content-type") ?? "image/png";
    // Plenty of sites answer a missing icon with a 200 HTML page; kept, it
    // would stand in for the site's letter with an image nothing can draw.
    if (!type.startsWith("image/")) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    return rememberFavicon(url, `data:${type};base64,${bytes.toString("base64")}`);
  } catch {
    return false;
  }
}
