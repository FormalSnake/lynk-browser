import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { faviconFor, inkOf, openFavicons, readableOn, rememberFavicon, setFaviconAppearance } from "./favicons.ts";

const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;
// GitHub's two icons, cut down to their paint.
const GITHUB_LIGHT = svg(`<svg fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 0" fill="#24292E"/></svg>`);
const GITHUB_DARK = svg(`<svg fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 0" fill="white"/></svg>`);

/// A 16x16 RGBA PNG: a `color` glyph in the middle 8x8, the rest clear, or
/// the whole square filled.
function png(color: [number, number, number], filled = false): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: number[] = [];
  for (let y = 0; y < 16; y++) {
    rows.push(0);
    for (let x = 0; x < 16; x++) {
      const on = filled || (x >= 4 && x < 12 && y >= 4 && y < 12);
      rows.push(...color, on ? 255 : 0);
    }
  }
  const file = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString("base64")}`;
}

test("an icon's ink is read from SVG paint and PNG pixels", () => {
  expect(inkOf(GITHUB_DARK)).toBe("light");
  expect(inkOf(GITHUB_LIGHT)).toBe("dark");
  expect(inkOf(svg(`<svg><path d="M0 0"/></svg>`))).toBe("dark");
  expect(inkOf(svg(`<svg><path fill="#ff6600"/><path fill="white"/></svg>`))).toBe("mixed");
  expect(inkOf(svg(`<svg><path fill="url(#g)"/></svg>`))).toBe("mixed");
  expect(inkOf(png([255, 255, 255]))).toBe("light");
  expect(inkOf(png([10, 10, 10]))).toBe("dark");
  expect(inkOf(png([255, 255, 255], true))).toBe("mixed");
  expect(inkOf(png([230, 80, 20]))).toBe("mixed");
  expect(inkOf("data:image/x-icon;base64,AAAB")).toBe("mixed");
  expect(readableOn(GITHUB_DARK, "light")).toBe(false);
  expect(readableOn(GITHUB_DARK, "dark")).toBe(true);
});

test("each appearance keeps its own icon, and the other stands in only where it shows", () => {
  const store = mkdtempSync(`${tmpdir()}/nb-favicons-`);
  process.env.NB_STORE_DIR = store;
  openFavicons();
  setFaviconAppearance("dark");
  rememberFavicon("https://github.com/oven-sh/bun", GITHUB_DARK);
  rememberFavicon("https://example.com/", png([230, 80, 20]));
  expect(faviconFor("https://github.com/")).toBe(GITHUB_DARK);

  // Light, with only the dark icons known: the white octocat would vanish.
  setFaviconAppearance("light");
  expect(faviconFor("https://github.com/")).toBeUndefined();
  expect(faviconFor("https://example.com/a")).toBe(png([230, 80, 20]));

  // Seen in light, it keeps both.
  rememberFavicon("https://github.com/", GITHUB_LIGHT);
  expect(faviconFor("https://github.com/")).toBe(GITHUB_LIGHT);
  setFaviconAppearance("dark");
  expect(faviconFor("https://github.com/")).toBe(GITHUB_DARK);
  expect(readdirSync(`${store}/favicons/light`)).toEqual([encodeURIComponent("https://github.com")]);
  expect(readdirSync(`${store}/favicons/dark`).length).toBe(2);
});
