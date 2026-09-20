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
  /// "" for an action with no popup. Such an action cannot be triggered at all
  /// here: without a Chromium toolbar button there is nothing for
  /// `chrome.action.onClicked` to fire on, so the row says so rather than
  /// offering a click that would do nothing.
  popupUrl: string;
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
