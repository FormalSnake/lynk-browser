# NativeDesktop agent docs

Entry point for coding agents working on or building with NativeDesktop. See also:
`zig-idiom.md` (Zig 0.16 corrective idiom), `styling.md` (style prop pointer), `automation.md`
(the full RPC surface).

## What this framework is

NativeDesktop is a two-process framework: a native host owns a real native window (GTK4/libadwaita
on Linux, AppKit on macOS; Windows planned) and a Bun/TypeScript child renders a Solid tree into it over a local
protocol (NDP). There is no DOM and no Electron; the `<webview>` widget embeds the platform's own
engine for web content, and the UI itself never renders through a browser. The host is
automation-first: every widget the Solid tree creates is tracked and answerable over a JSON-RPC
socket, so an agent can inspect and drive the app the same way a user would. Architecture in depth:
`docs-site/src/content/docs/core-concepts/architecture.md`.

## Running an app

**The `nd` CLI (`packages/nd`, published as `@nativedesktop/cli`).** A scaffolded app or `examples/*` package declares `"dev": "nd dev"`
(or `"nd dev main.tsx"` for the flat-layout `examples/*`), so `nd dev [entry]` is the canonical way
to run one. `entry` defaults to `src/main.tsx`. `nd dev` resolves the native backend for the current
platform through `@nativedesktop/host`'s `resolveHostBinary()`: the AppKit `nd-shell` on macOS, the
GTK `nd-hello` on Linux, overridable with `--backend gtk|appkit` or `ND_BACKEND`. The binary comes
prebuilt from the installed platform package (`@nativedesktop/host-darwin-arm64` or
`@nativedesktop/host-linux-x64`), or is built on first run inside a framework checkout
(see `packages/host/src/index.ts`). `ND_HOST_BINARY=<path>` skips that resolution outright, for
hosts it cannot serve (NixOS without `nix-ld`, an arch with no package, GTK on macOS); a path that
does not exist errors instead of falling back. It then spawns that binary with
`ND_DEV=1 ND_SCRIPT=<entry>`.
`nd build` runs `bun run compile`, the ahead-of-time pre-pass described below.
`nd package [mac|linux]` assembles and signs the platform bundle (pipeline in
`packages/nd/src/package/`), and `nd doctor` checks packaging/toolchain readiness. `nd dev`
does not set `NATIVE_AUTOMATION=1`, so export it before running if you need the automation socket.

`nd dev` prefers the *prebuilt* binary bundled with `@nativedesktop/host` (building it once inside a
framework checkout when absent), so it won't pick up an in-place host rebuild. If you're iterating on
the Zig or Swift host itself rather than app code, invoke the raw form directly against your fresh
build so host changes take effect immediately:

```
ND_SCRIPT=<entry.tsx> NATIVE_AUTOMATION=1 ./zig-out/bin/nd-hello
```

`ND_SCRIPT` points at the Bun/TSX entry point (e.g. `src/main.tsx`); `NATIVE_AUTOMATION=1` turns on
the automation RPC socket. This raw invocation is the mechanism `nd dev` wraps. Marker vocabulary to
grep for in the host's stderr (all `ND_*` markers print to stderr; capture `2>&1`):

| Marker | Meaning | Status |
|---|---|---|
| `ND_CHILD_CONNECTED` | the Bun child connected over the NDP socket | landed |
| `ND_COMMIT_APPLIED commitId=…` | a CommitBatch was applied to the retained tree | landed |
| `ND_AUTOMATION_LISTENING path=…` | the automation RPC socket is ready | landed |
| `ND_CHILD_EXITED reason=… code=…` | the child disconnected: `reason=hostShutdown` (the host stopped it, e.g. the last window closed), `exited code=<status>`, `signal code=<signum>`, `killed`, or `disconnected code=running` | landed |
| `ND_OVERLAY_SHOWN dev=…` | the host painted the crash overlay | landed |
| `ND_GC_SWEEP gen=… removed=…` | generation GC swept orphaned widgets after a reload | landed |
| `ND_RUNTIME_ERROR_REPORTED …` | the runtime reported a fatal error before dying | landed |
| `ND_RUNTIME_ERROR_NONFATAL …` | the runtime reported a survived error; the app keeps running | landed |
| `ND_DECORATION_LAYOUT source=… value=…` | which source answered for the window-button layout (`display` = the GDK backend's own, `portal` = the settings portal read on x11 where XSettings had none, `builtin` = GTK's compiled-in default) | landed |

`NDP_TRACE=1` (env var on the host) enables verbose per-frame NDP tracing, useful when a
commit isn't showing up as expected.

`ND_DEV=1` (env var on the host) selects `bun --hot` for the child process and enables the
crash-overlay's Restart button; this is what `nd dev` sets for you.

