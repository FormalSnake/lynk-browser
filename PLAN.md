# NativeBrowser — plan of record

Goal: an Arc/Edge-style sidebar browser (vertical tabs, native chrome only) built
on NativeDesktop's `<webview>` (WebKitGTK on Linux, WKWebView on macOS), with a
working Chrome-extension flow (Dark Reader end-to-end as acceptance), plus
framework and automation-suite expansion in NativeDesktop itself. Linux (g815)
is the primary runtime target; macOS arms stay real and at minimum
compile-verified, AppKit-runtime-verified where cheap.

## Machines and repos

| What | Mac | g815 (NixOS, ssh alias `g815`) |
| --- | --- | --- |
| Framework work | `~/Developer/nd-browser-wave` (git worktree of `~/Developer/NativeDesktop`, branch `browser-wave`) | `~/Developer/nd-browser-wave` (clone, branch `browser-wave`) |
| Browser app | `~/Developer/nativebrowser` | `~/Developer/nativebrowser` (clone) |
| Sync | push to `~/nd.git` and `~/nativebrowser.git` (bare, on the Mac) | `git pull mac <branch>`; `rsync` for uncommitted iteration |

App deps are sibling-relative (`file:../nd-browser-wave/packages/<name>`), so
the same package.json resolves on both machines.

Never touch `~/Developer/NativeDesktop` working trees on either machine beyond
read-only git commands: the Mac tree has another session's dirty docs files, the
g815 tree has 56 files of foreign uncommitted work. All edits happen in the
`nd-browser-wave` worktree/clone and in the app repo.

Linux gates run inside the flake dev shell: `ssh g815 "cd ~/Developer/nd-browser-wave && nix develop -c <cmd>"`.
Headless runs use the repo's weston pattern (`scripts/headless-*.sh`).

## Hard rules (from NativeDesktop conventions)

1. Vtable is append-only; bump the `@sizeOf(NdBackend)` assert, run
   `scripts/sync-native-headers.sh` after header changes.
2. `schema/*.json` → `tools/codegen.ts` is the single source of truth; never
   hand-edit generated files. Exactly ONE agent owns schema+codegen at a time.
3. Webview events need `SIGNALS`/`SWIFT_SIGNALS` entries in codegen; commands
   are schema-only and dispatch into `src/gtk/webview.zig` / `NDShell/NDWebView.swift`.
4. Fix UI at the framework level, not with per-app pixel tuning.
5. Commit style: conventional (`feat(scope): …`), no attribution trailers, never
   commit CLAUDE*.md / SESSION-LEDGER.md. Commit at stage boundaries.
6. Swift builds on the Mac need `env -u SDKROOT -u DEVELOPER_DIR`.

## Stage 0 — Infrastructure (serial, first)

Isolated worktrees + clones per the table above; `bun install` both sides;
`nix develop -c zig build` green on g815; baseline drive green on g815
(`scripts/tabs-drive.ts` browser leg / headless smoke) proving webview+tabs work
at HEAD on Linux. Scaffold the app into `~/Developer/nativebrowser` with
`scripts/new-app.sh`, deps as `file:../nd-browser-wave/packages/*`
(same relative path on both machines), app boots headless on g815 with the
automation socket answering. Acceptance marker: `NB_STAGE0_OK`.

## Stage 1 — Browser MVP (app repo only; parallel with Stage 2)

Single `<window>`: splitview sidebar (Arc-style vertical tab list: favicon slot,
title, close on hover, New Tab row, drag-reorder later) + content pane
(headerbar: back/forward/reload-stop, omnibox `searchinput`, progress; webview
area). Per-tab live webviews that survive tab switches (portal pool + `moveNode`
or visibility toggling — pick what the framework supports cleanly). New-tab
page, load-error page, `onNewWindow` → background tab, downloads via
`downloadRequested` → Bun fetch to `~/Downloads` with a simple downloads list,
menubar accelerators (primary+t/w/l/r, primary+shift+t reopen), zoom, session
persistence + restore via `createStore`, history into `@nativedesktop/data`
SQLite. Acceptance: `app/scripts/browser-drive.ts` green headless on g815
(`NB_MVP_OK`) + screenshots.

## Stage 2 — Framework: webview browser/extension seam (ND repo, codegen owner)

In priority order (extension-critical first):

1. User scripts: `addUserScript`/`removeUserScripts` commands (source, injection
   time document_start/end, main vs isolated world by name, URL match lists) —
   `WebKitUserContentManager` / `WKUserScript`.
2. Script message handlers: register per-world handler names; `onScriptMessage`
   event carrying `{name, body, world, frameUrl}`; reply support where the API
   allows (`webkit_web_view_...script_message_with_reply` / WKScriptMessageHandlerWithReply).
3. Custom URI schemes (`registerScheme` at webview/profile creation; request
   event → app answers bytes+mime from Bun) for `crx://`-style resource serving.
4. Cookies: get/set/delete/observe on the view's network session.
5. `faviconChanged` event (favicon database / WKWebView JS fallback).
6. Find-in-page: `findStart/findNext/findPrevious/findStop` + `onFindResult`.
7. TLS/security state: `onSecurityChanged` (secure, insecure-content, failed).
8. Context menu: `onContextMenu` event with hit-test data (link/image/selection),
   suppress-native flag so the app can show a native menu.
9. Per-view profiles: `profile` create-only prop (named persistent / ephemeral
   private) mapping to WebKitNetworkSession / WKWebsiteDataStore.
10. Session state save/restore (`webkit_web_view_get_session_state`) for
    tab restore with history.
11. Audio state `onAudioStateChanged` (is-playing/muted) + `setMuted`.
12. Permission requests (`onPermissionRequest` + `respondPermission`).
13. Hover link `onLinkHover` (mouse-target-changed).

