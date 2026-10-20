# NativeDesktop port: plan

Milestone M15 of the NativeDesktop Rust rewrite: Lynk moves from the Zig NativeDesktop 0.5.11
(a Zig host with a Bun child running Solid, CEF 151 in Chrome style) to the Rust `nd` crate.
The port lives on branch `nd-port`. It becomes `main` only when every box in
[nd-parity.md](nd-parity.md) is ticked: then `nd-port` merges into `main`, and the nix config
switches to the nd build, rebuilt and checked on every host (NativeDesktop `docs/plan/PROMPT.md`,
decision of 2026-10-14). Until then the 0.5.11 build stays the one people run.

## Where things are

- nd: path dependencies on `../nativedesktop-wt-browser` (nd's `browser` branch, which is nd
  `main` plus whatever this port needs). nd's patched GPUI reaches this workspace only through
  the `[patch.crates-io]` table in the root `Cargo.toml`. When `browser` merges, the paths move to
  a git dependency on one nd revision.
- Rust code: `crates/`. The TypeScript app in `src/` stays untouched until the switch, so the
  shipping build keeps working from the same tree.
- Build on the macbook: `CEF_PATH="/Volumes/Kyan Drive/dev-cache.noindex/cef" cargo build -p lynk`
  outside a Nix shell's SDK (`env -u SDKROOT -u DEVELOPER_DIR` when one is set). Intermediates go
  to the external drive through `.cargo/config.toml`. A dev run is its own Chromium helper, and
  the framework comes from the distribution `cef-dll-sys` unpacked.

## Architecture

Two crates, the shape the messages port settled on:

- `crates/core` (`lynk-core`, not yet created): everything in `src/lib/` that does not draw. No
  nd dependency apart from `nd-data` and `nd-settings`, unit tested with plain `cargo test`.
  The ported TypeScript tests (`*.test.ts`) become its first tests.
- `crates/lynk` (binary `lynk`): the nd UI, one module per Solid component, plus the glue that
  turns `nd::webview` events into core calls.

There is no Bun process and no IPC any more. What the old app split between the Zig host
(Chromium, adblock through adblock-rust, menus) and the Bun child (state, UI) is one Rust process
on nd's main loop.

### Module mapping

