# nativedesktop-app

Scaffolded from the NativeDesktop template. Your UI lives in `src/`, renders to real native widgets,
and runs on GTK4 with libadwaita on Linux or AppKit on macOS.

## Run it

```bash
bun install
bun run dev
```

`bun run dev` is `nd dev`. It resolves the native host binary for your platform through
`@nativedesktop/host` (the AppKit shell on macOS, the GTK host on Linux) and spawns it with
`ND_DEV=1 ND_SCRIPT=src/main.tsx`. That gives you hot reload and the in-window crash-restart overlay.

| Command | What it does |
|---|---|
| `nd dev [entry]` | Dev mode. `entry` defaults to `src/main.tsx`. |
| `nd dev --backend gtk\|appkit` | Force a backend. Also reads `ND_BACKEND`. |
| `nd build` | Compile to `dist/` through Babel, the same as `bun run compile`. |
| `nd package [mac\|linux]` | Assemble and sign the platform bundle (`.app` / AppImage). Platform defaults to the host. Also `bun run package`. |
| `nd doctor [--json]` | Check packaging and toolchain readiness for this directory. |

App identity (bundle id, name, icon, file associations, URL schemes) and packaging options live in
`nativedesktop.config.ts`; `nd package` reads them.

`nd dev` does not set `NATIVE_AUTOMATION=1`. Export it in your shell first if you want the
automation socket.

If `nativedesktop.config.ts` declares app-owned native plugins, `nd` runs their cached build
commands first and passes the resulting shared-library paths to the prebuilt host. It never rebuilds
NativeDesktop itself. See `docs/native-components.md` in the framework checkout and `native/README.md`
here.

When you are iterating on the framework's own Zig or Swift host rather than this app, invoke the raw
form against your freshly built binary, since `nd dev` prefers the prebuilt one:

```bash
ND_DEV=1 ND_SCRIPT=src/main.tsx <path-to-nd-host-binary>
```

## Writing components

Import hooks from `@nativedesktop/react`, not from `react`:

```tsx
import { useState } from "@nativedesktop/react";
```

Hot reload re-evaluates the entire module graph, and a bare `react` import resolves to a fresh
instance whose dispatcher is attached to nothing. Shared, non-component `.ts` modules are the
exception: write those against `react` and the build rewrites the import for you.

## How this app links to the framework

`package.json` depends on the published npm packages: `@nativedesktop/react` (the renderer),
`@nativedesktop/native` (native-plugin headers), and `@nativedesktop/cli` (the `nd` bin, which pulls
in `@nativedesktop/host` and the prebuilt host binary for your platform). Optional additions from
the same family: `@nativedesktop/data` (worker-backed SQLite), `@nativedesktop/rpc` (resilient
JSON-RPC client for your own services), `@nativedesktop/panes` (split-pane tree over `<paned>`), and
`@nativedesktop/test` (automation harness for scripted app tests).

When scaffolded from a framework checkout, `scripts/new-app.sh` rewrites those registry versions to
`file:` paths into the checkout so the app exercises your local build instead of npm.

`@nativedesktop/react` declares `react` as a `peerDependency` rather than a regular dependency, so
Bun hoists one shared `react` for this app and the linked package. That is what prevents the
two-copies "Invalid hook call" failure.

## Errors and settings

Two framework defaults worth knowing from day one:

- **Async errors do not kill the app by default.** An unhandled promise rejection is reported and
  the app keeps running; an uncaught exception is fatal (the host paints the crash overlay). Tune it
  with `setUnhandledErrorPolicy` and subscribe with `onUnhandledError`, both from
  `@nativedesktop/react`.
- **Settings persist through `createStore`.** A versioned JSON file under the app data dir; call
  `await store.load()` before `render()` and `store.get()` is synchronous in every component, with
  `useStoreValue(store)` for reactive reads. Writes are debounced and crash-safe.

## React Compiler

Off by default, and working when you turn it on. `babel-plugin-react-compiler@1.0.0` runs cleanly as
a build pre-pass and its output runs correctly against `@nativedesktop/react`. It has to be a
pre-pass because Bun's runtime transpiler does not run Babel plugins.

```bash
bun run compile   # babel src -> dist, then run dist/main.tsx
```

`babel.config.json` runs three plugins in one pass:

- `babel-plugin-react-compiler` for the memoization transform.
- `@babel/plugin-transform-react-jsx` to turn JSX into `@nativedesktop/react/jsx-runtime` calls. This
  leaves no JSX syntax for Bun to pragma-select on, avoiding its undocumented dev-vs-prod runtime
  selection entirely.
- `babel-plugin-nativedesktop` to rewrite `react` hook imports to `@nativedesktop/react`, so shared
  hooks written the normal way for web or React Native still resolve to the pinned instance.

`dist/` is not part of the dev loop. `nd dev` still points at uncompiled `src/`, so hot reload and
react-refresh are unaffected. For a compiled production run:

```bash
bun run compile && ND_SCRIPT=dist/main.tsx <path-to-nd-host-binary>
```

## Why not `bun create`

`bun create ./template <dest>` does not work: Bun only treats `./.bun-create/<name>` or
`$HOME/.bun-create/<name>` as local templates, so a relative path falls through to
`bunx create-template` against npm. `bun create <name> <dest>` works once you have copied the
template into `./.bun-create/<name>` yourself, but that skips the name rewrite, the `docs/agents/*`
seeding, and the `file:` path fixups. Use `scripts/new-app.sh <dest>`.
