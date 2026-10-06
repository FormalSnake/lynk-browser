// Every keyboard shortcut the app declares, in the menu's own spelling. The
// menu bar reads its accelerators from here and the command bar reads its
// hints from here, so a hint can never name a key that does nothing.
//
// ⌘Tab belongs to macOS's app
// switcher and never reaches the app, so tabs step with ⇧⌘] and ⇧⌘[ there and
// with Ctrl+Tab elsewhere. The floating video is ⌥⌘P, not ⇧⌘P,
// which 1Password takes system-wide for Quick Access.
const MAC = process.platform === "darwin";

export const KEYS = {
  "new-tab": "primary+t",
  "new-window": "primary+n",
  private: "primary+shift+n",
  address: "primary+l",
  switcher: "primary+k",
  "close-tab": "primary+w",
  "reopen-tab": "primary+shift+t",
  settings: "primary+comma",
  find: "primary+f",
  "find-next": "primary+g",
  "find-previous": "primary+shift+g",
  reload: "primary+r",
  back: "primary+[",
  forward: "primary+]",
  "toggle-sidebar": "primary+s",
  layout: "primary+alt+s",
  "zoom-in": "primary+plus",
  "zoom-out": "primary+minus",
  "zoom-reset": "primary+0",
  reader: "primary+shift+r",
  float: "primary+alt+p",
  "hide-element": "primary+shift+h",
  "next-tab": MAC ? "primary+shift+bracketright" : "primary+tab",
  "prev-tab": MAC ? "primary+shift+bracketleft" : "primary+shift+tab",
  // The panels take Chrome's own chords on each platform.
  history: MAC ? "primary+y" : "primary+h",
  downloads: MAC ? "primary+shift+j" : "primary+j",
  bookmarks: MAC ? "primary+alt+b" : "primary+shift+o",
  "bookmark-page": "primary+shift+b",
} as const;

export type KeyId = keyof typeof KEYS;

/** Chrome's tab chords: the first eight tabs by number, and 9 for the last. */
export function tabKey(index: number, count: number): string | undefined {
  if (index === count - 1 && index >= 8) return "primary+9";
  return index < 8 ? `primary+${index + 1}` : undefined;
}
