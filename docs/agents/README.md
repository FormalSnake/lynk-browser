# NativeDesktop agent docs

Entry point for coding agents working on or building with NativeDesktop. See also:
`zig-idiom.md` (Zig 0.16 corrective idiom), `styling.md` (style prop pointer), `automation.md`
(the full RPC surface).

## What this framework is

NativeDesktop is a two-process framework: a native host owns a real native window (GTK4/libadwaita
on Linux, AppKit on macOS; Windows planned) and a Bun/TypeScript child renders a React tree into it over a local
protocol (NDP). There is no DOM and no Electron; the `<webview>` widget embeds the platform's own
engine for web content, and the UI itself never renders through a browser. The host is automation-first: every widget the
React tree creates is tracked and answerable over a JSON-RPC socket, so an agent can inspect and
drive the app the same way a user would. Full design: `docs/superpowers/specs/2026-07-09-nativedesktop-design.md`.

## Running an app

**The `nd` CLI (`packages/nd`, published as `@nativedesktop/cli`).** A scaffolded app or `examples/*` package declares `"dev": "nd dev"`
(or `"nd dev main.tsx"` for the flat-layout `examples/*`), so `nd dev [entry]` is the canonical way
to run one. `entry` defaults to `src/main.tsx`. `nd dev` resolves the native backend for the current
platform through `@nativedesktop/host`'s `resolveHostBinary()`: the AppKit `nd-shell` on macOS, the
GTK `nd-hello` on Linux, overridable with `--backend gtk|appkit` or `ND_BACKEND`. The binary comes
prebuilt from the installed platform package (`@nativedesktop/host-darwin-arm64` or
`@nativedesktop/host-linux-x64`), or is built on first run inside a framework checkout
(see `packages/host/src/index.ts`). It then spawns that binary with `ND_DEV=1 ND_SCRIPT=<entry>`.
`nd build` runs `bun run compile`, the Babel and React Compiler pre-pass described below.
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
| `ND_CHILD_EXITED` | the child disconnected (crash, `kill -9`, or clean exit) | landed |
| `ND_OVERLAY_SHOWN dev=…` | the host painted the crash overlay | landed |
| `ND_GC_SWEEP gen=… removed=…` | generation GC swept orphaned widgets after a reload | landed |
| `ND_RUNTIME_ERROR_REPORTED …` | the runtime reported a fatal error before dying | landed |
| `ND_RUNTIME_ERROR_NONFATAL …` | the runtime reported a survived error; the app keeps running | landed |

`NDP_TRACE=1` (env var on the host) enables verbose per-frame NDP tracing, useful when a
commit isn't showing up as expected.

`ND_DEV=1` (env var on the host) selects `bun --hot` for the child process and enables the
crash-overlay's Restart button; this is what `nd dev` sets for you.

## HMR: what actually preserves state

**One required convention for component files: import hooks from
`@nativedesktop/react`, not `react`.** `ND_DEV=1` runs the Bun child under `bun --hot`, which keeps the same OS process and socket across
an edit, but re-evaluates the *entire* module graph on every edit, including `react`,
`react-reconciler`, and `@nativedesktop/react` (verified empirically against Bun 1.3.13 with a
`globalThis`-identity probe). Two mechanisms were tried and rejected before the one below;
they are recorded here so nobody re-attempts them:

- **Bun-level module aliasing** (`Bun.plugin`'s `builder.module()`, loaded via
  `bun --hot --preload <script>`) can genuinely intercept bare specifiers like `"react"` and
  `"react-reconciler"` and survives re-evals (the preload script itself runs once per process, not
  per edit). But Bun 1.3.13 throws `Requested module is already fetched` the moment an aliased
  specifier is touched by both an ESM `import` and a CJS `require()` anywhere in the process.
  `react-reconciler`'s bundled cjs does `require("react")` internally while this codebase and every
  app entry use genuine ESM `import`; that combination is unavoidable, so this mechanism cannot
  work without rewriting every consumer to `require()`.
