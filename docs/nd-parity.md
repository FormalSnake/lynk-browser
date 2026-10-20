# NativeDesktop port: parity checklist

Every user-visible feature of Lynk on `main` (`a2d6bbf`, NativeDesktop 0.5.11, CEF 151 in Chrome
style) against the NativeDesktop build on `nd-port`. A box is ticked only when the feature was
seen working in the nd build, and the line then says how:

- **drive**: an automated drive of the real app over nd's automation socket (the test is named in
  the line). The old app's drive in `scripts/` that covered the feature is named in each line as
  the spec to port, not as evidence.
- **unit**: a unit test in `crates/core` or `crates/lynk` (named in the line).
- **shot**: seen in a screenshot of the running app (macOS unless the line says Linux).
- **linux**: seen in headless Hyprland on g815 through `scripts/linux-gate`, or on e1504g in the
  user's session where the line says so.

`[mac]` and `[linux]` mark lines that hold on one OS only; unmarked lines hold on both. The plan,
the nd lanes the open boxes wait on, and the order of work are in
[nd-port-plan.md](nd-port-plan.md).

Status: **not at parity.** The skeleton opens a window with a sidebar and one Chromium page on
macOS. Nothing below is ticked yet. The 0.5.11 build stays the default until every box is.

## Engine
- [ ] Every page runs in Chromium in Chrome style, so Chromium's extension runtime, `chrome://` pages and picture-in-picture work (lane `cef-chrome-style`)
- [ ] [linux] Pages on Hyprland run under XWayland, sharp with `xwayland:force_zero_scaling`; the rest of the window stays Wayland-native where nd allows
- [ ] Chrome's own browser UI never shows: no toolbar, download bubble, download arrow, zoom bubble or tab search bubble
- [ ] Chrome commands a focused page swallows reach the app: new window, new private window, new tab, reopen closed tab, close tab, next and previous tab, downloads, history, bookmarks, bookmark page, settings, extensions, find, find next and previous, focus address, fullscreen, print, save page, view source, clear browsing data
- [ ] F7, Shift+Esc, F11 and F1 never open a Chromium surface
- [ ] App shortcuts win over page chords (Shift+Cmd+R is reading mode, not a hard reload; old drive `mac-reader-drive`)
- [ ] Password manager, autofill save and translate bubbles stay off per profile; other Chromium bubbles (passkeys) anchor to the window
- [ ] The identity probe passes: no `navigator.webdriver`, no automation globals, `userAgent` and `userAgentData` agree, `Sec-CH-UA*` headers consistent (old `scripts/identity-probe.ts`)
- [ ] One running instance per profile; a second launch does not corrupt the profile

