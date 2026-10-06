# Lynk Browser

A sidebar browser built on [NativeDesktop](https://github.com/FormalSnake/NativeDesktop). Vertical
tabs, native chrome, one live `<webview>` per tab, Chromium on both platforms. There is no HTML in
the interface: every button, row and dialog is a real GTK4 or AppKit widget.

Chrome extensions run through Chromium's own extension runtime rather than an app-level
implementation. The Extensions menu and command palette open `chrome://extensions` and the Chrome
Web Store as ordinary tabs; the app does not otherwise know an extension exists.

## Run it

```bash
bun install
bun run dev
```

`bun run dev` is `scripts/dev.sh`, a thin wrapper around `nd dev`, which resolves the host binary for
your platform and starts the app with hot reload. Force a backend with `nd dev --backend gtk` or
`--backend appkit`.

## Test it

Every acceptance test is a drive: a script that launches the real app, talks to it over the
automation socket, and asserts on the real widget tree.

| Command | Marker | What it covers |
|---|---|---|
| `scripts/headless-smoke.sh` | `NB_STAGE0_OK` | The app boots and answers automation |
| `scripts/headless.sh bun scripts/browser-drive.ts` | `NB_MVP_OK` | Tabs, palette, downloads, session restore, padlock, find, context menu, private window, settings |

`scripts/headless.sh` wraps a command in a headless weston compositor and pins the GTK theme, icon
theme and fonts. Without that, a screenshot taken from a drive shows the developer's own desktop
theme instead of stock Adwaita, and three colour findings in this project's review history turned
out to be exactly that mistake. On macOS the drives run headful against the AppKit host, with
`ND_BACKEND=appkit`.

`ND_DRIVE_TIMEOUT_MS` scales every wait at once. Raise it when the machine is loaded.

`bun test` runs the unit suite (`src/**/*.test.ts`); there are none checked in right now, so it
passes trivially.

## What works

Sidebar tabs carry the site's own favicon and a close button, and each one owns a live webview that
survives switching away and back. The address bar is a command palette: it ranks the address you
typed first, then open tabs, then history, then app commands.

Beyond that: downloads, session restore, per-host zoom, find in page with a match count, a native
page context menu, a TLS padlock, a private window on an ephemeral profile, and a settings window
whose search engine, homepage and restore-on-launch all take effect.

## Package it

```bash
bunx nd package mac     # dist/mac/Lynk Browser.app
bunx nd package linux   # dist/linux/AppDir plus an AppImage
```

The icons live in `assets/icon`: an elementary-style tile (`linux.png`) that Linux installs into the
hicolor theme, and two Icon Composer layers (`mac-background.png`, `mac-foreground.png`) that macOS
compiles to `Assets.car` and `.icns`. They were generated through CanaryLLM from the prompts in
`assets/icon/prompts.json` (`bun assets/icon/generate.ts <key>`), and `assets/icon/build.py` keys the
chosen originals in `assets/icon/src` into those files.

The app was called NativeBrowser before. `app.previousName` makes the first launch under the new
name move the old data directory to `lynk` (dev and packaged runs share it) and, on macOS, the old
Chromium profile to the new executable's. A launch that runs the host by hand instead of through
`nd dev` sets `ND_APP_PREVIOUS_NAME=NativeBrowser` for the data directory move.

On a box without appimagetool the packager falls back to a bare squashfs image, which cannot be executed directly. Run `dist/linux/AppDir/AppRun`
to test the payload there.

## Layout

| Path | What lives there |
|---|---|
| `src/App.tsx` | The browser window: sidebar, header bar, tabs, palette, find bar, context menu |
| `src/PrivateWindow.tsx` | The private window and its ephemeral profile |
| `src/lib/` | Session, history, downloads, favicons, settings, URL parsing |
| `scripts/` | The drives and their headless wrappers |
| `screenshots/` | Drive output. `screenshots/final/` is the reviewed set |

## Known gaps

- The page context menu is a popover anchored to the content pane, not to the click point. Neither
  backend exposes a point-anchored popup menu.
- The find bar has no Escape binding, because the framework surfaces no key events to the app.
- The GTK address display does not stretch across the header bar. AdwHeaderBar packs start
  children into a box that does not expand, so a hexpanding child cannot grow past its natural
  width.
