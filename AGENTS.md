# Agent notes for a NativeDesktop app

This app runs on the NativeDesktop framework: a Zig host process owning the native widgets, and a
Bun/React child rendering into it. The framework's full agent docs are copied into `docs/agents/` at
scaffold time. Read `docs/agents/README.md` first.

Three load-bearing rules:

1. **Run with `bun run dev` (`nd dev`)** for hot reload and the crash-restart overlay. It wraps
   `ND_DEV=1 ND_SCRIPT=src/main.tsx <resolved-host-binary>` and runs the prebuilt native host for
   your platform, AppKit on macOS or GTK on Linux, without rebuilding the host in place.
   `docs/agents/README.md` has the marker vocabulary, what `ND_DEV` changes, and the raw invocation
   to use when you are iterating on the framework's own host.
2. **Import hooks from `@nativedesktop/react` in `.tsx` and `.desktop.tsx` files**, never from
   `react`. That is what makes a hot edit preserve state instead of crashing or resetting. Shared,
   non-component `.ts` hooks are the exception: they import from plain `"react"` and get rewritten
   and pinned automatically. See the HMR and hook-rewrite sections of `docs/agents/README.md`,
   which also cover the `.desktop.tsx` convention.
3. **Styling is not web CSS.** There is no `flex`, `grid`, `position`, `display`, or
   `justifyContent`. See `docs/agents/styling.md`.

The CLI is `@nativedesktop/cli` (the `nd` bin): `nd dev` for hot reload, `nd build` to compile to
`dist/`, `nd package [mac|linux]` to assemble and sign the platform bundle from
`nativedesktop.config.ts`, and `nd doctor` for packaging/toolchain readiness checks. The app depends
on `@nativedesktop/react` plus `@nativedesktop/native`; optional packages from the same family are
`@nativedesktop/data` (worker SQLite), `@nativedesktop/rpc`, `@nativedesktop/panes`, and
`@nativedesktop/test` (the automation harness for scripted tests).

Two framework defaults: unhandled promise rejections are reported and survived while uncaught
exceptions stay fatal (tune with `setUnhandledErrorPolicy`, subscribe with `onUnhandledError`), and
persistent settings go through `createStore` (`await store.load()` before `render()`, then
synchronous `get()` and reactive `useStoreValue`). All of these come from `@nativedesktop/react`.

If you touch the framework itself rather than this app, read `docs/agents/zig-idiom.md` first. The
Zig here is 0.16, not the pre-2025 APIs most training data assumes.

The automation and testing surface (`getTree`, `click`, `screenshot`, `waitFor`, and the rest) is
documented in `docs/agents/automation.md`.
