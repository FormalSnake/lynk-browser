# Resume notes (paused 2026-09-17)

Goal: a basic Chromium browser on macOS and Linux with 1:1 Chrome extension
compatibility, native UI, never a stray Chromium window, tested against the real
app. UI/UX polish comes later.

To resume, tell Claude: "read RESUME.md and continue".

## Where things are (updated 2026-09-23)

| Repo / tree | Branch | State |
|---|---|---|
| `~/Developer/nativebrowser` | `main` (8c6b43c, not pushed) | Deps 0.4.13. Compact row is tabs + one address field (2b62f50), chrome:// tabs created at URL, extensions toolbar reads live action state (8c6b43c). |
| `~/Developer/nativebrowser-crash` | `crash-minwidth` | Crash agent: compact row demands 1482 px at 1266 wide; Ctrl+Shift+S collides with Chromium's Save page as. |
| `~/Developer/NativeDesktop` | `main` (v0.4.13 published) | 0.4.9 permission event, 0.4.10 tabs.create URLs + watchExtensions, 0.4.11 readExtensionAction, 0.4.12 dialogs over a page + Chromium windows carry the app class, 0.4.13 GTK sizing batch (released by another session). |
| `nd-dock-gap-app` | `dock-gap-app` | DevTools placeholder fix both platforms, green on dockTiling; REGRESSES `<select>` dropdowns on x11 (main green, branch red). Agent on it. |
| `nd-permission-states` | `permission-states` | Linux engine gate green on my run (dismiss state, resetPermissions, withdrawn event, frame URL, URL.origin form). Mac gates NOT run (my run hung in a cache collision). |
| `nd-focus-return` | `focus-return` | Focus fight fixed (two browsers, 55k on_set_focus), onFocusChanged, webviewEngine.active(); REGRESSES paletteTakesKeys. Agent on it, then the two host wedges and two AppKit gaps. |
| `nd-headerbar-field` | `headerbar-field` | GTK green on my run (title field fills the run, leadingIconName, font reaches labels). AppKit half unfinished (field 61 px short). Agent on it. |
| `nd-min-width`, `nd-startup-window` | | Crash agent (framework half); startup-window agent (Chrome's restore bubble / New Tab window after an unclean exit, gate cache collision). |
| g815 | `nd-main`, `nativebrowser-run` | Live instance NOT running (owner closed it after the compact crash). Relaunch after the crash fix lands. Crash log kept at `~/Developer/nativebrowser-run-crash-0923.log`. |

Rules learned this round:
- Mac CEF gates from two worktrees at once share the default CEF cache: the second host shows Chromium's "Restore pages?" bubble and a full "New Tab - Chromium" window. Always `ND_CEF_CACHE=<fresh temp dir>` per run and check `pgrep -fl NDShell` first. A machine-wide lock is being added.
- g815 with 4+ rigs at once produces false reds (hypr contextMenu, x11 dockTiling). Rerun a red rig ALONE (`ND_ACCEPT_RIGS=<rig>`) and against a main baseline built the same way before believing it.
- A `wip:` commit is how an agent's unverified half survives a cutoff; never merge one.

Owner reports still open:
- Compact row at 1266 px: tab buttons keep the full title as minimum (`ndButtonApplyIconData`, widgets.zig:310) plus app widths from windowWidth; returning to sidebar divides 0/0 in libadwaita (setShowSidebar call sites). Fix in flight.
- Ctrl+Shift+S: app shortcut and Chromium Save page as both fire; each press opened a Chromium file dialog that alt-tab lists as nd-hello. Fix in flight (pre-emption leg, file dialogs routed or transient, app shortcut moved).
- Compact row: titles bold, padlock beside the field, computed address width: all wait on `headerbar-field`.
- 1Password: content scripts inject, popup was disabled at runtime (now handled), sign-in tab now arrives. onClicked/activeTab need our own CEF build. Runtime badge via probe views.
- Passkey sheet at the top right on Hyprland: owner's window rule for empty class+title (`~/.config/hypr/hyprland.lua:507`); transient-for hints shipped in 0.4.9.
- Mac: palette does not present while a search input holds first responder; header-bar SearchInput not automatable. Focus agent.
- Extension registry commands do not exist on AppKit (about 750 lines of Swift).

## What is on NativeDesktop main

- `webview.cef.style: "alloy" | "chrome"` -> env `ND_CEF_STYLE`.
- Linux: Chrome-style browser inside the host's X11 child window. Chromium's own
  extension runtime, `--load-extension`, Chrome Web Store install that survives a
  restart, `listExtensions` / `installExtension` / `uninstallExtension` /
  `setExtensionEnabled` / `listExtensionActions`, docked DevTools, native GTK
  context menu built from Chromium's menu model, ordered shutdown, no stray
  toplevel across 20+ routes. Gate: `scripts/headless-webview-cef-chrome.sh`
  (`ND_CEF_CHROME_OK`, `ND_CEF_CHROME_STORE=1` adds the store legs).
- macOS: true embedding without a CEF fork. A frameless CEF Views window is
  created, its whole content view is lifted into `NDCefWebView`, and the CEF
  window stays as an invisible click-through anchor. Docked DevTools opens and
  closes, a live webview survives `moveNode` between windows, crash fixes for
  hover trackers, tab close and quit. Gates: `scripts/mac/cef-chrome-style.sh`
  (`ND_CEF_CHROME_OK`), `scripts/mac/cef-reparent.sh`,
  `scripts/mac/app-chrome-style.sh` (real app, 22 of 34 legs). Every mac gate
  fails if a new `NDShell*.ips` crash report appears.

## Open work, in priority order

Linux (`chrome-accept`):
1. Engine gate menu pass is red on this branch (menus come up empty). The focus
   work is the suspect. Must be green before merging.
2. XWayland (the owner's Hyprland desktop): typing in the address bar with the
   pointer over the page goes to the page. Fixed on plain X11. The InputOnly
   cover window idea was tried and dropped (28fb2cc: "the cover does not deliver
   keys to GTK in-process"); the branch now re-asserts routing on a tick. Needs a
   real answer and an honest XWayland leg.
3. Real-app gate `scripts/headless-app-chrome.sh` (Xvfb+openbox rig, headless
   sway+XWayland rig): last orchestrator run had 14 and 18 red legs, several
   from the drive drifting onto the wrong CDP target. Pin sessions to a target
   id from the host.
4. Tab out of the page (`on_take_focus`), host death on the second context menu
   after `moveNode` (`src/cef/gtkmenu.zig`), tooltip leg, `<select>` on Xvfb.
5. Then: demo on e1504g (`~/Developer/nd-demo-run.sh` there; rebuild
   `~/Developer/nd-demo` from main first). The first demo broke on resize; that
   bug is fixed only on `chrome-accept`.

macOS (`chrome-style-mac`):
1. Verify and merge 26311f3 (copy/paste/select-all/undo in pages) and d0749e4
   (NSMenu context menu with extension items and Inspect Element).
2. Real-app legs: cmd+T leaves the address bar on the previous tab, switch to a
   tab resized while hidden, close tab, close window with tabs.
3. Quit after DevTools was docked once still crashes
   (`NDShell-2026-09-17-173400.ips`, `makeKeyAndOrderFront` -> Chromium
   observer). Gates end that run with SIGKILL so no crash dialog appears.
4. Tab into the page, find bar, download, HTML5 fullscreen, `SearchInput` in a
   `HeaderBar` invisible to automation, cmd+Q via System Events.

Both platforms:
- Extension toolbar actions are not 1:1: no `chrome.action.onClicked`, no
  `activeTab` grant, no badge, popup does not self-size or close on blur. The
  fix is a ~60 line CEF patch in `libcef/browser/chrome/views/chrome_child_window.cc`
  (`GetChromeToolbarType` from `CefWindowInfo`), which means our own CEF build.
  Chrome's install/remove dialogs also stay Chromium-drawn without it.
- Stock CEF binaries ship without H.264/AAC and Widevine (unverified here;
  check with a real playback test). Fixing it also needs a custom CEF build.
- Drag a tab between windows in the app UI (framework mechanism is
  `createPortal` + `moveNode`; works on macOS, works on GTK only on
  `chrome-accept`). App needs multi-window and the drag gesture.
- Native password manager later: no fork needed (prefs to disable Chrome's,
  CDP-injected form detection, native popover).

## Hosts and rules that cost time

- g815: test host, was OFFLINE at pause. Copies at `~/Developer/nd-chrome-*`,
  CEF dist at `~/.cache/nativedesktop/cef/151.3.23-linux64`.
- e1504g: owner's Hyprland desktop. Headless rigs only, under `nice`. Never
  capture its screen. CEF dist and `~/Developer/nd-demo` (framework main build)
  are there. No test processes were left running on it.
- Remote login shells are fish: `ssh host bash -s <<'EOF' ... EOF`.
- `rsync --delete` wipes `packages/react/dist` on the remote; exclude
  `packages/*/dist` or run `cd packages/react && bun run build`.
- Agents: opus for engine work, one worktree each, merge by rebase onto main then
  fast-forward and push. Before any merge the orchestrator reruns the gates
  itself; agent reports were wrong or stale three times.
- Two agents both created `scripts/cef-chrome-drive.ts`; the mac one now lives
  at `scripts/mac/cef-chrome-drive.ts`.