GTK runtime-verified on g815 (`scripts/webview-drive.ts`, new), AppKit arms real
and compile-verified, runtime-verified locally where cheap. Docs:
`docs/webview.md` + docs-site webview page. Acceptance: `ND_WEBVIEW2_OK` both
gates.

## Stage 3 — Chrome extension runtime (app repo; after Stage 2)

All privileged logic lives in the Bun process ("the broker"). Nothing leans on
engine extension support (WebKitGTK has none for Chrome extensions).

- Loader: manifest v2+v3 parse/validate, real match-pattern engine
  (scheme/host/path per Chrome spec), CRX3 unpack (zip via `fflate`) + unpacked
  dirs; extension registry persisted in SQLite.
- Resources: `chrome-extension://<id>/` served over the Stage-2 custom scheme.
- Content scripts: compiled to user scripts per extension (isolated world per
  extension, js+css, document_start/end/idle, all_frames, match/exclude), with
  `chrome.*` content-script shim injected into that world.
- Messaging: full Port abstraction (runtime.connect/onConnect/sendMessage/
  onMessage, tabs.sendMessage/connect) routed content-script ⇄ broker ⇄
  background ⇄ popup over script-message-handlers + per-world JS dispatch.
- APIs in the broker: storage.local/sync/session (+onChanged, SQLite-backed),
  alarms, tabs (query/get/update/reload/onUpdated/onActivated/onRemoved with
  diffed changeInfo), runtime (id/getManifest/getURL/onInstalled/...), i18n
  (message catalogs + locale fallback), action/browserAction (native toolbar
  button per extension: icon, badge, popup), contextMenus (native menu items on
  the Stage-2 context-menu event), webNavigation basics, notifications (native),
  commands (menubar accelerators), theme (no-op shim that Dark Reader tolerates).
- Backgrounds: MV2 background page and MV3 service-worker script both hosted in
  hidden offscreen webviews at the extension origin (SW script wrapped; wake
  semantics simplified: always-on while extension enabled).
- Popup: native window anchored to the action button, webview inside, sized by
  ResizeObserver → script message (clamp 25..800x600, close on blur).
- Install flow UI: Extensions manager page (native), "Install from folder /
  .crx / Chrome Web Store URL" (CWS CRX download endpoint), permission-prompt
  dialog listing manifest permissions before enable (per the reference
  screenshot), enable/disable/uninstall, load-unpacked for dev.

Acceptance (owner-corrected priority: the Web Store is MV3-only now, MV2
survives mainly for uBlock Origin): Dark Reader MV3 (real build) installed
through the flow, darkens fixture pages headless on g815, popup opens and
toggles work, settings persist across restart — `NB_DARKREADER_MV3_OK` with
screenshot + DOM assertion is the headline gate. MV2 (`NB_DARKREADER_OK`)
stays as a secondary gate for legacy/unpacked support. Stretch: uBlock Origin
Lite via content scripts (no DNR claim).

## Stage 4 — Automation suite expansion (ND repo; after Stage 2 codegen frees)

- GTK webview content in screenshots (the known snapshot gap): compositor-side
  capture fallback (weston screencopy/grim rung) wired into the harness.
- Page-level waitFor vocabulary: `urlContains`, `pageTitleContains`,
  `pageTextContains` (host polls via the webview's executeJavaScript path).
- Automation RPC: `webview` namespace — getUrl/getTitle/eval on a webview node
  by testId (so drives don't need app cooperation).
- `@nativedesktop/test`: browser helpers (openAndAwaitLoad, evalInPage,
  screenshotPage); MCP bridge exposes the new vocabulary.
- Fix backlog item blocking browser drives: sourcetree/sourcelist row actions
  not clickable via automation (tab close buttons need it).
- `scripts/browser-gate.sh` on g815 aggregating: zig tests, webview drive,
  browser MVP drive, extensions drive. Acceptance: `ND_AUTO2_OK`.

## Stage 5 — Polish, hardening, ship

Owner requirement: everything must match the LATEST platform guidelines —
macOS 26/27 HIG (Liquid Glass era) and current GNOME HIG (49/50). Both moved
after model knowledge cutoffs: agents web-search current guidance before
judging or fixing, and reuse the repo's prior HIG research
(docs/superpowers/plans + the hig-gtk/hig-macos design docs) as the baseline.

GNOME HIG pass on the app (spacing scale, dark mode, empty states), context
menus (page/link/image), find-in-page bar, downloads UI polish, settings page
(search engine, homepage, restore behavior), private window (ephemeral profile),
reopen-closed-tab, favicon cache, TLS padlock + insecure warning, app icon +
`nd package linux` artifact. Full gate sweep: g815 browser-gate + ND linux gate,
Mac AppKit compile + smoke. Docs: ND webview/automation docs updated, app
README, extension-support doc. Final commits; merge `browser-wave` → ND main;
push ND (nd.git + GitHub) and app repo; final report with screenshots.

## Coordination

Every new screenshot batch spawns a feedback agent (owner requirement): it
visually reviews each shot against GNOME HIG (GTK) / macOS HIG (AppKit) and the
Arc-style reference, separates capture artifacts (known: weston bitmap fonts
until fixed, AppKit RPC missing the toolbar layer) from real UI defects, files
findings in LEDGER.md, and the orchestrator routes them to the owning stage.

- One codegen/schema owner at any moment (Stages 2 then 4 serialize on it).
- Stage agents append progress markers to this repo's `LEDGER.md` (gitignored)
  so parallel agents and the orchestrator share state.
- Every stage ends with: gates green on g815, changes committed on the stage's
  repo/branch, ledger updated.
