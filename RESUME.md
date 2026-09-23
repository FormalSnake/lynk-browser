# Handoff (written 2026-09-23, evening)

Goal: a Chromium browser on macOS and Linux with 1:1 Chrome extension
compatibility, native UI, never a stray Chromium window, tested against the real
app. UI and features follow the Search browser (driceroland/Search, read-only
clone at `~/Developer/nativebrowser-ref/Search`, screenshot `search.png` beside
it): Arc-like but minimal, driven from a keyboard-first command bar, no buttons
needed. Built in: panels (bookmarks, history, downloads), pinned tiles, lazy
tabs, Search's keyboard map, reader (⇧⌘R), floating video (⇧⌘P), a built-in ad
blocker that behaves like uBlock Origin. To resume, tell Claude: "read RESUME.md
and continue".

Development is paused. Every agent is stopped; nothing is running on purpose.

## How this project is run

- One orchestrator session, opus agents, one git worktree each
  (`~/Developer/nd-<topic>` framework, `~/Developer/nativebrowser-<topic>` app).
  Agents commit on their branch, never merge, never push.
- The orchestrator reruns every gate itself before a merge. Agent reports were
  wrong or stale several times; a report is a lead, my own run is the proof.
- Merge bar: rebase onto `main`; no leg green on a `main` baseline built and run
  the same way may be red on the branch.
- Visual bar (owner): look at a capture of every touched surface at a normal and
  a narrow width, both platforms. Crammed, overflowing, wrong size, wrong
  layout, off-centre all block a merge. Context menus included (real
  right-click, no duplicate items). Also in the app's `CLAUDE.md` (gitignored).
- Every confirmed framework fix ships to npm the same day. Release: bump the 12
  publishable `packages/*/package.json` (not `mcp`), `bun install`,
  `bun scripts/release/check-versions.ts <v>`, commit `release: v<v>`, tag, push
  main and the tag. Then in the app retry `bun install` until 0.4.x resolves (it
  lags ~5 min) and commit `chore(deps): <v>` alone.
- A parallel "NativeDesktop session" also releases from the same checkout.
  `git log --oneline -3 main` before assuming where main is.
- Uncommitted work is never discarded. Every branch below that ends in a
  `wip:` commit holds a dead agent's unverified half: never merge a `wip:`.
- Usage limits cut all agents twice today (14:10, 19:00ish). Resume them with
  their brief; tell them to commit each verified unit as they go.

## Where things are

Framework `~/Developer/NativeDesktop` main = `ff3e5eb release: v0.4.17`
(published). App `~/Developer/nativebrowser` main = `c341bba chore(deps):
0.4.17` (not pushed). Merged today: headerbar-field, ndshot-hang, startup-window.

