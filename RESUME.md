# Resume notes (paused 2026-09-17)

Goal: a basic Chromium browser on macOS and Linux with 1:1 Chrome extension
compatibility, native UI, never a stray Chromium window, tested against the real
app. UI/UX polish comes later.

To resume, tell Claude: "read RESUME.md and continue".

## Where things are (updated 2026-09-21)

| Repo / tree | Branch | State |
|---|---|---|
| `~/Developer/nativebrowser` | `main` (not pushed) | On `@nativedesktop/*` 0.4.8, `webview.cef.style: "chrome"` in the config. Extensions toolbar, floating find bar, Safari-style compact row, empty Ctrl+T launcher. |
| `~/Developer/NativeDesktop` | `main` (pushed, v0.4.8 published) | 0.4.3 to 0.4.8 shipped: chrome-accept, chrome-style-mac, flat row actions, portal button layout on x11, DevTools close button, held right click context menu, menu child moves, dock tiling. |
| `~/Developer/nd-ext-actions` | `ext-actions`, NOT merged | Three `wip:` commits never run (g815 was off): real URL for `chrome.tabs.create` tabs (the owner's about:blank tabs and the unreachable 1Password sign-in), `watchExtensions` event, `installExtension` 90 s timeout. |
| `~/Developer/nd-chrome-dialogs` | `chrome-dialogs`, NOT merged | `permissionRequest` event and `respondPermission` (run on both platforms). On mac the host adopts Chromium's own windows (passkey, HTTP auth, save password) as children of the app window over the webview; both mac gates green on the orchestrator's rerun. Four `wip:` Linux commits never compiled, including 0d77455 (mark the dialog transient for the host window, the candidate fix for the sheet landing at the top right on Hyprland, which discards the watcher's `XMoveResizeWindow`). |
| `~/Developer/nd-dock-gap` | `dock-gap` | Merged except the top `wip:` commit (Linux twin of the Inspect pick leg, never run). |
| g815 | `~/Developer/nd-main`, `~/Developer/nativebrowser-run` | `run-on-desktop.sh` starts the app on the Hyprland session with the host built in `nd-main` (NixOS cannot run the prebuilt host). Rebuild `nd-main` from main before a relaunch. |

Rules learned this round:
- Every confirmed framework fix ships to npm the same day (see CLAUDE.md). Release = bump the 12 `packages/*/package.json`, `bun install`, `bun scripts/release/check-versions.ts <v>`, commit `release: v<v>`, tag, push; CI publishes. The registry lags a few minutes per package, so retry `bun install` in the app until `@nativedesktop/host` resolves before committing the bump.
- Linux gates on g815 need `nix develop --command bash scripts/...`, and a display, CDP port and app id of their own when agents run side by side (`ND_CEF_DISPLAY`, `ND_CDP_PORT`, `ND_APP_ID`).
- Mac gates serialize on one lock. Kill hosts by worktree path, never `pkill -f NDShellDev`.
- A branch with Linux code that was never compiled does not merge: the release CI builds the Linux host.

To run on g815 when it is back:
- `ext-actions`: `cd ~/Developer/nd-ext-actions && ND_CEF_DISPLAY=:71 ND_CDP_PORT=9371 ND_APP_ID=dev.nativedesktop.extActions nix develop --command bash scripts/headless-webview-cef-chrome.sh` (new legs `tabsCreateReportsUrl`, `extensionTabReportsUrl`, `openerNavigatesBlankReportsUrl`, `extensionsChanged`, `installExtensionError`).
- `chrome-dialogs`: same gate with `ND_CEF_DISPLAY=:98 ND_CDP_PORT=9344 ND_APP_ID=dev.nativedesktop.chromeDialogs`, expect `ND_CEF_CHROME_LEGS_OK(dialogs)`.
- `dock-gap`: same gate with `:91` / `9391`, for the Inspect pick leg; then check the owner's DevTools gap on the real XWayland session, which no rig reproduced.

Owner reports still open:
- 1Password: content scripts inject but it draws no field icon until signed in; sign-in was unreachable because its welcome tab arrived as about:blank (fix is the `wip:` above). Its popup hangs on the splash because our popup view is an ordinary tab to Chromium, not `kExtensionPopup` (docs/webview.md). Runtime `setPopup` / badge state needs a hidden extension-page view as transport. `onClicked` and `activeTab` need our own CEF build.
- Passkey sheet at the top right of the screen on Hyprland: not reproduced on any rig; cause by reading is `onChromeWindowWatch` (NativeDesktop `src/cef/engine.zig:390`) moving a managed XWayland toplevel, which Hyprland ignores. Fallback if transient-for is not enough: `XReparentWindow` into the host's X window.
- DevTools gap on Linux: not reproduced on Xvfb; the tiling leg is the instrument.
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