| Old (`src/`) | New | nd it rests on |
| --- | --- | --- |
| `main.tsx`, `App.tsx` (app root, windows, menus, settings window, session) | `lynk/src/main.rs`, `app.rs` (window registry, menu bar, global actions), `settings_window.rs` | `Application`, `WindowOptions`, `nd-components::menu`, `settings_form::<T>()` (`settings-ui`) |
| `BrowserWindow.tsx` (shell, layouts, split, panels, find bar, site panel) | `window.rs` (state per window), `shell.rs` (sidebar and compact layouts), `split.rs`, `find.rs`, `site_panel.rs` | `scaffold`, `split`, `popover`, `nd::webview` |
| `Sidebar.tsx` | `sidebar.rs` (controls row, pinned tiles, tab rows, foot) | `source_list`, `drag_region`, titlebar insets; the pinned tile grid is lane `nd-tab-drag` |
| `CompactTabs.tsx` | `compact.rs` | `tabs`, `toolbar` |
| omnibox (`lib/omnibox.ts` and its panel) | `core::omnibox` (ranking, completion) and `lynk/src/omnibox.rs` (panel) | `command_palette` |
| `Panels.tsx` (history, bookmarks) | `panels.rs` | `nd::list` (virtual list), sheets |
| `Downloads.tsx`, `lib/downloads.ts` | `downloads.rs`, `core::downloads` | `on_download_requested`, `on_download_updated`, `Download` controls, file drag out |
| `ZoomControl.tsx`, `lib/zoom.ts` | `zoom.rs`, `core::zoom` (per-host levels) | `set_zoom`, `on_zoom_changed` |
| `PopupBlocked.tsx` | `popup_blocked.rs` | `on_popup_blocked`, `allow_popups` |
| `PrivateWindow.tsx` | the same window code with `Profile::Private` shared by the window | `Profile::Private` (one context per window, see lane `webview-private-window`) |
| `PopupWindow.tsx` | `popup_window.rs` | `NewWindow::popup`, `WindowFeatures` |
| `lib/session.ts` | `core::session` | `save_session`, `restore_session`, `nd-settings` paths |
| `lib/tabstate.ts` (padlock verdict, per-tab facts) | `core::tabstate` | `on_security_changed`, `on_audio_state_changed` |
| `lib/settings.ts` | `core::settings` (`#[derive(Settings)]`) | `nd_settings::Store<T>`, generated home-manager options |
| `lib/history.ts`, `lib/bookmarks.ts` | `core::history` (SQLite), `core::bookmarks` | `nd-data` |
| `lib/favicons.ts` | `core::favicons` | `on_favicon_changed`, nd image pipeline |
| `lib/permissions.ts` | `core::permissions` (held until the tab is looked at) | `on_permission_request`, `PermissionResponder` |
| `lib/adblock.ts`, `lib/ublock.ts` | `core::adblock` on the `adblock` crate directly | lane `cef-request-filter`, user scripts for cosmetic filters and scriptlets |
| `lib/hider.ts` (Shift+Cmd+H element picker) | `hider.rs` | user script in an isolated world, `register_script_message` |
| `lib/reader.ts` | `reader.rs` (Readability bundle as an asset, run with `execute_javascript`) | `execute_javascript`, user scripts |
| `lib/float.ts` | `float.rs` | lane `cef-user-gesture-js` |
| `lib/extensions.ts`, `lib/webstore.ts` | `extensions.rs` | lanes `cef-chrome-style`, `cef-extensions` |
| `lib/pages.ts` | `core::pages` (which `chrome://` pages the app replaces) | `on_navigate`, `on_new_window` |
| `lib/live.ts` (keyed diff of persisted stores into Solid state) | dropped; nd re-renders from plain Rust state | `cx.notify` |
| `lib/keys.ts` | `actions.rs` (`actions!`, `KeyBinding`) | `cx.bind_keys`, menu shortcuts |
| `lib/url.ts` | `core::url` | `resolve_address` |
| `lib/tabdrag.ts` | `tab_drag.rs` | lane `nd-drag-between-windows` |
| `lib/metrics.ts` | dropped; nd's diagnostics and frame HUD cover it | `nd-diag` |

## Engine: why Chrome style comes first

The old app runs CEF in Chrome style (`webview.cef.style = "chrome"` in
`nativedesktop.config.ts`). Chrome style is what gives it Chromium's own extension runtime, the
Web Store install flow, extension action popups, `chrome://settings` and `chrome://extensions`,
Chromium's picture-in-picture window, and 1Password's browser integration.

nd's CEF engine is off-screen only: every browser is created windowless in Alloy style
(`nd-cef/src/mac/view.rs`, `linux/view.rs`), and `[webview.cef] style = "chrome"` is accepted by
the config but read by nothing. Alloy style has no extension UI, and Chrome style cannot render
off-screen. So the browser needs nd to grow a windowed Chrome-style page, and the parity gate
(extensions and 1Password on Hyprland) depends on it.

Per the 2026-10-13 decision, on Hyprland CEF stays Wayland-native off-screen by default and
falls back to XWayland only where Wayland would lose functionality. Lynk is that case: its pages
run in Chrome style under XWayland, with Hyprland's `xwayland:force_zero_scaling` so they are
sharp. On macOS Chrome style is a child `NSView` in the window's AppKit tree, the same position
a WKWebView has, so nd's overlay rules (panels and menus above the page, input never leaking
through) already apply.

## nd lanes this port needs first

Each lane is a branch in the nd repo, merged by the orchestrator. In order of what blocks most.