## Windows and layout
- [ ] Sidebar layout: no toolbar and no title band, sidebar the full window height on the leading side
- [ ] [mac] The sidebar is the split view's Liquid Glass sidebar item; the page runs full-bleed beside it, never under it
- [ ] [linux] The page sits in a 12 px rounded card inset 8 from the top, trailing and bottom edges, clipped to the curve with a hairline
- [ ] Compact layout: one row with window controls, back, forward, reload, the tab run, a "+" new tab button, layout, downloads and menu buttons (old `CompactTabs.tsx`)
- [ ] Compact: the active tab is the address, about 156 pt wide, padlock at its start, zoom glyph at its end while not at 100%
- [ ] Compact: inactive tabs shrink to favicons, then leave the row; pinned tabs are favicon only; the active tab never goes under its floor
- [ ] Compact: the layout button leaves the row below its width threshold
- [ ] Layout switch with Alt+Cmd+S, the View menu, Settings > Layout and the "Switch Layout" command, clean both ways and without reloading any page
- [ ] Both layouts work from 1440 down to 720 pt wide with nothing overlapping (old drive `narrow-drive`)
- [ ] Load bar: a 2 pt line in the secondary ink on the page's top edge, slides to each progress value (250 ms ease-out), starts as a sliver, fades 200 ms after the end; reduced motion drops the slide
- [ ] Shift+Cmd+B hides and shows the sidebar (View > Hide Sidebar); hidden, the page fills the window with no frame
- [ ] Edge reveal: with the sidebar hidden, the pointer at the leading edge slides it in over the page as a floating rounded panel with a shadow (200 ms in, 150 ms out, out 250 ms after the pointer leaves); reduced motion fades (lane `nd-sidebar-reveal`; old drive `sidebar-motion-drive`)
- [ ] [mac] Traffic lights in the sidebar's first row, close button 19 pt from the window's left and top; they hide with the sidebar and ride the peeking panel on every frame of both slides
- [ ] [linux] Window controls follow `gtk-decoration-layout`: leading buttons in the sidebar's first row, trailing ones in a strip above the card that drags the window and slides away with the sidebar, none and no strip for ":" (Hyprland); follows the setting live
- [ ] The first row (and the Linux strip) drags the window; a double click zooms as the user set it
- [ ] Page fullscreen takes the whole window with the chrome put away; Esc in the page returns; it ends when the tab stops being the one shown
- [ ] Browser fullscreen: Ctrl+Cmd+F on macOS (green button keeps the chrome), F11 and View > Full Screen on Linux
- [ ] Multi-window: each window has its own tabs, active tab and size; tab ids are unique across windows
- [ ] Cmd+N opens a window; the menu bar acts on the focused window
- [ ] Secondary windows carry a main-menu button: New Tab, New Window, Close Tab, Sleep, Find, History, Downloads, Bookmarks, Settings, Move Tab Left, Right, to New Window, to Window
- [ ] Closing a window closes its tabs; the last window closing quits
- [ ] Cmd+W on the last tab closes the window, and quits if it was the last one
- [ ] `beforeunload` asks "Leave site?" before a tab or window closes
- [ ] Settings window, 640x620, opened with Cmd+,

## Private window
- [ ] Shift+Cmd+N and "New Private Window" open a window whose pages share one in-memory profile, gone when the window closes (lane `webview-private-window`)
- [ ] Nothing from it reaches the session, history or favicon cache; it shows no favicons
- [ ] Banner "Private browsing. This window keeps no history."
- [ ] Its own address field in the header, sidebar header "Private", no command bar
- [ ] Pinning unavailable; permission choices not remembered ("Choices you make here are forgotten when this window closes.")
- [ ] Find, a downloads and settings menu, Move Tab Left and Right
- [ ] Its downloads land in the shared downloads list
- [ ] A normal tab dragged in reopens by URL; a private tab dragged out reopens in a normal window; a live page never crosses profiles

## Popup windows
- [ ] A sized `window.open` opens a small window with a header naming the title and site
- [ ] It is transient for the opener and floats on tiling compositors; the opener keeps a live handle to it (`window.opener`)
- [ ] A private opener's popups stay private
- [ ] Default and minimum sizes as the old `PopupWindow.tsx`

