# Handoff (written 2026-09-23)

Goal: a Chromium browser on macOS and Linux with 1:1 Chrome extension
compatibility, native UI, never a stray Chromium window, tested against the real
app. To resume, tell Claude: "read RESUME.md and continue".

## How this project is run

- One orchestrator session, several opus agents, one git worktree each
  (`~/Developer/nd-<topic>` for the framework, `~/Developer/nativebrowser-<topic>`
  for the app). Agents commit on their branch, never merge, never push.
- The orchestrator reruns every gate itself before a merge. Agent reports were
  wrong or stale several times; a report is a lead, my own run is the proof.
- Merge bar: rebase onto `main`, then no leg that is green on a `main` baseline
  built and run the same way may be red on the branch. Known-red legs are listed
  below and stay out of the bar.
- Visual bar (owner): before a merge, look at a region capture of every
  touched surface at a normal and a narrow width. Crammed content, overflow or
  clipping, wrong control size, wrong layout, off-centre content all block it.
- Every confirmed framework fix ships to npm the same day (both CLAUDE.md files
  say so). Release: bump the 12 `packages/*/package.json`, `bun install`,
  `bun scripts/release/check-versions.ts <v>`, commit `release: v<v>`, tag
  `v<v>`, push main and the tag; CI publishes. The registry lags per package:
  retry `bun install` in the app until `@nativedesktop/host` resolves, then
  commit `chore(deps): <v>` alone.
- A parallel "NativeDesktop session" (not this orchestrator) also releases from
  the same checkout: 0.4.13 (GTK sizing batch), 0.4.14 (region capture),
  0.4.15 (`app.cursor`, real cursor), 0.4.16 (MCP bridge defaults). Always
  `git log --oneline -3 main` before assuming where main is.
- Uncommitted work is never discarded. An agent cut off mid-work leaves its
  edits in its worktree; commit them as `wip:` to rebase, never merge a `wip:`.

## Where things are

| Tree | Branch | State |
|---|---|---|
| `~/Developer/nativebrowser` | `main` (f2294c5 + 8c6b43c, not pushed) | Deps ^0.4.13. Compact row = tabs + one address field (2b62f50), chrome:// tabs created at their URL, extensions toolbar with live action state (8c6b43c: a popup switched off at runtime opens the extension's onboarding page instead). |
| `~/Developer/nativebrowser-crash` | `crash-minwidth` | Crash agent's app half (see open reports). |
| `~/Developer/NativeDesktop` | `main` = v0.4.16 published | 0.4.9 permissionRequest event, 0.4.10 tabs.create URLs + watchExtensions + installExtension timeout, 0.4.11 readExtensionAction, 0.4.12 dialogs visible over a page + Chromium windows carry the app class, 0.4.13 to 0.4.16 from the other session. |
| `nd-dock-gap-app` | `dock-gap-app` (8 commits, on 0.4.13) | DevTools placeholder fix both platforms (the 150 px strip, device mode in the page). Green on dockTiling run alone. REGRESSES `selectDropdownOpens/Picks` on x11 (main green). Agent on it. |
| `nd-permission-states` | `permission-states` (3 commits, on 0.4.16) | Dismiss state, `resetPermissions`, `permissionDismissed` event, frame URL + main-frame flag, `URL.origin` form. Linux engine gate green on my run. Mac gates still owed (my run collided). |
| `nd-focus-return` | `focus-return` (3 commits, on 0.4.13) | Focus fight fixed (two browsers, 55,601 on_set_focus; views under 32 px never take the keyboard), `onFocusChanged`, `webviewEngine.active()`/`cefStyle()`. REGRESSES `paletteTakesKeys`. Agent on it, then the host wedges and the AppKit gaps. |
| `nd-headerbar-field` | `headerbar-field` (3 commits + popover work, on 0.4.14) | Title field fills the free run, `leadingIconName` + `onLeadingIconClicked`, a button/box `font` reaches labels. GTK green (isolated run), mac header gate green. Agent finishing the AppKit popover (empty blob) and rebasing. |
| `nd-min-width` + `nativebrowser-crash` | `min-width` / `crash-minwidth` | Crash agent: see open reports. |
| `nd-startup-window` | `startup-window` | Chrome's "Restore pages?" bubble and a full "New Tab - Chromium" window after an unclean exit or a locked profile; per-run `ND_CEF_CACHE` and a machine-wide mac gate lock. |
| `nd-ext-popup`, `nd-ext-actions`, `nd-chrome-dialogs`, `nd-dock-gap`, `nd-focus-backdrop`, `nd-gtk-sizes`, `nd-menu-move`, `nd-hypr-menu`, `nd-devtools-close`, `nd-chrome-style-mac`, `nd-chrome-accept` | merged | Can be removed with `git worktree remove` (never `--force` on a dirty one). `/tmp/nd-mainref` is a stale worktree an agent left. |
| g815 | `~/Developer/nd-main`, `~/Developer/nativebrowser-run` | The owner's live instance. NOT running (closed after the compact crash). Relaunch: sync both, `zig build` in `nd-main` inside `nix develop`, `bun install` in the app dir, then `setsid nohup nix develop ~/Developer/nd-main --command bash ./run-on-desktop.sh` (script in the app dir there; needs a Hyprland session on the box). Crash log kept at `~/Developer/nativebrowser-run-crash-0923.log`. |

