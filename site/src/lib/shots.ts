import type { ImageMetadata } from "astro";
import { getImage } from "astro:assets";

export type Platform = "mac" | "linux" | "windows";

export const platforms: { id: Platform; name: string; toolkit: string }[] = [
  { id: "mac", name: "macOS", toolkit: "AppKit" },
  { id: "linux", name: "Linux", toolkit: "GTK4" },
  { id: "windows", name: "Windows", toolkit: "WinUI 3" },
];

const files = import.meta.glob<{ default: ImageMetadata }>("../assets/shots/*.png", { eager: true });

const byName = new Map(
  Object.entries(files).map(([path, mod]) => [path.split("/").pop()!.replace(/\.png$/, ""), mod.default]),
);

export type Shot = { src: string; srcSet: string; width: number; height: number };

// Captures are retina-sized PNGs; the page never shows them wider than ~1400 CSS px.
export async function optimise(meta: ImageMetadata): Promise<Shot> {
  const img = await getImage({ src: meta, widths: [800, 1400, 2000, 2800], format: "webp", quality: 86 });
  return {
    src: img.src,
    srcSet: img.srcSet.attribute,
    width: meta.width,
    height: meta.height,
  };
}

/** The `<platform>-<view>` capture, if that platform has one. */
export function capture(platform: Platform, view: string): ImageMetadata | undefined {
  return byName.get(`${platform}-${view}`);
}

/**
 * One image per distinct capture for a view, each tagged with the platforms it stands in for.
 * A platform without its own capture of the view shows the macOS one.
 */
export async function variants(view: string) {
  const groups = new Map<ImageMetadata, Platform[]>();
  for (const { id } of platforms) {
    const meta = capture(id, view) ?? capture("mac", view);
    if (!meta) continue;
    groups.set(meta, [...(groups.get(meta) ?? []), id]);
  }
  return Promise.all(
    [...groups].map(async ([meta, shows]) => ({ shot: await optimise(meta), shows: shows.join(" ") })),
  );
}
