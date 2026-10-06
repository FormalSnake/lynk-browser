# Styling pointer

GTK styling is not web CSS. The authoritative, always-current key list is generated at
[`docs/styling.md`](../styling.md); read that, not this file, for the actual `style` prop schema.

Do not hallucinate `flex`, `grid`, `position`, `display`, or `justifyContent`; none of these exist
on the `style` prop. Layout comes from container widgets (`<box>`/`<grid>`), never from `style`.
Unknown or web-only keys are rejected at the Solid renderer with a Levenshtein fix-it message
(`validateStyle`) and defensively rejected host-side too, so a bad key fails loudly at commit time
rather than silently doing nothing.

A tile grid is a box prop, not a style: `<box tileMinWidth={40} tileMaxColumns={4}
tileAspect={0.74} spacing={6}>` lays its children out as equal cells that span the box's width,
as many columns as fit at the minimum width (never narrower than a child's own minimum, or than
keeps a child's minimum height at the aspect), a short last row on the column pitch, each cell
`tileAspect` of its width tall. The box's height follows its width, so a resized pane reflows it in
the same layout pass (AppKit `NDBoxView`, GTK `src/gtk/tilegrid.zig`). The same children in a new
order at the same width slide to their new cells (0.2 s ease-out, none with reduced motion), which
is what a drag-to-reorder over the grid looks like.

This file is intentionally short and is not kept in sync with schema changes by hand. Treat
`docs/styling.md` as the source of truth and this file as the "start here" pointer to it.

## cssClasses across platforms

`cssClasses?: string[]` is validated on the Solid side against an Adwaita/GTK allowlist
(`packages/core/src/css-classes-validate.ts`) and rides in the ordinary create/update `props`
JSON; it is not nested under `style` and does not touch the C-ABI vtable.

- **GTK** applies each class verbatim via `gtk_widget_add_css_class` (`src/gtk/style.zig`'s
  `applyCssClasses`, called from `src/gtk/backend.zig`'s `vtCreate`/`vtApplyProps` whenever
  `props.cssClasses` is present). Each update replaces the whole set: classes dropped from
  `cssClasses` are removed from the widget, and the internal `nd-<id>` scoping class is preserved.
- **macOS** maps the semantic subset onto AppKit control properties (`ndApplyCssClasses` in
  `swift/Sources/NDShell/Backend.swift`), with dynamic system colors throughout so dark mode
  keeps working automatically:

  | Class(es) | AppKit mapping |
  | --- | --- |
  | `suggested-action` | `NSButton.bezelColor = .controlAccentColor`, `keyEquivalent = "\r"` |
  | `destructive-action` | `NSButton.bezelColor = .systemRed`, `hasDestructiveAction = true` |
  | `pill` | on a button, `borderShape = .capsule`; on a label, a capsule count badge (`.quaternarySystemFill`, 1/7pt insets) matching GTK's `.nd-badge` |
  | `flat` | `NSButton.isBordered = false`, `showsBorderOnlyWhileMouseInside = true` |
  | `title-1` / `title-2` / `title-3` / `title-4` | `.font = .preferredFont(forTextStyle:)` with `.largeTitle` / `.title1` / `.title2` / `.title3` |
  | `heading` | `.preferredFont(forTextStyle: .headline)` |
  | `caption` / `caption-heading` | `.preferredFont(forTextStyle: .caption1)` / `.caption2` |
  | `body` | `.preferredFont(forTextStyle: .body)` |
  | `dimmed` | `.textColor = .secondaryLabelColor`; on a box, `alphaValue = 0.55` over the whole subtree, as libadwaita's opacity does |
  | `monospace` | `.font = .monospacedSystemFont(ofSize:weight:)` |
  | `numeric` | `.font = .monospacedDigitSystemFont(ofSize:weight:)` |
  | `activatable` | on a box, an `NSTrackingArea`-driven quaternary-fill hover highlight at the concentric radius |
  | `card` | on a box, a raised `NSBox` backing (white in light mode, a white veil in dark) with a hairline, and the box clips its children to the card's corner |
  | `view` | on a box, a quaternary-fill tile (GTK: `box.view` is a 7% `currentColor` tile in the framework base CSS, not Adwaita's view background) |
  | `view` + `glass` | on a box, a Liquid Glass pill of its own (`NSGlassEffectView`, the clear kind toned to a faint slot); with `raised` too, the regular kind tinted toward white, the brighter pill that marks the one on show. The box's children sit inside the glass, so on macOS 27 the pill answers a press with the system's interactive glass (`effectIsInteractive`); macOS 26 has no interactive AppKit glass and draws it still. GTK has no glass and keeps the `view` tile |
  | `osd` | on a progress bar, the thin page-load bar: an accent line that slides to each value and fades out at 1 (GTK: Adwaita's own `progressbar.osd`, animated by the framework) |
  | `osd` + `dimmed` | the same bar in the secondary ink rather than the accent, for a quiet chrome |
  | `toolbar` | on a box, an `NSVisualEffectView` `.headerView` backing plus a 1pt `.separatorColor` bottom hairline |
  | `boxed-list` | on a box, a grouped `NSBox` card with leading-inset hairline row dividers |
  | `navigation-sidebar` | on a box whose children are row-shaped, a `.sourceList` `NSTableView` backing it (`SidebarTable.swift`); `nd-native-sidebar` skips the row-shape gate |

  The font/color rows target `NSTextField`; for `TextArea`/`ScrollView` widgets (an `NSScrollView`
  wrapping an `NSTextView`) they target the wrapped `NSTextView` instead.

  `card` and `view` on anything but a box, and `osd` on anything but a progress bar, are ignored on
  macOS; native chrome for those roles comes from the SplitView/HeaderBar widgets themselves.

  `pill` on a label, `activatable` on a box, and `navigation-sidebar` on a box are the classes
  libadwaita scopes to other widget types. GTK carries them in framework base CSS
  (`src/gtk/basecss.zig`) so both backends read the class the same way. For the sidebar that means
  `box.navigation-sidebar > button` gets libadwaita's own row metrics and states, and
  `suggested-action` there paints the neutral selected-row fill rather than an accent CTA, matching
  what the AppKit table does with the same prop.

## Adwaita runtime & dark mode

The Linux host runs as `AdwApplication` (`src/gtk/main.zig`), so the Adwaita stylesheet is loaded
and `AdwStyleManager` tracks the system light/dark preference from the first frame. Unstyled
widgets and `cssClasses` follow that preference automatically, with no app code required. Hardcoded
`style` colors are explicit overrides and do not adapt to dark mode; prefer `cssClasses` plus
Adwaita defaults for theme-correct apps.

Windows are `AdwApplicationWindow`s (`src/gtk/tabs.zig`), which draw no titlebar of their own. A
tree that declares a `<toolbarview>`/`<headerbar>` supplies its own chrome; a tree that declares
none gets a framework `AdwHeaderBar` bound to the window title, so the window is still draggable and
closable. The framework also insets a wrapped root child by 12px, skipping a root that scrolls or is
otherwise edge-to-edge and a root the app already padded.