## Sidebar
- [ ] Controls row, 32 pt, holding only the window controls (and a secondary window's menu); hidden when no controls lead
- [ ] Pinned tiles: Arc's favourites grid, at most four columns (three at 720 pt, four from about 900), tiles at least 40 wide, height 0.74 of the width, short last row keeps the pitch, reflows while the divider drags
- [ ] Pinned tile shows the site icon, or its first letter until there is one; `pinStyle = "letters"` shows only letters, the active one in full ink
- [ ] [mac] Each tile is a Liquid Glass pill, the active one raised; macOS 27 adds the interactive glass press
- [ ] [linux] Flat tiles, the active one filled, the rest fill on hover
- [ ] Tab rows: 28 pt tall, 2 apart, 16 pt favicon, title truncated with an ellipsis; the active row filled with its title in full ink, the rest secondary and filled on hover
- [ ] A row's trailing slot: close button on hover and on the active row ("Close <title>"), a spinner while loading, width reserved
- [ ] Hovering a row or tile shows its title over its full address
- [ ] A click on the active row opens the command bar on its address
- [ ] Speaker on a tab playing sound, muted glyph on a muted tab; a click toggles mute ("Mute tab", "Unmute tab"); on a tile the speaker takes the tile's glyph
- [ ] Sleeping tabs draw dimmed
- [ ] [mac] "New tab" row after the tabs, dimmed until pointed at; [linux] a "+" at the foot's trailing end instead
- [ ] Foot, in order: settings, padlock, zoom (while not 100%), blocked pop-ups, extensions puzzle and pinned extension buttons, downloads; [linux] downloads leads and "+" closes the row
- [ ] The tab list scrolls; the controls row, pinned block and foot stay put
- [ ] Drag a row: a line marks the slot, a drop on the list reorders and unpins, a drop on the pinned block pins (lane `nd-tab-drag`; old drive `mac-tabdrag`)
- [ ] Drag a tile over the others: the tile takes the slot under the pointer and the rest slide aside (0.2 s ease-out); a drop keeps the order, Esc or a release outside puts it back
- [ ] A row or tile dropped on another window moves the live page there without a reload
- [ ] Pin moves the tab to the end of the pinned block, unpin to the head of the rest; Next and Previous Tab follow the sidebar order
- [ ] "Reset to Pinned Page", enabled only once the pinned tab left its page
- [ ] Tab menu: Reload, Duplicate Tab, Copy Address, Pin Tab, Mute or Unmute Tab, Move Tab to New Window, Put Tab to Sleep, Close Tab, Close Other Tabs (old drives `mac-tab-menu`, `linux-tab-menu`)
- [ ] Pinned tile menu: Reset to Pinned Page, Unpin Tab, Mute Tab, Put Tab to Sleep, Close Tab
- [ ] Menu on the column off any tab: New Tab, Hide Sidebar, Use Compact Layout

## Command bar
- [ ] Cmd+T: address mode, empty field, Enter opens a new tab; on a blank tab it loads in place
- [ ] Cmd+L (or a click on the active row or compact tab): the current address, all selected, Enter loads in this tab; a second Cmd+L closes it
- [ ] Cmd+K: switcher mode, empty field, Enter loads in this tab; with nothing typed the first row is the page you were on last
- [ ] Opening while open reseeds it, never a second bar
- [ ] Address mode rows, in order: the history-completed address; the typed text ("<words>" with "<engine> Search", or the address with "Open" or "Open in New Tab"); matching open tabs ("Switch to Tab"); history, newest first, one row per URL, never an open tab; matching commands with their shortcut as the hint
- [ ] Switcher rows: the typed row, open tabs most recently shown first, commands
- [ ] Typed text always gets its own row ahead of tabs; Return searches or loads it and never switches tabs
- [ ] Inline completion from history only, host first, `www.` ignored, shown selected after the caret; Backspace stops it until the next insertion; Tab or Right accepts it (unit: port of `omnibox.test.ts`)
- [ ] Up, Down, Home, End; Enter runs the highlighted row; Cmd+Enter submits the text as typed; the top row is highlighted whenever results change
- [ ] Esc or a click outside closes it and gives focus back to the page
- [ ] No request leaves the machine before Return (no engine suggestions)
- [ ] Look: 640 pt panel centred, top at 18% of the window height, 20 pt margin in narrow windows, up to ten 40 pt rows then scroll, window dimmed about 15% behind it with the page live, 20 pt field with a search glyph, 16 pt icon, title, address in secondary text, right-aligned hint that never truncates, accent fill on the highlighted row, no animation (old drive `omnibox-drive`)
- [ ] Every command in `COMMANDS` is a row, with labels that flip (Pin or Unpin Tab, Reading Mode or Leave Reading Mode, Allow or Block Ads on This Site)
- [ ] Hints spelled per OS ("⇧⌘T" on macOS, "Ctrl+Shift+T" on Linux)
- [ ] Search engines DuckDuckGo (default), Google, Bing
- [ ] Address parsing: a scheme is kept, `host.tld` or `localhost:port` becomes `https://`, anything else searches; resubmitting an unchanged `http:` address keeps `http:` (unit: port of `url.test.ts`)
- [ ] Context menu "Search with <engine>" on a selection opens a foreground tab (old drive `mac-context-menu`)

## Tabs and navigation
- [ ] New tab page: a tab with no address showing "Search or enter address" (Search with <engine>), which opens the bar
- [ ] `homepage` setting: where new windows open, empty for the new tab page
- [ ] Back, forward, reload (Cmd+[, Cmd+], Cmd+R); Go menu items enabled from the page's history; compact has buttons for them
- [ ] Entering the address already shown reloads
- [ ] Cmd+W closes through `beforeunload`; Shift+Cmd+T reopens from the closed-tab stack
- [ ] Close Other Tabs closes the unpinned others only
- [ ] Duplicate Tab opens the address in the same window
- [ ] Cmd+1 to Cmd+8 by place, Cmd+9 the last tab once there are nine; the Tabs menu lists every tab with its chord
- [ ] Next and previous tab: Shift+Cmd+] and Shift+Cmd+[ on macOS, Ctrl+Tab and Ctrl+Shift+Tab on Linux
- [ ] A page-opened tab lands as Chrome places it: foreground right after the opener, background after the opener's other background children, never in the pinned block; no opener means the end; an empty or `about:blank` target is dropped (unit: port of `session.test.ts`)
- [ ] Lazy tabs: a tab gets a page the first time it is shown; restored and background tabs wait (old drive `session-drive`)
- [ ] Put Tab to Sleep closes its page and keeps its place, title, icon and address; it reloads when shown and gets its scroll position back; the shown tab hands over to the nearest awake one
- [ ] Load state, progress and the row spinner follow the page
- [ ] "Unable to load this page" with the address, the error and Try Again
- [ ] "Aw, Snap!" with Reload when the renderer is gone
- [ ] Tab titles: the page title, else the display address, else "New Tab"; a restored tab never shows "about:blank"
- [ ] `chrome:`, `chrome-extension:`, `devtools:` and `view-source:` addresses open in a fresh page
- [ ] External protocols (`mailto:`, `zoommtg:`): "Open …?" with an "always" option for real origins, remembered per scheme
- [ ] A tab that aimed at a download goes back to the page it showed; a fresh tab stays until the download ends

## Page tools
- [ ] Find: Cmd+F, Cmd+G, Shift+Cmd+G; a 420 pt bar with previous, next and close; per tab and kept when the tab moves windows; "N matches", "1 match", "Found" or "No matches", tinted on no match; Esc closes
- [ ] Zoom: Cmd+plus, Cmd+minus, Cmd+0 and ctrl-wheel, Chromium's steps (25% to 500%), remembered per host
- [ ] Zoom glyph while not 100%, its popover (Zoom Out, value, Zoom In, Reset), shown for 1.5 s after a chord or menu step (old `zoom-shots`)
- [ ] Developer tools: Alt+Cmd+I (Ctrl+Shift+I), and F12 anywhere in the window
- [ ] View source: Alt+Cmd+U (Ctrl+U) opens `view-source:` in a tab to the right, http, https and file only
- [ ] Print: Cmd+P opens the system print panel for the page (lane `webview-print`)
- [ ] Save Page As (Cmd+S): the page downloaded again with its cookies, through a save panel, named after its title, HTML only
- [ ] Floating video: Alt+Cmd+P lifts the playing (else the largest) video, same-origin frames included, into Chromium's picture-in-picture window, and the same chord brings it back (lane `cef-user-gesture-js`; old drives `mac-pip-drive`, `linux-pip-drive`)
- [ ] A page's own picture-in-picture, document picture-in-picture (Meet) included; "Back to tab" brings its tab forward
- [ ] Reading mode: Shift+Cmd+R runs Readability over a copy of the page in a shadow-root overlay, follows light and dark, Space and Page Down scroll it, Esc and a same-document navigation leave it; the menu label flips (old drives `mac-reader-drive`, `linux-reader-drive`; unit: port of `reader.test.ts`)
- [ ] Chromium's own context menu, with "Search with <engine>" added for selections and no duplicated items

## Permissions and site info
- [ ] A permission request waits with its tab and shows as a popover off the padlock when that tab is shown
- [ ] Allow and Block are remembered per origin and type in `sitePermissions`; a dismissal (Esc, click outside, navigation, close) answers without remembering
- [ ] A request for several types asks again unless all are decided
- [ ] The permission sentences from `PHRASES` (location, camera, microphone, notifications, clipboard and the rest), unknown types spelled out from their name (unit: port of `permissions.test.ts`)
- [ ] Reset Permissions forgets the decisions here and in Chromium
- [ ] Padlock popover: host, the security sentence (no page, valid certificate, parts not encrypted, not encrypted, certificate not verified), "Block Ads and Trackers" with the blocked count, permission rows ("Camera: Allowed") or "This site has not asked for anything yet." (old drives `security-drive`, `address-tab-drive`)
- [ ] Blocked pop-ups: the glyph beside the zoom one, a list of up to 8 per tab with Open, and "Always allow" for the site

## Downloads
- [ ] Chromium runs every download; the app picks the path (`downloadDir`, or `~/Downloads`) and never refetches
- [ ] `askWhereToSave`: a save panel for every download
- [ ] Popover from the foot or compact button: the six most recent, "Files you download appear here.", Open Downloads Folder, Show All; opens by itself when a download starts unless the panel or a permission prompt is up; names past 44 characters cut in the middle
- [ ] Rows: progress ring (spinner when the size is unknown), "4.2 MB of 12.0 MB · 1.3 MB/s · 6 s left", Pause, Resume, Cancel, Try Again (resume in place or restart in the same row), Remove from List, open the file, reveal it (unit: port of `downloads.test.ts`)
- [ ] Dangerous types land as `Unconfirmed NNNNNN.crdownload` and wait for Keep or Discard (the macOS and Linux lists from `downloads.ts`); `.dmg` and `.pkg` left to Gatekeeper
- [ ] "Moved or deleted" checked against the disk whenever a row shows
- [ ] Drag a finished download's icon or name out as a file copy (old drive `mac-download-drag`)
- [ ] `downloads.json`: at most 200 kept, a download cut off by quitting comes back retryable, unique paths counting running downloads
- [ ] Downloads panel (Shift+Cmd+J, Ctrl+J): every download, searchable, Open Folder, Clear List (old drives `pages-drive`, `pages-shots`)

## History and bookmarks
- [ ] Every visit recorded with its title (backfilled when the title arrives), private windows excluded
- [ ] History panel (Cmd+Y, Ctrl+H): a sheet on macOS, a floating card on Linux; search field holds the caret, Return opens the first match, Esc or the chord closes, Done; grouped by day, newest first, one row per URL, up to 500
- [ ] Remove from History on a row (every visit to that URL); Clear… with "Clear History" and "Cancel" and the note that bookmarks and downloads stay; Cookies and Site Data… opens Chromium's page
- [ ] History menu: Show All History, Clear Browsing Data…, the ten most recent visits, "No History Yet"
- [ ] Bookmarks panel (Alt+Cmd+B, Ctrl+Shift+O): flat, searchable, Remove Bookmark per row, the foot bookmarks or unbookmarks the current page
- [ ] Cmd+D toggles the bookmark ("Bookmark This Page", "Remove Bookmark"), http and https only, newest first, the page's own title
- [ ] Routes: `chrome://downloads` and `about:downloads` open Downloads, `chrome://history`, `history-clusters` and `about:history` open History, `chrome://bookmarks` and `about:bookmarks` open Bookmarks, the new tab page addresses become the empty tab, `chrome://tab-search` opens the switcher; from a typed address, a page, an extension or a restored tab (unit: port of `pages.test.ts`)
- [ ] `chrome://settings`, `extensions`, `passwords`, `flags`, `version` and `policy` stay Chromium's pages
- [ ] Clear Browsing Data (Shift+Cmd+Backspace, Ctrl+Shift+Delete) opens `chrome://settings/clearBrowserData`

## Extensions
- [ ] The Chrome Web Store installs extensions: the store page's install call opens the app's own dialog with Chrome's permission lines ("It can:"), Cancel never reaches Chromium, Accept installs (lanes `cef-chrome-style`, `cef-extensions`; old drives `mac-ext-install-drive`, `linux-ext-install-drive`, `webstore-drive`; unit: port of `webstore.test.ts`)
- [ ] The store's "Switch to Chrome" banner and promos are hidden
- [ ] Extensions popover (puzzle): "Extensions", empty state "Extensions you install appear here.", each row with a pin toggle, Options and Remove…, Manage Extensions opens `chrome://extensions`
- [ ] Remove… asks with the app's own confirmation (Return removes, Esc keeps)
- [ ] Pinned extension buttons after the puzzle, in pin order (`pinnedExtensions`), an uninstalled id kept so a reinstall brings the button back; badges and per-tab titles
- [ ] An action click opens its popup anchored to its button (25 to 800x600, default 360x520, sized to its body, `window.close` honoured); a second click closes it; a popup-less action gets `onClicked` with `activeTab`
- [ ] Extension tabs, windows and options pages open as app tabs, not Chromium windows
- [ ] Uninstalling closes its pages; a window left without tabs gets an empty tab
- [ ] [mac] 1Password: installs from the store, its icon opens its popup, it fills a login; the build is signed with the Developer ID (`Developer ID Application: CanaryCoders SL (8E7JB82GJK)`) so 1Password trusts it
- [ ] [linux] 1Password on Hyprland: native messaging works with the root-owned binary from the Nix store and `/etc/1password/custom_allowed_browsers` listing `lynk-browser`; its icon opens its popup and it fills a login
- [ ] Dark Reader installs from the store and darkens a page; its popup toggles it; the setting survives a restart

## Ad blocking
- [ ] adblock-rust with uBlock Origin's default lists, scriptlets and redirects, on by default (lane `cef-request-filter`; old drives `adblock-drive`, `adblock-shots`)
- [ ] Network requests blocked or redirected per rule, cross-site frames included
- [ ] Cosmetic filters and scriptlets applied at document start
- [ ] uBlock Origin 1.75.0 pinned by SHA-256, downloaded on a fresh profile and verified before extraction; a newer release checked weekly against GitHub's published hash
- [ ] Lists refreshed daily from CDN mirrors in order, falling back to the bundled snapshot; a partial download or a captive portal page never replaces a list
- [ ] The compiled engine cached on disk and restored off the main thread; the window never waits on it
- [ ] Per-site switch: "Allow Ads on This Site" and "Block Ads on …" (command, View menu, padlock switch), kept in `offSites`
- [ ] Blocked count per page, reset on navigation, shown in the padlock popover
- [ ] Hide Element (Shift+Cmd+H): a picker in an isolated world, labels the element under the pointer, a click hides it on that site for good as a `site##selector` rule; Esc or the chord again puts it away
- [ ] Show Hidden Elements restores one or all; Update Filter Lists refreshes now
- [ ] `blocking.json` and `adblock/` carried over from the 0.5.11 profile

## Session and data
- [ ] Settings, history, bookmarks and the Chromium profile in `~/Library/Application Support/lynk` and `~/.local/share/lynk` (profile in `cef/` inside), so the 0.5.11 profile opens unchanged or migrates once
- [ ] `settings.json` keys and defaults: `searchEngine` "duckduckgo", `homepage` "", `freshWindow` false, `layout` "sidebar", `pinStyle` "icons", `sitePermissions` {}, `pinnedExtensions` [], `downloadDir` "", `askWhereToSave` false; `restoreOnLaunch = false` read as `freshWindow`; malformed values fall back to defaults
- [ ] Settings window shows every setting as a native row (search engine, homepage, start with a fresh window, layout, pinned tab style, download folder with Change…, ask where to save, site permissions reset)
- [ ] Session restore: every window with its tabs, active tab, size, pinned tabs and their pinned pages; tabs load lazily; `session.json` v1 and v2 read (unit: port of `session.test.ts`)
- [ ] "Start with a Fresh Window": the pins of every window in one window in front of a new tab (the homepage if set)
- [ ] `history.sqlite` (`visits(id, url, title, ts)`) read and written in place
- [ ] Favicons cached per origin and per appearance (light and dark); icons that would vanish on the appearance are rejected; restored tabs show icons before their page loads (unit: port of `favicons.test.ts`)
- [ ] SIGTERM quits gracefully and nothing is cut off mid-write (old `sigterm-check`)
- [ ] Follows the system light and dark appearance

## Keyboard and menus
- [ ] Every chord in `src/lib/keys.ts` bound, `primary` being Cmd on macOS and Ctrl on Linux, with the per-OS variants (history, downloads, bookmarks, view source, devtools, clear data, fullscreen, tab stepping)
- [ ] Menu bar File: New Tab, New Window, New Private Window, Open Address Bar, Switch Tabs, Close Tab, Reopen Closed Tab, Save Page As…, Settings
- [ ] Edit: Copy Address (toast "Link copied"), Find in Page, Find Next, Find Previous, plus the platform's standard items
- [ ] View: Reload, [linux] Full Screen, Hide or Show Sidebar, Use Compact or Sidebar Layout, Downloads, Bookmarks, Bookmark This Page or Remove Bookmark, Reading Mode, Allow or Block Ads, Hide Element, Float Video, Zoom In, Zoom Out, Reset Zoom, View Page Source, Developer Tools
- [ ] Tabs: Next Tab, Previous Tab, Pin or Unpin Tab, Put Tab to Sleep, then every tab of the focused window with its chord
- [ ] Go: Back, Forward; Extensions: Extensions, Chrome Web Store; History: as above
- [ ] The platform's App and Window menus; a main-menu button in secondary windows and in compact on Linux
- [ ] Dialog button order per OS: `[open, always, cancel]` on macOS, `[cancel, always, open]` on Linux

## Platforms and packaging
- [ ] macOS (AppKit) build and run
- [ ] Linux on g815 in headless Hyprland: build and run, the Linux look (light, dark, matugen)
- [ ] Linux on e1504g in the user's Hyprland session: pages, extensions and 1Password
- [ ] App id `dev.formalsnake.Lynk`, name "Lynk Browser", categories Network and WebBrowser
- [ ] [mac] Icon Composer layered icon (background `#0c1736`, the two layers in `assets/icon`); [linux] the Pantheon-style tile
- [ ] [mac] `nd package mac`: the app with the CEF framework and its five helpers, signed with the Developer ID
- [ ] [linux] `nd package linux` AppImage with the CEF runtime beside the binary
- [ ] Nix package: the nd build from the flake, root-owned in the store, replacing the `requireFile` AppImage derivation in `~/.config/nix`, rebuilt on every host
- [ ] Windows: out of scope for M15 (nd's CEF engine does not run there; the 0.5.11 app never shipped there)