- **`react-refresh`'s family-registration machinery**, wired through `reconciler.setRefreshHandler`
  (`packages/react/src/hmr.ts`), needs its own module instance pinned across re-evals too (it keeps
  its family/root registries in module-local closures, not on any object it hands out). This part
  *does* work: react-refresh has no internal `require()`s of its own, so a `globalThis` stash is
  sufficient with no Bun-level aliasing, and it is what actually makes a hot edit state-preserving.
  `render()` registers the root component under a fixed family key on first boot, and on every
  hot re-eval calls `hotUpdateRoot()` rather than `updateContainer` again (a fresh `<App/>` element's
  `.type` is a new function reference every re-eval, which the reconciler would otherwise treat as
  a type change and fully remount) to re-register the new type under the same family and ask
  react-refresh to patch the live fiber tree in place.

What ships: `packages/react/src/dev-react.ts` stashes the first-eval `react` module instance in
`globalThis` and re-exports its hooks (`useState`, `useEffect`, `useMemo`, `use`, `Suspense`, etc.)
through wrapper functions that always dispatch to that stashed instance. The reconciler created on
first boot (`renderer.ts`, guarded by the existing `globalThis`-keyed singleton) already closes over
that same first-eval `react` instance internally, so a hook resolved through
`@nativedesktop/react` always talks to the dispatcher the live reconciler actually drives. A hook
imported from `react` directly would resolve against a fresh, re-evaluated instance whose
dispatcher is never attached to any reconciler; that is the `Invalid hook call:
resolveDispatcher().useState` crash this convention avoids. **Convention:** `.tsx`/`.desktop.tsx`
component files must write `import { useState } from "@nativedesktop/react"`, not `from "react"`.
`examples/counter`, `template/src/App.tsx`, and `template/src/Panel.desktop.tsx` all follow this.
Shared, non-component `.ts` modules are the one exception (see the hook-rewrite transform below).
`scripts/headless-m8.sh`'s HMR leg exercises the real `examples/counter` app (not a synthetic
fixture) end to end: click to a known state, edit a label string in a temp copy, and assert the
label changed, the click count survived, and the child never disconnected.

## Hook imports: sharing hooks with web/React Native (M8-D8)

The convention above is a hard requirement for `.tsx`/`.desktop.tsx` component files,
but shared, platform-agnostic logic (a hook also meant to be consumed by a web or React Native
codebase in the same monorepo) can be authored the normal way, `import { useState } from
"react"`, and still resolve to the pinned instance. `babel-plugin-nativedesktop`
(`packages/babel-plugin-nativedesktop/`) rewrites named hook imports `from "react"` to `from
"@nativedesktop/react"` at both places this framework transforms source:

- Under `nd build`, the Babel plugin (`index.js`) runs as an ordinary visitor alongside
  `babel-plugin-react-compiler` and the JSX transform (`template/babel.config.json`). It rewrites
  every file's `ImportDeclaration` for `"react"`, splitting hook specifiers into a second
  `import … from "@nativedesktop/react"` while default, namespace, and type-only specifiers stay on
  `"react"`.
- Under `nd dev`, Babel never runs inside Bun's own transpiler, so a Bun `onLoad` plugin does the
  equivalent job by string-rewriting the same import shape (`bun-plugin.js` via `rewrite.js`),
  registered once per process through `template/bunfig.toml`'s `preload`.

Only the hook subset `packages/react/src/dev-react.ts` pins gets rewritten; the exact list is
`packages/babel-plugin-nativedesktop/hooks.js`'s `PINNED_HOOKS`: `useState`, `useEffect`,
`useLayoutEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`, `useReducer`, `useTransition`,
`useDeferredValue`, `useSyncExternalStore`, `useId`, `use`, `startTransition`.

