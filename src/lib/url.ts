import { engineOf, settings } from "./settings.ts";

/// The prefix the CURRENT search engine builds addresses with. Read per call
/// rather than captured at import, so choosing a different engine in Settings
/// takes effect on the next thing typed rather than the next launch.
export function searchPrefix(): string {
  return engineOf(settings.get().searchEngine).prefix;
}

export function isSearch(url: string): boolean {
  return url.startsWith(searchPrefix());
}

/// Omnibox text -> a loadable URL. A bare word with no dot is a search, so
/// "localhost:8080" and "example.com" navigate while "native desktop" searches.
export function toUrl(raw: string): string | null {
  const q = raw.trim();
  if (!q) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(q)) return q;
  if (/^\S+\.\S{2,}$/.test(q) || /^localhost(:\d+)?(\/|$)/i.test(q)) return `https://${q}`;
  return `${searchPrefix()}${encodeURIComponent(q)}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/// Sidebar caption and omnibox text: host plus path, without the scheme noise.
export function displayUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const tail = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${tail}${u.search}`;
  } catch {
    return url;
  }
}

/// Last path segment of a download URL, or a neutral fallback. GTK's
/// downloadRequested carries no suggested filename (see LEDGER gaps).
export function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : "download";
  } catch {
    return "download";
  }
}