## Agents in flight (resume with SendMessage; if dead, respawn with the same brief)

1. Docking (`nd-dock-gap-app`): fix the `<select>` regression, rerun x11 alone.
2. Crash (`nd-min-width`, `nativebrowser-crash`): compact row demands 1482 px at
   1266 wide (tab buttons keep the full title as minimum:
   `ndButtonApplyIconData`, widgets.zig:310; app widths from windowWidth);
   0/0 NaN in libadwaita on `setShowSidebar` after compact starved the sidebar;
   `ND_CHILD_EXITED reason=` marker; declared app accelerators must never reach
   Chromium (Ctrl+Shift+S is Chromium's Save page as: each press opened a file
   dialog that alt-tab lists as nd-hello); Chromium file dialogs routed or
   transient; app shortcut moved off Chromium's chords.
3. Focus (`nd-focus-return`): `paletteTakesKeys` regression, then the host wedge
   on a command to a removed widget, two views on chrome://extensions wedging the
   host, AppKit header-bar SearchInput not automatable, AppKit palette not
   presenting while a search input holds first responder.
4. Header field (`nd-headerbar-field`): AppKit popover content 0x0 (empty blob,
   pre-existing), then rebase and four mac gates.
5. Startup window (`nd-startup-window`): as above.
6. App (`~/Developer/nativebrowser` main): tab dragging between windows keeping
   the live webview (`moveNode`), multi-window session store, menu fallbacks.
   Leg 13 (cookie after restart) flaked 2/4 with 8c6b43c: must be explained.

After all of them: rebase each onto main, my own gate runs, merge, one release,
bump the app, adopt in the app: drop `addressWidth` computation and move the
padlock into the field (`leadingIconName`), drop the bold-title workaround,
adopt `permissionRequest` dismiss state + `resetPermissions`, `onFocusChanged`,
`webviewEngine.active()` instead of the userAgent probe, delete the probe-view
re-focus once focus-return ships. Then relaunch on g815.

## Gate commands

- Linux, always inside `nix develop --command bash -c '...'` on g815, own
  display/port/app id per run (`ND_CEF_DISPLAY`, `ND_CDP_PORT`, `ND_APP_ID`;
  real-app rig: `ND_ACCEPT_DISPLAY`, `ND_ACCEPT_FIXTURE_PORT`, `ND_ACCEPT_RIGS`),
  and a private `XDG_RUNTIME_DIR`/`ND_SHOT_DIR` for the browser gate (shared
  `/run/user/1000` made two runs clobber one screenshot).
  - engine: `scripts/headless-webview-cef-chrome.sh` -> `ND_CEF_CHROME_OK`
  - real app: `ND_APP_DIR=<app copy> scripts/headless-app-chrome.sh`, rigs x11,
    wlr, hypr. Known red: x11 `wheelScroll`, `textSelectionDrag`,
    `tabTraversalLeavesThePage` (focus-return turns the last green); wlr adds
    the four `focusRouting*.toField` (XWayland delivers keys to the child window
    under the pointer; documented, unfixed).
  - GTK widgets: `ND_BROWSER_APP_DIR=/nonexistent ./scripts/browser-gate.sh` ->
    `ND_AUTO2_OK`; `scripts/headless-headerfield.sh`, `headless-menu-order.sh`.
  - app drive: from an app copy, `ND_FRAMEWORK_DIR=<fw> ND_HOST_BINARY=<fw>/zig-out/bin/nd-hello ND_WEBVIEW_ENGINE=chromium ND_CEF_STYLE=chrome ND_CEF_ROOT=~/.cache/nativedesktop/cef/151.3.23-linux64/Release bash scripts/headless.sh bun scripts/browser-drive.ts` -> `NB_MVP_OK`.
  - Four rigs at once on g815 produce false reds. Rerun a red rig ALONE and
    against a main baseline built the same way before believing it.