**Critical asymmetry: the dev-path Bun plugin only rewrites `.ts` files, never
`.tsx`/`.desktop.tsx`.** Bun's runtime `onLoad` has no fall-through (a matched file must return
contents), and once a plugin returns contents for a file, `bun --hot` drops that file from its watch
set, so intercepting a component file would silently kill its hot reload. `bun-plugin.js`'s
`filter: /\.ts$/` therefore excludes every `.tsx`, which means **`.tsx`/`.desktop.tsx` components
must still import hooks from `@nativedesktop/react` directly** (the convention above, unchanged).
Importing a hook from raw `"react"` in a component still crashes under `bun --hot` with the same
`Invalid hook call` this whole mechanism exists to avoid. Shared, non-component `.ts` hooks are where
`from "react"` is safe: they get rewritten and pinned at first eval, but because the dev-path rewrite
only runs once per process (not per hot-reload), editing a shared `.ts` hook needs a host restart to
take effect; its `.tsx` consumers keep hot-reloading normally in the meantime.
`template/src/hooks/useToggle.ts` (consumed by `template/src/Panel.desktop.tsx`) is the worked
example. The babel/compiled path has no watcher to preserve, so it rewrites every extension
including `.tsx`/`.desktop.tsx`; the `.ts`-only restriction is purely a `bun --hot` dev-mode
constraint.

## `.desktop.tsx`: the platform-suffix convention

`template/src/Panel.desktop.tsx` is the NativeDesktop mirror of React Native's `.native.tsx`: an
ordinary `.tsx` file (TypeScript, ESLint, Prettier, and Bun all understand it with no extra config)
that resolves via extensionless imports (`import { Panel } from "./Panel.desktop"` finds
`Panel.desktop.tsx`). The babel JSX transform (`importSource: "@nativedesktop/react"`) and the
hook-rewrite transform above both apply to it exactly as they do to a plain `.tsx`. Use the suffix to
keep NativeDesktop-only UI visually separated from source shared with web/React Native in the same
monorepo; there is nothing else framework-specific about it.

## React Compiler (M8-D7)

React Compiler support is opt-in and off by default. `babel-plugin-react-compiler@1.0.0` runs
cleanly as a build pre-pass over the template's `src/`, and the compiled output runs correctly
against `@nativedesktop/react` (verified headless: 3 clicks, label updated, screenshot captured).
It is a pre-pass, not inline, because Bun's runtime transpiler does not run babel plugins
and `bun --hot` re-evaluates modules through Bun's own transpiler only. The template's `bun run
compile` script (`template/package.json`, also reachable as `nd build`) runs three babel plugins in
one pass (`template/babel.config.json`): `babel-plugin-react-compiler` (the memoization transform),
`@babel/plugin-transform-react-jsx` (JSX to `@nativedesktop/react/jsx-runtime` calls, chosen so
the compiled output contains no JSX syntax left for Bun to pragma-select on; Bun's dev-vs-prod
jsx-runtime selection is undocumented and version-fragile: it depends on
`NODE_ENV=production`, which is not honored consistently by `bun run` across 1.3.x), and
`babel-plugin-nativedesktop` (the hook-import rewrite above, so shared hooks written `from "react"`
still resolve to the pinned instance in the compiled output). Fixed
alongside this: `packages/react/src/jsx-runtime.ts` re-exported the type-only `JSX` namespace as a
value (`export { …, JSX }`), which crashed any hand-authored `import … from
"@nativedesktop/react/jsx-runtime"` (exactly what the babel JSX transform emits) with `export 'JSX'
not found`. Bun's own automatic-JSX-runtime injection happened to elide it, which masked the bug
until a real consumer imported the path directly. Changed to `export type { JSX }`. Not enabled by
default: `bun run dev`/`nd dev` (`ND_DEV=1` + `--hot`) still points at uncompiled `src/`, so hot
reload and react-refresh are unaffected; use `bun run compile && ND_SCRIPT=dist/main.tsx
<host-binary>` for a compiled run (`nd build` only compiles; it does not launch the host).

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
