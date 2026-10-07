import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { ensureAppDataDir } from "@nativedesktop/react";
import type { Appearance } from "@nativedesktop/react";

/// Favicons are cached by ORIGIN, not by page: one icon per site is what a
/// sidebar shows, and it means a tab restored before its page loads already has
/// its icon. Each origin keeps one icon per appearance, because a site may pick
/// its icon by `prefers-color-scheme` (GitHub swaps in a white octocat in dark
/// mode, which vanishes on a light tile). The cache is `light/` and `dark/`
/// directories of `<encoded origin>` files holding the `data:` URL verbatim,
/// which is exactly what `SourceTreeNode.iconData` takes.

type Variants = Partial<Record<Appearance, string>>;

const APPEARANCES: Appearance[] = ["light", "dark"];
const memory = new Map<string, Variants>();
let dir: string | null = null;
let current: Appearance = "light";

function fileFor(appearance: Appearance, origin: string): string {
  return `${dir}/${appearance}/${encodeURIComponent(origin)}`;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/// Reads the whole cache into memory once. Small by construction (one small
/// image per site and appearance), and a sidebar row must render its icon in
/// the same frame it renders its title.
export function openFavicons(): void {
  dir = `${process.env.NB_STORE_DIR ?? ensureAppDataDir()}/favicons`;
  for (const appearance of APPEARANCES) {
    mkdirSync(`${dir}/${appearance}`, { recursive: true });
    for (const name of readdirSync(`${dir}/${appearance}`)) {
      try {
        const origin = decodeURIComponent(name);
        const variants = memory.get(origin) ?? {};
        variants[appearance] = readFileSync(`${dir}/${appearance}/${name}`, "utf8");
        memory.set(origin, variants);
      } catch {
        // A half-written entry is a cache miss, never a startup failure.
      }
    }
  }
}

/// The appearance icons are read for, and recorded under when no other is
/// named. Returns whether it changed, so the caller knows to redraw.
export function setFaviconAppearance(appearance: Appearance): boolean {
  if (appearance === current) return false;
  current = appearance;
  return true;
}

export function faviconAppearance(): Appearance {
  return current;
}

/// The icon the site gave for this appearance. Without one, the other
/// appearance's icon stands in unless its ink would vanish on this
/// appearance's background, which leaves the row to its placeholder until the
/// page is seen again in this appearance.
export function faviconFor(url: string): string | undefined {
  const variants = memory.get(originOf(url));
  if (!variants) return undefined;
  const own = variants[current];
  if (own) return own;
  const other = variants[current === "light" ? "dark" : "light"];
  if (!other) return undefined;
  return readableOn(other, current) ? other : undefined;
}

/// GTK's `faviconChanged` hands over a `data:` URL; macOS hands over the icon's
/// own address, which has to be fetched. Both land here as a data URL, under
/// the appearance the page was showing when it named the icon.
export function rememberFavicon(url: string, dataUrl: string, appearance: Appearance = current): boolean {
  const origin = originOf(url);
  if (!origin || !dataUrl) return false;
  const variants = memory.get(origin) ?? {};
  if (variants[appearance] === dataUrl) return false;
  variants[appearance] = dataUrl;
  memory.set(origin, variants);
  if (dir) {
    try {
      writeFileSync(fileFor(appearance, origin), dataUrl);
    } catch {
      // An unwritable cache still works for this session.
    }
  }
  return true;
}

export async function fetchFavicon(url: string, iconUrl: string, appearance: Appearance = current): Promise<boolean> {
  try {
    const response = await fetch(iconUrl);
    if (!response.ok) return false;
    const type = response.headers.get("content-type") ?? "image/png";
    // Plenty of sites answer a missing icon with a 200 HTML page; kept, it
    // would stand in for the site's letter with an image nothing can draw.
    if (!type.startsWith("image/")) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    return rememberFavicon(url, `data:${type};base64,${bytes.toString("base64")}`, appearance);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ink ---

/// What an icon is drawn in: near-white marks on nothing, near-black marks on
/// nothing, or anything else (its own backdrop, colour, an undecodable file).
export type Ink = "light" | "dark" | "mixed";

const inks = new Map<string, Ink>();

export function readableOn(dataUrl: string, appearance: Appearance): boolean {
  let ink = inks.get(dataUrl);
  if (!ink) {
    ink = inkOf(dataUrl);
    inks.set(dataUrl, ink);
  }
  return ink !== (appearance === "light" ? "light" : "dark");
}

export function inkOf(dataUrl: string): Ink {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return "mixed";
  const head = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  let bytes: Buffer;
  try {
    bytes = head.endsWith(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  } catch {
    return "mixed";
  }
  if (head.startsWith("image/svg")) return svgInk(bytes.toString("utf8"));
  const png = pngIn(bytes);
  return png ? pngInk(png) : "mixed";
}

/// Relative luminance, 0 to 1, of sRGB channels in 0 to 255.
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const LIGHT = 0.7;
const DARK = 0.05;

/// Light or dark when nine in ten of the painted pixels (or colours) are;
/// antialiased edges and a stray accent do not make an icon readable.
function verdict(lums: number[]): Ink {
  if (lums.length === 0) return "mixed";
  if (lums.filter((l) => l >= LIGHT).length >= lums.length * 0.9) return "light";
  if (lums.filter((l) => l <= DARK).length >= lums.length * 0.9) return "dark";
  return "mixed";
}

const NAMED: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
};

function parseColor(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v]!;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/// The colours an SVG paints with, from its attributes and styles. One the
/// parser cannot read (a gradient, currentColor, a name outside the table)
/// makes the verdict "mixed"; a shape with no fill at all paints black.
function svgInk(svg: string): Ink {
  // A dark-mode rule inside the file is not applied when the icon is drawn
  // as an image; only the default rules count.
  const text = svg.replace(/@media[^{]*prefers-color-scheme[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const lums: number[] = [];
  let unreadable = false;
  for (const m of text.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?([^"';>\s)]+\)?)/g)) {
    const value = m[1]!;
    if (value === "none" || value === "transparent") continue;
    const rgb = parseColor(value);
    if (rgb) lums.push(luminance(...rgb));
    else unreadable = true;
  }
  if (unreadable) return "mixed";
  if (lums.length === 0) return /<(path|rect|circle|ellipse|polygon|text)\b/.test(text) ? "dark" : "mixed";
  return verdict(lums);
}

/// The PNG in `bytes`: the file itself, or the first PNG frame of an ICO.
function pngIn(bytes: Buffer): Buffer | null {
  const SIG = "89504e470d0a1a0a";
  if (bytes.subarray(0, 8).toString("hex") === SIG) return bytes;
  if (bytes.length > 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const count = bytes.readUInt16LE(4);
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      if (entry + 16 > bytes.length) break;
      const size = bytes.readUInt32LE(entry + 8);
      const offset = bytes.readUInt32LE(entry + 12);
      const frame = bytes.subarray(offset, offset + size);
      if (frame.subarray(0, 8).toString("hex") === SIG) return frame;
    }
  }
  return null;
}

/// 8-bit, non-interlaced PNGs: what a favicon almost always is. Anything else
/// reads as "mixed", which keeps the icon.
function pngInk(png: Buffer): Ink {
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let alphas: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      type = data[9]!;
      interlace = data[12]!;
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") alphas = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || depth !== 8 || interlace !== 0 || width === 0 || width * height > 512 * 512) return "mixed";
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return "mixed";
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return "mixed";
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  const lums: number[] = [];
  let opaque = 0;
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    let r: number, g: number, b: number, alpha: number;
    if (type === 3) {
      const index = pixels[at]!;
      if (!palette) return "mixed";
      [r, g, b] = [palette[index * 3]!, palette[index * 3 + 1]!, palette[index * 3 + 2]!];
      alpha = alphas && index < alphas.length ? alphas[index]! : 255;
    } else if (type === 0 || type === 4) {
      r = g = b = pixels[at]!;
      alpha = type === 4 ? pixels[at + 1]! : 255;
    } else {
      [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
      alpha = type === 6 ? pixels[at + 3]! : 255;
    }
    if (alpha < 128) continue;
    opaque++;
    lums.push(luminance(r, g, b));
  }
  // An icon that fills its square brings its own backdrop.
  if (opaque > width * height * 0.9) return "mixed";
  return verdict(lums);
}
