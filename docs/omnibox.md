# Omnibox

The command bar is the main way to drive the browser, modelled on Arc's
Command Bar (Arc's help center calls it that, opened with ⌘T). The keyboard
does everything: every button and menu item is also a command in the bar.

## Opening

| Keys | Mode | Field holds | Enter on typed text |
|---|---|---|---|
| ⌘T (File > New Tab) | address | nothing | opens it in a new tab |
| ⌘L, or a click on the sidebar address | address | the current URL, all selected | loads it in this tab |
| ⌘K | switcher | nothing | loads it in this tab |

Opening the bar while it is open reseeds it. It never stacks a second bar.

## Rows

One rule covers both modes: typed text always gets its own row, ahead of
every open tab. Return on what you typed searches it or loads it, never
switches tabs. A tab that matches by title, host or address is the row
below, hint "Switch to Tab", and is only switched to when you arrow down to
it.

Address mode (⌘T, ⌘L), in this order:

1. The completed address, when history has one for what was typed. It is
   what the field shows, so Enter opens it, even when a tab already has it
   open; switching to that tab stays its own row further down.
2. What Enter does with the text as typed: "words" plus "<engine> Search"
   (hint "Search"), or the address itself (hint "Open", or "Open in New Tab"
   after ⌘T).
3. Open tabs that match, hint "Switch to Tab".
4. History matches, newest first, one row per URL, hint "Open". An open tab
   is never also offered as history.
5. Commands whose name matches, each with its shortcut as the hint.

Switcher mode (⌘K):

1. With text typed, the typed row as above, loading in this tab.
2. The open tabs that match, most recently shown first.
3. Commands whose name matches.

With nothing typed the first row is the page you were on last, so ⌘K then
Return goes back to it.

The commands cover every action:
- Tabs: new, close, reopen, next, previous, pin, duplicate, move to a new
  window.
- Navigation: back, forward, reload, copy address.
- Find, zoom, reading mode, floating video, site settings, downloads,
  extensions, the web store, layout and settings.

## Keyboard

- Up and Down move the highlight, Home and End jump. The top row is
  highlighted whenever the results change.
- Enter runs the highlighted row. Cmd+Enter submits the typed text as is.
- Completion comes from history only. When the typed text is the start of a
  visited address (host first, `www.` ignored), the rest of it appears in the
  field, selected, after the caret. Typing over it keeps completing.
  Backspace removes it and does not complete again until the next insertion;
  Enter then goes to what was typed. Tab or Right accepts it.
- Nothing typed leaves the machine until Return. There are no engine
  suggestions.
- Esc closes the bar and gives focus back to the page. So does a click
  outside the panel.

## Look

- One floating panel, 640 pt wide and centred horizontally, over the window
  it was opened from. Its top edge is fixed at 18 percent of the window
  height, so the field does not move while results change. Narrower windows
  keep a 20 pt margin. The panel is as tall as its rows, up to ten; more
  rows scroll.
- The whole window dims behind it (black at about 15 percent), toolbar,
  sidebar and the page included. The page stays on show and live under the
  bar on both platforms; on GTK a theme in the user's `gtk.css` does not
  change that.
- At the top is a large single-line field (20 pt text) with a leading search
  symbol. A long address stops short of the right edge by as much as it
  starts from the left. Below it are a hairline and the rows. With no rows,
  the panel is the field alone.
- Each row is one line, 40 pt tall: a 16 pt favicon or symbol, the title,
  the URL in secondary text after it, and a right-aligned hint in secondary
  text. The subtitle truncates first, then the title. The hint never does.
- The highlighted row takes the system accent fill.
- No open or close animation.

## Layouts

Both layouts act the same: the bar is the only address field.

- Sidebar (Arc): the row on show is the address. A click on it does what ⌘L
  does.
- Compact: the tab on show is the address, wider than the others, with the
  padlock at its start and the zoom glyph (while not at 100%) at its end. A
  click on it does what ⌘L does; the padlock and zoom popovers open under it.
- Hovering any tab, row or pinned tile in either layout shows its title over
  its whole address. Link hover in the page keeps Chromium's status bubble.

## Not matched yet

- Arc's site search on Tab ("Search YouTube"), its per-Space accent colour,
  and Little Arc.
