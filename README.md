# NativeBrowser

A sidebar browser built on [NativeDesktop](https://github.com/FormalSnake/NativeDesktop). Vertical
tabs, native chrome, one live `<webview>` per tab: WebKitGTK on Linux, WKWebView on macOS. There is
no HTML in the interface. Every button, row and dialog is a real GTK4 or AppKit widget.

It also runs Chrome extensions. WebKit has no support for them, so the work happens in the Bun
process: a broker implements the `chrome.*` surface itself and injects content scripts as WebKit
user scripts. Dark Reader MV3 installs from a folder, darkens pages, and its settings survive a
restart.

## Run it

```bash
bun install
bun run dev
```

`bun run dev` is `nd dev`, which resolves the host binary for your platform and starts the app with
hot reload. Force a backend with `nd dev --backend gtk` or `--backend appkit`.

Extensions need fixtures, which are not in the repo:

```bash
bun scripts/fetch-fixtures.ts
```

## Test it

Every acceptance test is a drive: a script that launches the real app, talks to it over the
automation socket, and asserts on the real widget tree.

| Command | Marker | What it covers |
|---|---|---|
| `scripts/headless-smoke.sh` | `NB_STAGE0_OK` | The app boots and answers automation |
| `scripts/headless.sh bun scripts/browser-drive.ts` | `NB_MVP_OK` | Tabs, palette, downloads, session restore, padlock, find, context menu, private window, settings |
| `scripts/headless-extensions.sh` | `NB_DARKREADER_MV3_OK` | Install flow, content scripts, messaging, popup, restart, disable |
| `NB_EXT_FIXTURE=mv2 scripts/headless-extensions.sh` | `NB_DARKREADER_OK` | The same legs against an MV2 build |

`scripts/headless.sh` wraps a command in a headless weston compositor and pins the GTK theme, icon
theme and fonts. Without that, a screenshot taken from a drive shows the developer's own desktop
theme instead of stock Adwaita, and three colour findings in this project's review history turned
out to be exactly that mistake. On macOS the drives run headful against the AppKit host, with
`ND_BACKEND=appkit`.

`ND_DRIVE_TIMEOUT_MS` scales every wait at once. Raise it when the machine is loaded.

## What works

Sidebar tabs carry the site's own favicon and a close button, and each one owns a live webview that
survives switching away and back. The address bar is a command palette: it ranks the address you
typed first, then open tabs, then history, then app commands.

Beyond that: downloads, session restore, per-host zoom, find in page with a match count, a native
page context menu, a TLS padlock, a private window on an ephemeral profile, and a settings window
whose search engine, homepage and restore-on-launch all take effect.

## Extension support

| Area | State |
|---|---|
| MV3 (service worker, `action`, `scripting`) | Works. Dark Reader MV3 is the acceptance gate |
| MV2 (background page, `browserAction`, `tabs.executeScript`) | Works, except Dark Reader's per-site `addSite` command |
| Install from an unpacked folder | Works, with a permission prompt before anything runs |
| Install from a `.crx` or `.zip` | Works, CRX2 and CRX3 |
| Install from a Chrome Web Store address | Works, through the store's own CRX endpoint |
| `runtime`, `storage`, `tabs`, `scripting`, `i18n`, `alarms`, `commands`, `contextMenus`, `notifications`, `webNavigation`, `windows`, `permissions` | Implemented |
| `declarativeNetRequest` | Absent on purpose, so feature detection fails correctly |
| `content_security_policy` on extension pages | Not enforced. The `chrome.*` shim arrives as an injected user script and WebKitGTK applies the page's CSP to it, so serving the manifest policy switches the runtime off on the pages the policy governs |
| `web_accessible_resources` | Parsed and used for CORS headers, not enforced as an access boundary |

Extension pages, popups and background pages are all served over a `chrome-extension://` scheme
registered with the engine, CORS-enabled and marked as a secure context on GTK. WebKit's Cocoa API
exposes neither flag, so on macOS cross-origin reads work through response headers and a secure
context is not available at all.

## Package it

```bash
bunx nd package mac     # dist/mac/NativeBrowser.app, ad-hoc signed
bunx nd package linux   # dist/linux/AppDir plus an AppImage
```

The app icon is `assets/compass.svg`, declared as a layered icon in
`nativedesktop.config.ts`. macOS gets an Icon Composer bundle compiled to `Assets.car` and `.icns`;
Linux gets the same art flattened into the hicolor theme. On a box without appimagetool the packager
falls back to a bare squashfs image, which cannot be executed directly. Run `dist/linux/AppDir/AppRun`
to test the payload there.

## Layout

| Path | What lives there |
|---|---|
| `src/App.tsx` | The browser window: sidebar, header bar, tabs, palette, find bar, context menu |
| `src/PrivateWindow.tsx` | The private window and its ephemeral profile |
| `src/extensions/` | The broker. `host.ts` is the API dispatch, `bootstrap.ts` is the injected `chrome.*` shim |
| `src/lib/` | Session, history, downloads, favicons, settings, URL parsing |
| `scripts/` | The drives and their headless wrappers |
| `screenshots/` | Drive output. `screenshots/final/` is the reviewed set |

## Known gaps

- The page context menu is a popover anchored to the content pane, not to the click point. Neither
  backend exposes a point-anchored popup menu.
- The find bar has no Escape binding, because the framework surfaces no key events to the app.
- The action popup is a top-level window rather than a panel under its toolbar button, and it is
  sized when it opens rather than following its content.
- MV2's restore leg is red at the current framework revision. MV3, the headline gate, is green.
