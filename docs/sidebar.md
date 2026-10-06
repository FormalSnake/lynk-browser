# Sidebar layout

The browser has two layouts, switched with Shift+Cmd+S (View menu, Settings).
**Sidebar** is the one this file specifies: a quiet column down the left and
the page in a card beside it. **Compact** is one toolbar row of tabs whose
active tab is the address (docs/omnibox.md); the rule for it here is only that
switching is clean both ways: no toolbar left behind in the sidebar layout, no
controls row or card left in compact, the traffic lights where each layout puts
them.

The reference is Arc with the chrome taken away: the command bar does the work
from the keyboard, and the column only lists tabs. The sizes and spacing below
are set to each platform's own type and colours.

## Window

- No toolbar and no title bar band. The sidebar runs the window's full height
  on the left; the page sits beside it, in a rounded card on GTK
  (`<splitview contentStyle="card">`) and full-bleed on AppKit.
- On AppKit the sidebar is the split view's own Liquid Glass sidebar item,
  which reflects the page beside it as a native one does. On GTK the sidebar
  and the margin around the card are the sidebar colour.
- GTK: the card is inset 8 from the window's top, trailing and bottom edges
  and 0 from the sidebar, whose own 8 of padding is the gap. Radius 12 px,
  libadwaita's card.
- AppKit has no card: public API gives no way to make the margin around it
  Liquid Glass, so the page runs full-bleed to the window's top, trailing and
  bottom edges beside the sidebar, and never under the sidebar.
  With the sidebar hidden it fills the window.
- GTK: the page is inset and clipped to the card's curve, with a hairline; on
  X11 the CEF page's own window gets a bounding shape.
