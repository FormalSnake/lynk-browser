# Resume notes (paused 2026-09-17)

Goal: a basic Chromium browser on macOS and Linux with 1:1 Chrome extension
compatibility, native UI, never a stray Chromium window, tested against the real
app. UI/UX polish comes later.

To resume, tell Claude: "read RESUME.md and continue".

## Where things are (updated 2026-09-20)

| Repo / tree | Branch | State |
|---|---|---|
| `~/Developer/nativebrowser` | `main` (3b0c774, not pushed) | On `@nativedesktop/*` 0.4.3 with `webview.cef.style: "chrome"` in the config. |
| `~/Developer/NativeDesktop` | `main` (pushed, v0.4.3 published) | `chrome-accept` and `chrome-style-mac` are both merged. |
| g815 | `~/Developer/nd-main` (framework main build), `~/Developer/nativebrowser-run` | `run-on-desktop.sh` starts the app on the Hyprland session. NixOS cannot run the prebuilt host, so it uses the host built in `nd-main`. |

Linux gates need the flake shell on g815: `nix develop --command bash scripts/...`.
Gate state at merge: Linux engine gate green; Linux real-app gate 3 red on x11
(`<select>` dropdown x2, tab out of the page) and 5 red on XWayland (four
`focusRouting*.toField`, tab out of the page). Mac engine and reparent gates
green; mac real-app gate 36 of 38 (tab into the page, intermittent extension
context-menu item) plus the quit after DevTools.

Findings that replace the notes below:
- The Linux engine gate menu pass was not red after a rebase; item 1 is closed.
- XWayland typing: X hands the key to CEF's child window because the pointer is
  in it and focus sits on its ancestor toplevel; GTK sees zero key events. A
  focus proxy window and the InputOnly cover both fail because XI2 does not
  propagate a key up to the ancestor GDK selected on (`src/cef/engine.zig`).
  The lever left is handing the key back from `on_pre_key_event` into GTK4.
- Mac quit after DevTools: `closeDevTools` parks the inspector's BrowserView in
  `devToolsClosing`, `teardown` invalidates the timer that would retire it, so
  `cef_window_t::close` never completes. Retiring the view lets the close run
  and Chromium then segfaults in window destruction; the CEF-side ordering is
  the open question.
- Mac: a `pointer` RPC click within about a second of a reload never reaches
  the page.

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