1. **`cef-chrome-style`**: `[webview.cef] style = "chrome"` creates windowed Chrome-style
   browsers. macOS: the browser's `NSView` in the AppKit tree, resized with the window, focus and
   first responder handled, Chromium's own context menus and `<select>` popups. Linux: the
   window runs on XWayland and the browser is a child X11 window, with the window's input and
   resize. Chrome's own browser UI stays hidden (no toolbar, download bubble or download
   arrow), and the Chrome commands a page's focus swallows (`IDC_SHOW_DOWNLOADS`, history,
   bookmarks, tab search) reach the app as an event instead. Done when: on the macbook and in headless Hyprland on g815, `chrome://extensions` and
   `chrome://settings` render in a page, the overlay leak and live-resize gates from
   `real_webview` pass with Chrome style, and every `nd::webview` event and command in the
   browser example's parity scene passes on both styles.
2. **`cef-extensions`**: the extension surface Chrome style leaves to the embedder: list
   installed extensions with name, icon and badge; an extension's action, opening its popup
   anchored to a rect the app gives; pin and unpin; install from the Web Store (the store's "Add
   to Chrome" works and the app sees the result); uninstall. Done when: Dark Reader and 1Password
   install from the Web Store on macOS and on Hyprland, their action popups open from the
   sidebar foot, and 1Password fills a login on both (on macOS with the Developer ID signed
   build, since 1Password trusts a browser by its signature).
3. **`cef-request-filter`**: a per-request hook on Chromium's IO thread that answers allow,
   block or redirect synchronously, given the URL, the first-party URL and the resource type,
   plus response header access for CSP-injected scriptlets. Done when: an adblock-rust engine
   built with uBlock Origin's default lists blocks the same requests on the adblock fixture
   page as the 0.5.11 build (`scripts/adblock-drive.ts`), with no main-thread hop per request.
4. **`webview-private-window`**: `Profile::Private` shared by every page of one window, so a
   private window is one in-memory profile and not one per tab. Done when: two tabs in one
   private window share a cookie, a normal window does not see it, and closing the window
   clears it.
5. **`cef-user-gesture-js`**: `execute_javascript` with a user gesture, which
   `requestPictureInPicture` and fullscreen need. Done when: the floating video chord lifts a
   playing video into Chromium's picture-in-picture window and back on both OSes.
6. **`nd-tab-drag`**: drag reorder in `source_list` with a slot line, drag between sections
   (pinned and tabs), a reorderable tile grid with the 0.2 s slide, and a drag that carries a
   live page to another window or out to a new one. Done when: the tab drag drive's cases
   (`scripts/mac-tabdrag.ts`) pass against the nd build on macOS.
7. **`nd-sidebar-reveal`**: a hidden sidebar that slides in over the content as a floating
   panel when the pointer touches the leading edge, with the traffic lights riding on it, and an
   app-settable traffic light position. Done when: the sidebar motion drive's frame trace holds
   the close button to the tiles' edge on every frame of both slides.
8. **`webview-print`**: print and save as PDF for a page. Done when: Cmd+P opens the system
   print dialog for the page on macOS and the portal dialog on Linux.

Not needed for parity, so not a lane yet: Lynk as the default browser (the 0.5.11 app registers
no URL schemes either). Windows is out of scope for M15: nd's CEF engine does not run there yet, and the old app never
shipped on Windows.

## Order of work

1. Skeleton (done on this branch): a workspace on nd's `browser` branch, a window with a sidebar
   and one CEF page.
2. `crates/core`: port `src/lib/` with its tests. No nd lanes needed, so it runs beside lanes
   1 to 3.
3. Shell on off-screen CEF: sidebar layout, tabs, omnibox, find, zoom, downloads, history and
   bookmarks panels, session restore, settings window, menus and shortcuts. Everything here is
   in today's `nd::webview`.
4. Switch the engine to Chrome style once `cef-chrome-style` lands, then extensions, 1Password
   and the Web Store on `cef-extensions`.
5. Adblock on `cef-request-filter`, reader mode, floating video, private windows, compact
   layout, tab drag, sidebar reveal.
6. Linux on g815 (headless Hyprland through `scripts/linux-gate`, then e1504g for the real
   session), packaging (`nd package mac` signed, AppImage, Nix package), data migration from the
   0.5.11 profile.
7. Tick every box in `nd-parity.md`, merge into `main`, switch the nix config.