## HMR: what actually preserves state

`ND_DEV=1` runs the Bun child under `bun --hot`, which keeps the same OS process and socket across
an edit but re-evaluates the entire module graph, `node_modules` included, and keeps only
`globalThis`. `@nativedesktop/solid/register` (`packages/solid/src/register.ts`, preloaded by
`nd dev`) makes that state-preserving:

- Each component module compiles with Solid's refresh transform against the `solid-js/refresh`
  runtime. A module's previous accept callbacks run once its new copy has evaluated and patch the
  live component proxies to the new code, so an edit remounts only the components whose code
  changed.
- `solid-js`, `@solidjs/signals`, `@solidjs/universal` and `@nativedesktop/solid` are pinned: the
  first evaluation of each file records its namespace on `globalThis` and every later load is a
  facade re-exporting it. A fresh `solid-js` would own a second reactive graph the live tree knows
  nothing about, and a fresh renderer would lose its retained tree.
- `render()` (`renderer.ts`) does not remount on a re-eval while the refresh runtime is active; it
  only swaps in the newest root function. An edit the runtime cannot patch (a removed component)
  calls `invalidate()`, which remounts the tree from that newest function.

Component files need no special import convention: `import { createSignal } from "solid-js"` is
the normal form. `scripts/headless-m8.sh`'s HMR leg exercises the real `examples/counter` app end
to end: click to a known state, edit a label string in a temp copy, and assert the label changed,
the click count survived, and the child never disconnected.

## `.desktop.tsx`: the platform-suffix convention

`template/src/Panel.desktop.tsx` is the desktop platform suffix, in the way React Native uses `.native.tsx`: an
ordinary `.tsx` file (TypeScript, ESLint, Prettier, and Bun all understand it with no extra config)
that resolves via extensionless imports (`import { Panel } from "./Panel.desktop"` finds
`Panel.desktop.tsx`). Use the suffix to keep NativeDesktop-only UI visually separated from source
shared with a web app in the same monorepo; there is nothing else framework-specific about
it.

## Ahead-of-time build

JSX is compiled at load time by the register preload (babel-preset-solid's universal transform, whose output imports its helpers from
`@nativedesktop/solid`). `nd build` instead runs the app's `compile` script, which in the template
is `nd-solid-build src/main.tsx --outdir dist` (`packages/solid/src/build.ts`): it bundles the
app's own modules into `dist/main.js` with the transform already applied and leaves packages
external. For a compiled run use `bun run compile && ND_SCRIPT=dist/main.js <host-binary>`; `nd
build` only compiles, it does not launch the host. A `.tsx` is treated as Solid when its nearest
`package.json` depends on `@nativedesktop/solid`, or per file with a
`/** @jsxImportSource @nativedesktop/solid */` pragma.

## MCP tools

`packages/mcp` is a stdio MCP server that bridges to the host's automation socket. Ten tools:

- `nd_get_tree`: snapshot the widget tree (refs, testIDs, text, geometry, accessibility state).
- `nd_screenshot`: render the window to a PNG at an absolute path.
- `nd_click`, `nd_set_value`, `nd_type`, `nd_scroll`: semantic input, both backends.
- `nd_wait_for`: poll a tree condition (`textContains` or `refVisible`) until it holds or times out.
- `nd_double_click`, `nd_right_click`, `nd_hover`: real input synthesis, macOS only (`-32003` on GTK).

These are a thin pass-through to the raw RPC methods; see `automation.md` for the full method list
(the raw socket adds `resolve`, `windows`, `pointer`/`drag`/`keys`, and the testId-targeted forms)
and the error-code contract. For scripted tests, prefer the `@nativedesktop/test` harness
(`packages/test/`): `launchApp` spawns a host with the automation socket on, targets widgets by
`ref` or `testId`, drives the host-side `waitFor` vocabulary, and scripts native dialogs through
`ND_AUTOMATION_DIALOG_SCRIPT`.

## Crash debugging for agents

When the Bun child crashes or disconnects, the host paints an in-window overlay on every open
window and keeps its widgets tracked, so `getTree` keeps answering through the crash; an agent
reads the crash the same way it reads any other tree state. The overlay exposes
`nd-overlay-title` / `nd-overlay-error` / `nd-overlay-restart` testIDs: read `nd-overlay-error`'s
`text` for the failure message, and (dev mode only; `ND_DEV=1` gates the Restart button, not the
overlay) `click` `nd-overlay-restart` to respawn the child and recover. Under the default error
policy an unhandled promise rejection does NOT crash the child: it prints
`ND_RUNTIME_ERROR_NONFATAL` and the app keeps running, and its message never becomes overlay text.
