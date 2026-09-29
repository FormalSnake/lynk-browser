// Every keyboard shortcut the app declares, in the menu's own spelling. The
// menu bar reads its accelerators from here and the command bar reads its
// hints from here, so a hint can never name a key that does nothing.
//
// Chords follow the Search browser's map. ⌘Tab belongs to macOS's app
// switcher and never reaches the app, so tabs step with ⇧⌘] and ⇧⌘[ there and
// with Ctrl+Tab elsewhere; ⇧⌘P is kept free for the floating video, so a
// private window is ⇧⌘N.
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
  "zoom-in": "primary+equal",
  "zoom-out": "primary+minus",
  "zoom-reset": "primary+0",
  "next-tab": MAC ? "primary+shift+bracketright" : "primary+tab",
  "prev-tab": MAC ? "primary+shift+bracketleft" : "primary+shift+tab",
} as const;

export type KeyId = keyof typeof KEYS;