- Mac (`ND_NDSHOT=$HOME/Developer/NativeDesktop/tools/ndshot/bin/ndshot`): one
  CEF gate at a time on the whole machine, each with `ND_CEF_CACHE=<fresh dir>`
  and its own `ND_CEF_DEBUG_PORT`; check `pgrep -fl NDShell` first. Two hosts on
  the default cache dir give Chromium's "Restore pages?" and a full Chromium
  window. `scripts/mac/cef-chrome-style.sh` -> `cef chrome style: OK`,
  `cef-reparent.sh` -> `ND_CEF_REPARENT_MAC_OK`, `mac-headerfield.sh`,
  `mac-menu-order.sh`, `mac-m11-body.sh`. `app-chrome-style.sh` cannot pass as a
  whole (two devtools quit legs FAILING by design; legs assuming an app
  "Inspect Element" item are stale). `mac-errors.sh` hangs after its four legs
  on main. The owner uses the mac: a `hostStaysKey` failure means focus was
  taken, rerun.
- Mac legs drive input with `app.cursor` (`@nativedesktop/test`, 0.4.15+: real
  HID mouse, so hover, native menus and drags see a user) and capture with
  `ND_AUTOMATION_CAPTURE=region` or `ndshot capture --region` (0.4.14+:
  composited with sheets, menus, panels). Grant once with `<host> --nd-grant`.
  The cursor moves the owner's mouse: such runs hold the mac CEF lock
  (`scripts/mac/cef-gate-lock.sh`, on `startup-window` until it merges).
  Examples: `scripts/mac/cursor-drive.ts`, `region-capture-drive.ts`.
- The app's mac drive (`scripts/mac-drive.sh`, bundled CEF host) stops at leg 2
  until the AppKit palette gap is fixed.

## Open owner reports

- Compact row at 1266 px crashes the layout (crash agent).
- Ctrl+Shift+S opens Chromium's save dialog (crash agent).
- Compact row: titles bold, padlock beside the field, computed address width;
  all wait on `headerbar-field` and the app adoption.
- 1Password: content scripts inject; popup was disabled at runtime (handled by
  8c6b43c); sign-in tab arrives since 0.4.10. `chrome.action.onClicked` and
  `activeTab` need our own CEF build (`GetChromeToolbarType` patch). Badge and
  runtime popup read through 2 px probe views.
- Passkey sheet at the top right on Hyprland: the owner's window rule for
  empty class + title (`~/.config/hypr/hyprland.lua:507`); transient-for hints
  shipped; the durable fix is narrowing that rule.
- DevTools strip and the phone icon: fixed on `dock-gap-app`, pending merge.
- Ctrl+L dimmed the UI: fixed (0.4.12 dialogs over a page); Ctrl+L now focuses
  the address field in the app.
- Screenshot picker saw the webview as a window: fixed (0.4.12).
- "Bunch of nd-hello windows": Chromium file dialogs from Ctrl+Shift+S plus any
  stray Chromium toplevel, both named after the app since 0.4.12 (startup-window
  and crash agents).
- Extension registry commands do not exist on AppKit (about 750 lines of Swift,
  two to three days); the extensions toolbar is empty on macOS.
- Stock CEF ships without H.264/AAC and Widevine (unverified).

## Hosts

- g815: NixOS, Hyprland, fish login shell (`ssh g815 bash -s <<'EOF' ... EOF`),
  CEF dist `~/.cache/nativedesktop/cef/151.3.23-linux64`, prebuilt npm host does
  not run there (build from source). Display :0 and `~/.local/share/nativebrowser`
  are the owner's. Per-agent dirs `~/Developer/nd-*`; my own are `nd-orch-*`.
- e1504g: owner's desktop, unused this round.
- rsync excludes: `.git node_modules packages/*/dist zig-out .zig-cache` (and
  `dist screenshots` for the app); `--delete` wipes `packages/react/dist` on the
  remote otherwise.