| Worktree(s) | Branch | State | Next |
|---|---|---|---|
| `nd-min-width` + `nativebrowser-crash` | `min-width` / `crash-minwidth` | Done by agent: 1266 px compact crash reproduced on main and fixed, file choosers are host dialogs transient for the app window, app accelerators pre-empt page chords, layout switch on ctrl+alt+s. `.repro-sync.sh` untracked there, the old agent's. | My own g815 rerun never reported (verifier died). Rerun x11 + hypr branch vs main, then merge + release. |
| `nd-focus-return`, `nd-focus-mac` | `focus-return`, `focus-return-mac` | Focus fight between two windows (1.2M refocus), hung commands to removed views, AppKit palette closing on open, ctrl+l/cmd+l select the whole address. Linux green on the agent's runs; `focus-return-mac` is the mac half on top. | Mac gates owed; `mac-headerfield.sh` failed once at the padlock click, rerun branch vs main twice each. Then merge. |
| `nd-permission-states` | `permission-states` | Linux engine gate green. | Mac gates never completed (lock starvation). Run `cef-chrome-style.sh` + `cef-reparent.sh` branch vs main, merge. |
| `nd-no-escape` + `nativebrowser-escape` | `no-escape` (+8, then `wip:`) / `escape` (+1) | No Chromium window reachable: extension tabs/windows/options pages become app tabs (a cause of "two omniboxes"), F7/Shift+Esc/F11/F1 refused, three Chromium context items removed; refused commands reach the app as `browserCommand`. Table in `nd-no-escape/ESCAPES.md`. App side: onBrowserCommand, external schemes to the OS. | Finish the wip; cmd+P zooms to 110% instead of printing; wlr + hypr rigs never ran the routes (drive can't type into the field under XWayland: use setValue); mac `ND_ESCAPE_GROUPS=menu`. Merge this before `bubbles`. |
| `nd-dock-gap-app` | `dock-gap-app` (+10, then `wip:`) | Page flush against docked DevTools on both platforms. GTK `<select>` popups no longer moved. BLOCKER on mac: the page container sits over the inspector, so real clicks on the device toggle, splitter and panels go nowhere (debugger-driven legs hid it). Agent was mid-fix: the inspector's input view lands in the click-through anchor window. | Finish the mac layout, prove with `app-chrome-style.sh dockTiling` via app.cursor + a real device-mode capture. |
| `nd-omnibox` + `nativebrowser-omnibox` | `omnibox` (+17) / `omnibox` (+9, then `wip:`) | Two-omnibox cause fixed (new-tab field + header field). Bar keeps the owner-approved look (restyle reverted on request). GTK panel hugs its rows, AppKit dim covers the window, long URL inset, ⌘K tab switcher, every action a command, history-only completion, one shortcut table feeds menu and bar (⇧⌘[ ⇧⌘] tabs, ⇧⌘N private). | Finish wip, fix: blur on the address field re-navigates and rewrites http→https. Rebased onto v0.4.17 already. Send me gate commands, merge. |
| `nd-sidebar` + `nativebrowser-sidebar` | `sidebar` (+1, `wip:`) each | Early. Spec in `nativebrowser-sidebar/docs/sidebar.md`. | See owner requirements below. |
| `nd-bubbles` + `nativebrowser-bubbles` | `bubbles` (+3/+2, then `wip:`) | Native zoom (magnifier in the field, popover −/value/+/Reset, `zoomChanged` event, trailing-icon popover anchor), Chromium bubbles refused, password manager/autofill-save/translate off per profile. `app.cursor.press` sends real key chords. Table in `nd-bubbles/BUBBLES.md`. | Linux: Chromium's zoom bubble still flashes in the page (try `is_chrome_page_action_icon_visible(ZOOM)`=false). Find popover survives Escape and swallows the pointer: that is why select/wheel/textSelection are red on main. Verify 1Password still fills with password manager off. Rebase over no-escape. |
| `nd-pages` + `nativebrowser-pages` | `pages` (+6 / +2, then `wip:`) | History, bookmarks, downloads as Search-style searchable panels one keystroke away; mac app drive green. | Real-cursor drag of a download out to Finder was running; filename showed as "…" on g815 earlier. |
| `nd-reader` + `nativebrowser-reader` | `reader` (+3 / +1) | ⇧⌘R reading mode and ⇧⌘P floating video; PiP window keeps its corner and carries the app class. Mac drive green with real keystrokes. | Captures by eye were in progress; Linux run; add both as bar commands. |
| `nd-adblock` + `nativebrowser-adblock` | `adblock` (+4, `wip:` / `wip:` only) | Built-in blocker instead of uBO MV2 (stock CEF 151 cannot run MV2 at all; no flag, policy or prebuilt helps). Engine brave/adblock-rust behind our own C ABI, network blocking via `on_before_resource_load`, cosmetic + scriptlets at document start, cross-site frames reached on GTK, OOPIF path on AppKit in progress. App side: lists, per-site off, ⇧⌘H element hider. | Adds Rust to both hosts, the flake and release.yml. Estimate was 3 to 5 days total. |
| `nd-ext-click` + `nativebrowser-ext-click` | `ext-click` (`wip:` only, large) | Extension icon clicks without a CEF build. mac: page BrowserView asks CEF_CTT_NORMAL then hides the toolbar, and CDP `Extensions.triggerAction` over a browser-target pipe fires `chrome.action.onClicked` + grants `activeTab` (proven). Linux: `ND_CEF_VIEWS_HOSTED=1` prototype, engine gate 16/17 incl. actionClick; uninstall's Chrome dialog never maps (anchored to the hidden toolbar). | Owner-approved order: AppKit registry commands (list, listActions, readAction, watch, then install/uninstall/setEnabled; the mac toolbar is empty today), real icon click on mac with 1Password; uninstall silent with an app-native confirmation; then real-app rigs x11/wlr/hypr with the Views switch, stop within a day if focus/XWayland regresses. |
| `nd-dragpoint` | `drag-point` (`wip:` only) | AppKit `ndDragPoint` disagrees with `ndNodeBounds` for views in the header bar (drop x 19 pt left, tab lands one slot early). Fix + `examples/dragpoint` in progress. | Finish, then `nativebrowser` `scripts/mac-tabdrag.ts` legs 3 to 5. |
| `nd-startup-window`, `nd-ndshot`, `nd-headerbar-field` | merged | Removable with `git worktree remove` (never `--force`). Also `nd-startup-base` (baseline, uncommitted scripts) and `nativebrowser-omnibox-repro`. | |

The app agent's own queue (on app `main`): drop-index fix above, then narrow
widths (both layouts to ~720 px, address field never in the overflow, tabs
shrink to favicon with the active one keeping its title; windows refuse under
977 / 1195 px today), Search's keyboard map, pinned letter tiles, lazy restored
tabs, and adopting 0.4.17 in compact (drop `addressWidth`, padlock via
`leadingIconName`, drop the bold-title workaround).

## Owner requirements given today (not all built yet)

- Two layouts: sidebar ("Arc mode", Search look) and compact standard row,
  ⇧⌘S toggles.
- Sidebar: quiet and flat like Search: pinned tiles at the top, tab list, faint
  "+ New tab", one settings glyph at the bottom, no back/forward/reload buttons.
  macOS 26/27: a real glass sidebar (split-view sidebar item) so it shows the
  native reflections; the webview does NOT extend under it. The glow must also
  reach the frame around the page card; if public API can't, drop the frame
  like Search (page full-bleed). With the sidebar hidden, equal inset on all
  sides (or none, if the frame goes).
- GTK: window controls follow `gtk-decoration-layout`: on the right they sit in
  a Zen-style strip that the browser area grows along its top (nothing overlays
  the page); on the left they sit in the sidebar; none (g815 Hyprland) means no
  strip and no reserved space. Bottom row: downloads left, bare plus right.
- Command bar: keep the current look. Keyboard first; the owner never uses UI
  buttons.
- Loading bar: quiet, Arc/Search-like, no layout shift, both layouts.
- Chromium pages worth replacing become native (downloads, history, bookmarks,
  no NTP); chrome://settings, extensions, passwords stay Chromium.
- Page bubbles anchored natively or suppressed; zoom native.
- Extension icon clicks must behave as in Chrome (1Password).

## Gate commands

- Linux, always inside `nix develop --command bash -c '...'` on g815, own
  display/port/app id per run (`ND_CEF_DISPLAY`, `ND_CDP_PORT`, `ND_APP_ID`;
  real-app rig: `ND_ACCEPT_DISPLAY`, `ND_ACCEPT_FIXTURE_PORT`, `ND_ACCEPT_RIGS`),
  and a private `XDG_RUNTIME_DIR`/`ND_SHOT_DIR`.
  - engine: `scripts/headless-webview-cef-chrome.sh` -> `ND_CEF_CHROME_OK`
  - real app: `ND_APP_DIR=<app copy> scripts/headless-app-chrome.sh`, rigs x11,
    wlr, hypr. Red on main today (x11, alone): wheelScroll, textSelectionDrag,
    selectDropdownOpens/Picks (the find-popover bug), tabTraversalLeavesThePage,
    paletteOverPage/TakesKeys; wlr adds the four `focusRouting*.toField`.
  - GTK widgets: `ND_BROWSER_APP_DIR=/nonexistent ./scripts/browser-gate.sh` ->
    `ND_AUTO2_OK`; `headless-headerfield.sh`, `headless-menu-order.sh`.
  - app drive: `ND_FRAMEWORK_DIR=<fw> ND_HOST_BINARY=<fw>/zig-out/bin/nd-hello ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT=~/.cache/nativedesktop/cef/151.3.23-linux64/Release bash scripts/headless.sh bun scripts/browser-drive.ts` -> `NB_MVP_OK` (leg 13 fixed, 5/5).
  - Many rigs at once give false reds: rerun a red alone vs a main baseline.
- Mac: one CEF host at a time machine-wide via `scripts/mac/cef-gate-lock.sh`
  (now on main): FIFO tickets under `/tmp/nd-mac-cef-gate.queue`, reentrant
  (a script started by the holder goes straight on), warns after 10 min.
  Wrap ad-hoc runs: `bash -c '. ~/Developer/NativeDesktop/scripts/mac/cef-gate-lock.sh; cef_gate_lock; trap cef_gate_unlock EXIT; ND_CEF_CACHE=$RUN_DIR/cache timeout 540 <cmd>'`.
  Gate scripts that source the lock themselves (`cef-chrome-style.sh`) run
  bare. One hold at most 10 minutes. `hostStaysKey` red = the owner took focus,
  rerun.
  - `cef-chrome-style.sh` -> `cef chrome style: OK` (includes the relaunch and
    two-hosts-one-profile legs), `cef-reparent.sh`, `mac-headerfield.sh`,
    `mac-menu-order.sh`, `mac-m11-body.sh`, `region-capture-drive.ts` ->
    `ND_REGION_CAPTURE_OK`, `cursor-drive.ts` -> `ND_CURSOR_OK`.
- Mac input and captures: `app.cursor` (real HID mouse; `.press` real key
  chords on the bubbles branch) and `ND_AUTOMATION_CAPTURE=region` or
  `tools/ndshot/bin/ndshot capture --region`, each call under `timeout 30`.
  ndshot used to livelock when two ran at once (replayd keys clients by path);
  fixed in 0.4.17, it now serialises and exits 5 after 15 s.
- GTK widget layer runs on this mac: `bun run dev -- --backend gtk` (Quartz
  gdk, brew libadwaita). No CEF, no cursor, no lock. Capture every Arc/Search
  surface on AppKit and GTK side by side.

## Open owner reports

- Two omniboxes: fixed on `omnibox` (app) and `no-escape` (extension windows).
- DevTools gap / phone icon: `dock-gap-app`, mac click-through blocker open.
- Chromium UI escapes: `no-escape`, Linux wlr/hypr unproven.
- Zoom and other bubbles centred on the page: `bubbles`, Linux zoom flash open.
- Compact 1266 px crash, Ctrl+Shift+S dialog: `min-width`, merge pending.
- 1Password icon click: `ext-click`.
- uBlock Origin by default: replaced by the built-in blocker (`adblock`).
- Passkey sheet top right on Hyprland: the owner's window rule for empty class
  + title (`~/.config/hypr/hyprland.lua:507`).
- Stock CEF ships without H.264/AAC and Widevine (unverified).
- When a second app instance finds the profile in use it just logs
  `ND_CEF_PROFILE_IN_USE`; offered to focus the running window instead, no
  answer yet.

## Hosts

- g815: NixOS, Hyprland (no window controls), fish login shell
  (`ssh g815 bash -s <<'EOF' ... EOF`), CEF dist
  `~/.cache/nativedesktop/cef/151.3.23-linux64`, build hosts from source. 83 GB
  free after a 14-day nix GC today. Display :0 and `~/.local/share/nativebrowser`
  are the owner's. Live instance (`nd-main`, `nativebrowser-run`) NOT running;
  relaunch per its `run-on-desktop.sh` once the crash fix is released.
- e1504g: 8 cores, 7 GB RAM, unused.
- Mac SD card `/Volumes/Music` (APFS, owner's music): reserved for a future
  custom CEF build under `/Volumes/Music/cef-build`, not used yet.
- rsync excludes: `.git node_modules packages/*/dist zig-out .zig-cache` (and
  `dist screenshots` for the app); never `--delete`.