- Window controls follow the platform:
  - macOS: the traffic lights sit in the sidebar's first row, vertically
    centred on it, the close button as far from the window's left edge as from its top (19 pt), on the same leading margin as the tiles
    and rows under them (`<windowcontrols side="start">`; the framework moves
    the window's own buttons onto the slot).
  - GTK: the desktop's `gtk-decoration-layout` decides. Buttons it puts on the
    leading side go in the sidebar's first row like macOS. Buttons on the
    trailing side (GNOME's default) never go in the sidebar: the page area
    grows a strip above the card, as tall as the buttons plus 8 px padding,
    holding them at its right end and moving the window; the card starts
    under it (Zen's arrangement). A layout with no buttons at all (":", what
    Hyprland reports through the settings portal) keeps no room for them: no
    strip, and the card starts at the sidebar's top inset. The placement
    follows the setting live.
- The first row and the strip are the window's drag handles (double click
  zooms, as the user set it).

## Sidebar, top to bottom

1. **Controls row**, 32 tall: the window controls where the platform puts
   them, and nothing else (a secondary window's own menu trails it). Back,
   forward and reload are Cmd+[, Cmd+] and Cmd+R; the address is Cmd+L.
2. **Pinned tabs**: Arc's favourites grid. The tiles span the column's
   content width, from the rows' leading edge to their trailing edge, 6
   between them: as many columns as fit at 40 wide, at most four (three in a
   720 pt window, four from about 900), every tile one cell, and a short last
   row keeps the column pitch. A tile is 0.74 of its width tall, Arc's
   proportion (80 x 108 px in the owner's reference), rounded to whole
   points: 43 x 32 at 720, 63 x 46 at 1280. The framework's box tile grid
   (`tileMinWidth`, `tileMaxColumns`, `tileAspect`) lays it out, so dragging
   the split's divider reflows it in the same pass. A tile shows the
   site's icon, or its first letter until there is one; Settings > Pinned
   Tabs > Letters shows the letter only, the quieter column. The tab on show
   has its letter in full ink, the rest in the secondary ink. On AppKit each
   tile is its own Liquid Glass pill (`cssClasses={["view", "glass"]}`), and
   the tab on show is the raised, brighter pill (`"raised"` too), as in the
   owner's Arc reference (`~/Developer/nativebrowser-ref/arc-glass-pinned.png`).
   GTK keeps the flat tile.
3. **Tabs**: one flat row each, 28 tall with 2 between them, a 16 pt favicon
   and a title in body text that truncates with an ellipsis. The row on show
   is the one filled row, its title in full ink; the rest are in the secondary
   ink and fill only under the pointer. The trailing slot holds a close button
   on hover and on the row on show, or, while that tab loads, a spinner.
   Clicking the row already on show opens the command bar on its address:
   there is no address field.
4. **New tab** (AppKit): a quiet row after the tabs, dimmed until pointed at.
5. **Foot**: small glyphs, settings first, then the padlock (site info and
   permission prompts), the extension actions and the extensions list, and
   downloads. On GTK downloads lead and the New Tab plus closes the row at the
   trailing end, GNOME's idiom in place of the New tab row.

The list scrolls; the controls row, the pinned block and the foot do not.

## Load bar

A 2 pt line in the secondary ink (not the accent) along the page's top
edge, in both layouts, with the row's spinner beside it in the sidebar. It
slides to each progress value (250 ms ease-out), starts at a sliver the
moment a load begins, and fades out 200 ms after it reaches the end. It floats
over the page, so nothing moves. Reduced motion keeps the fade and drops the
slide. (`<progressbar cssClasses={["osd", "dimmed"]}>`.)

## Hiding and edge reveal

- Cmd+S (View > Hide Sidebar) hides it; the page is then immersive on both
  backends, edge to edge with no frame, and the window controls go with the
  sidebar. The chord is instant.
- GTK with trailing controls: the strip slides away with the sidebar and
  keeps no room. The pointer at the window's top edge slides it back in over
  the page (AdwToolbarView's top bar with the content extended under it, so
  the page never moves), and it slides away 250 ms after the pointer leaves
  it. Moving the window by the keyboard or the window manager's own chord
  works throughout.
- While hidden, the pointer touching the leading edge slides the sidebar in
  over the page as a floating rounded panel with a shadow, without resizing
  the page; it slides out 250 ms after the pointer leaves it. In 200 ms, out
  150 ms, ease-out; reduced motion fades instead.
- macOS: the traffic lights are hidden with the sidebar and ride with the
  peeking panel, on its first row at the tiles' leading edge (as far in from
  the window's left as from its top), sliding in and out on the panel's own
  timing. The drive holds the close button to the tiles' edge on every
  display frame of both slides (the host's `ND_REVEAL_TRACE`).
- On GTK the panel is libadwaita's own overlay sidebar, without its dimming.

## Tabs and drag

Rows and tiles are drag sources. A drop on the list reorders (a line marks
the slot) and unpins, a drop on the pinned block pins, and a drop from another
window moves the live page.

A pinned tile pressed and dragged over the others reorders the block as it
goes: the tile takes the slot under the pointer and the others slide aside
along the grid (the framework's tile grid slides a reorder, 0.2 s ease-out).
A drop in the block keeps that order, which the session saves; Escape, or a
release where nothing takes a drop, puts the tiles back. A plain click still
selects. On macOS 27 the press is the system's interactive Liquid Glass (the
pill brightens and swells under the pointer); macOS 26 has no interactive
AppKit glass, and SwiftUI's interactive glass does not answer presses on the
AppKit button inside it, so the pill stays still there. GTK has the flat
tile's own pressed state.

## Not built

- In-row address editing: the row on show opens the command bar
  instead, which is where the address is edited in this app.
- The private window keeps its current sidebar: its address is a text entry
  of its own, and the quiet column there needs a command bar in that window
  first (the omnibox branch's).
- A real pointer drag on Linux is not covered by any drive: XTEST starts the
  drag and the list tracks the slot, but no drop arrives under Xvfb. The drop
  handling itself is the one the mac drive exercises with the real cursor.
