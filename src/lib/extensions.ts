import type { ExtensionAction, InstalledExtension } from "@nativedesktop/react";

/// One extension as the toolbar draws it. The two framework lists each carry
/// half of what a row needs, so a row is the join of them on the id.
export interface ExtensionRow {
  id: string;
  name: string;
  enabled: boolean;
  /// Drawable icon bytes. An ACTION's `iconUrl` is a `chrome-extension://`
  /// address, which no native image loader can fetch; the registry's icon is a
  /// `data:` URI, so that is the only one a `<button>` can show. Empty when the
  /// extension ships none, and the puzzle glyph stands in.
  iconData: string;
  /// "" for an action with no popup in its manifest; a click on one is
  /// `chrome.action.onClicked`, which the engine runs.
  popupUrl: string;
  /// Where the extension sends a person who has not set it up yet, for an
  /// action whose popup is switched off. "" when it declares no options page.
  optionsUrl: string;
}

export function extensionRows(
  registry: InstalledExtension[],
  actions: ExtensionAction[],
): ExtensionRow[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return registry.map((e) => ({
    id: e.id,
    name: e.name,
    enabled: e.enabled,
    iconData: e.iconUrl.startsWith("data:") ? e.iconUrl : "",
    popupUrl: byId.get(e.id)?.popupUrl ?? "",
    optionsUrl: e.optionsUrl,
  }));
}

/// The rows with a toolbar button, in the order they were pinned rather than
/// the order the registry reports. A pinned id with nothing installed behind it
/// draws nothing.
export function pinnedRows(rows: ExtensionRow[], pinned: string[]): ExtensionRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return pinned.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/// The page a hidden view shows so the action's live state can be read: any
/// document of the extension answers for it, so it is the manifest, which runs
/// none of the extension's code. A popup document runs as if opened: 1Password's
/// asked the desktop app to unlock on every launch, then closed itself and left
/// the probe dead.
export function probeUrl(row: ExtensionRow): string {
  return `chrome-extension://${row.id}/manifest.json`;
}

/// The badge colour an extension asked for, as the nearest of the app's own
/// badge variants. The pill is the framework's, which takes a variant rather
/// than a colour, and a grey or a colourless badge is the neutral one.
export function badgeVariant(rgba: number[]): "neutral" | "accent" | "success" | "warning" | "error" {
  const [r = 0, g = 0, b = 0] = rgba;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || (max - min) / max < 0.25) return "neutral";
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  hue *= 60;
  if (hue < 20 || hue >= 330) return "error";
  if (hue < 70) return "warning";
  if (hue < 170) return "success";
  return "accent";
}

export function togglePinned(pinned: string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

/// Chrome's own popup bounds, which an extension's popup document is written
/// against. The app owns the size because a popup in an app view is not sized
/// by its document.
export const POPUP_MIN = 25;
export const POPUP_MAX_WIDTH = 800;
export const POPUP_MAX_HEIGHT = 600;
export const POPUP_DEFAULT_WIDTH = 360;
export const POPUP_DEFAULT_HEIGHT = 520;

export function clampPopup(width: number, height: number): { width: number; height: number } {
  const fit = (v: number, max: number, fallback: number) =>
    Number.isFinite(v) && v >= POPUP_MIN ? Math.min(Math.round(v), max) : fallback;
  return {
    width: fit(width, POPUP_MAX_WIDTH, POPUP_DEFAULT_WIDTH),
    height: fit(height, POPUP_MAX_HEIGHT, POPUP_DEFAULT_HEIGHT),
  };
}
