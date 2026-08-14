# Automation: the full RPC surface

Ground truth for the method surface, param/result shapes, and error codes below is
`schema/rpc.json` (M8-D8), the single source of truth `tools/codegen.ts` compiles into both
`src/generated/rpc.zig` (consumed by `src/automation.zig`'s dispatch) and
`packages/react/src/generated/rpc.ts` (consumed by `packages/test/src/socket.ts`'s typed
`AutomationClient.call<M>`). A method/param/result rename in the schema is a compile error on
whichever side still references the old shape instead of a silent wire mismatch, the same
schema-to-dual-codegen pattern already used for `schema/widgets.json`. This doc is a
human/agent-readable mirror of the schema; if the two disagree, `schema/rpc.json` wins.

## Transport

Framed JSON-RPC 2.0: a u32 little-endian length prefix followed by the UTF-8 JSON payload, one
frame per message, over a unix domain socket at `$XDG_RUNTIME_DIR/nd-automation-<host-pid>.sock`.
The host prints the socket path as `ND_AUTOMATION_LISTENING path=<path>` on stderr once it's ready.
The server is gated on `NATIVE_AUTOMATION=1` in the host's environment (unset = the socket never
opens). `packages/mcp` is a stdio MCP server that bridges this socket to MCP tool calls (see below).

## Methods

| Method | Params | Result | Notes |
|---|---|---|---|
| `getTree` | none | `{coordinateSpace: "logical-window-topleft", root: JsonNode}` | full tree snapshot |
| `screenshot` | `{path: string, window?: number}` | `{path, width, height}` | in-process render → PNG; `window` (if given) must match the root ref |
| `click` | `{ref: number}` | `{ref, dispatched: true}` | actionability-checked, emits `clicked` semantically |
| `waitFor` | `{condition: {textContains?: string} \| {refVisible?: number}, timeoutMs?: number}` | `{matched: true}` | polls at ~50ms; default `timeoutMs` 2000 |
| `setValue` | `{ref: number, value: string \| boolean \| number}` | `{ref, applied: true}` | kind-dispatched: `TextInput`/`TextArea` need a string, `Checkbox`/`Radio` a bool, `Slider` a number, `Select` an integer index |
| `type` | `{ref: number, text: string}` | `{ref, text: <full text after insert>}` | `TextInput` only; semantic append via `GtkEditable.insertText`, never synthetic keysyms |
| `scroll` | `{ref: number, dx?: number, dy?: number}` | `{ref, x, y}` (resulting adjustment values) | `ScrollView` only, see Deltas below |

`JsonNode` shape (from `getTree`/nested in `root`/`children`): `{ref: number, type: string, testID:
string \| null, text: string \| null, visible: boolean, geometry: {x,y,w,h} \| null, children:
JsonNode[], itemCount: number \| null, rows: {title: string, badge: string \| null, iconName:
string \| null}[] \| null}`. `itemCount` is non-null only for data-driven widgets (currently
`ListView`); it is the row count, never a walk of GTK's recycled row widgets. `rows` is non-null
only for row-driven widgets (currently `SourceList`, M11) and carries each row's ordered
`{title, badge, iconName}`.

The table above covers the core semantic set. The full surface also includes `testId` targeting on
the action methods, `resolve` (testID → actionable ref), `windows` (live per-window state),
`doubleClick`/`rightClick`/`hover` and `pointer`/`drag`/`keys` (real input synthesis, macOS only),
and the extended `waitFor` vocabulary (`testId` selector with state predicates). Ground truth is
`schema/rpc.json`; the narrative doc is
`docs-site/src/content/docs/automation-testing/automation-socket.md`.

## Error codes

| Code | Meaning | `data` shape |
|---|---|---|
| `-32001` | not actionable | `{ref, reason: "unknown" \| "invisible" \| "unmapped" \| "offscreen"}` |
| `-32002` | `waitFor` timed out | `{timeoutMs}` |
| `-32601` | method not found | none |
| `-32602` | invalid params | `{ref}` where applicable (e.g. missing/wrong-typed value, unsupported widget kind for `setValue`/`type`/`scroll`) |
| `-32603` | internal error | none (or a message describing the failure, e.g. screenshot renderer/surface errors) |
| `-32700` | parse error | none |

**Params are schema-typed (M8-D8).** `src/automation.zig`'s dispatch decodes each
method's `params` through the matching generated struct from `src/generated/rpc.zig`
(`std.json.parseFromValue`, wrapped by `parseParams`) instead of the old per-field
`paramInt`/`paramStr` helpers. A param that fails to typecheck against its schema type resolves to
`-32602` rather than reaching widget-dispatch code with an out-of-range value; that includes a
negative `ref` where the schema declares `u32`, previously an unchecked `@intCast` and now a clean
parse failure.

Actionability (`-32001`) is checked before every action-dispatch method (`click`, `setValue`,
`type`, `scroll`): the ref must exist, be visible, be mapped, and have non-degenerate on-screen
bounds relative to the window. This mirrors what a real user could reach; automation never acts on
what a user couldn't.

## Coordinate-space contract

`coordinateSpace` is always `"logical-window-topleft"`: every `geometry` field in `getTree` is in
logical units (not device pixels), relative to the window's top-left corner, computed via
`gtk.Widget.computeBounds(widget, window_widget, &rect)`.

## MCP tool names

`packages/mcp/src/index.ts` exposes ten tools, each a thin pass-through to the raw methods:
`nd_get_tree`, `nd_screenshot`, `nd_click`, `nd_wait_for`, `nd_set_value`, `nd_type`, `nd_scroll`,
`nd_double_click`, `nd_right_click`, `nd_hover`.

For anything beyond those, talk to the automation socket directly (see `packages/test/src/socket.ts`'s
`AutomationClient` for the client-side pattern, used by every `scripts/*-drive.ts` script).
`AutomationClient.call<M extends RpcMethodName>(method, ...params): Promise<RpcResult<M>>` is
schema-typed, tRPC-style (M8-D8): the method name, its params shape, and its result type are all
constrained by the generated `packages/react/src/generated/rpc.ts`, so `call("click", { ref })`
returns a typed `ClickResult` and a schema rename is a `tsc` error at the call site rather than a
runtime surprise.

## Deltas (known gaps, do not assume these work)

- **`scroll` only targets `ScrollView`-typed nodes** (their wrapping `GtkScrolledWindow`
  adjustments). A `ListView` node cannot be scrolled directly; scroll its wrapping `ScrollView`
  instead, if one wraps it.
- **No `TabView` page-switch RPC.** There is no automation action to change which tab is active.
- **No `ListView` row-activate/select action.** The widget emits `onRowActivated` upward to React,
  but there is no automation method to trigger row activation/selection from the RPC side.
- **Screenshot-after-scroll can race frame invalidation.** Taking a `screenshot` immediately after a
  `scroll` can occasionally return a texture from before the scroll finished compositing
  (`WidgetPaintable` served empty briefly in testing). If a post-scroll screenshot looks stale,
  retry (poll every ~150ms, up to ~3s) rather than treating a single failed/blank shot as final.
- **An empty `TextArea` collapses to 0 logical height**, which fails the actionability bounds check
  (`-32001`, non-degenerate on-screen bounds), so any action-dispatch method (`click`, `setValue`,
  `type`, `scroll`) on it reads as not actionable until it has content or explicit sizing. Wrap
  it in a `ScrollView` with a `minContentHeight` (or otherwise give the `TextArea` a non-zero
  starting height) if it needs to be automation-actionable while empty; an app that only relies on
  GTK's natural-size layout for an initially-empty `TextArea` is not automation-actionable by
  construction.
- **`Checkbox`/`Radio` should be driven with `setValue({ref, value: boolean})`, not `click`.** `click`
  emits `GtkCheckButton`'s `clicked` signal, which *toggles* the current state: it is relative, not
  idempotent, so scripting a specific end state (e.g. "make sure this is checked") by clicking
  requires knowing the current value first, and one stray extra click lands on the wrong state.
  `setValue` sets `checked` to an exact, deterministic value directly
  (`gtk_check_button_set_active`) and is the kind-dispatched path automation was designed around for
  these two kinds. Prefer it whenever the script cares about the target state rather than a toggle.

## Crash/overlay contract

After a runtime crash or disconnect, the host paints an in-window overlay on every open window and
registers its widgets in the tree, so `getTree` keeps answering through a crash instead of going
stale. TestIDs: `nd-overlay-title`, `nd-overlay-error`, `nd-overlay-restart`. Read
`nd-overlay-error`'s `text` for the failure message, and (dev mode only; `ND_DEV=1` gates the
Restart button, not the overlay) `click` the `nd-overlay-restart` ref to respawn the crashed child.
The runtime reports the error via the `runtimeError {message, stack, fatal}` NDP frame before it
dies, so the overlay shows the real error rather than a bare disconnect notice. `fatal=false`
reports (survived errors under the default policy) print `ND_RUNTIME_ERROR_NONFATAL` and never
become overlay text.

## Screenshots on macOS (ndshot)

The `screenshot` RPC (see above) renders offscreen inside the host process, and on macOS 26 that
path draws blank editable fields for `TextInput`/`TextArea`: `_NSCoreHostingView` only paints via
CoreAnimation when it's actually composited on screen, so an offscreen render ladder gets an empty
field back. Shelling out to `screencapture` over ssh doesn't work around this either: the terminal
environment agents run in (herdr) is blocked by TCC and cannot be granted Screen Recording, no
matter what the ssh session does. `tools/ndshot/` is the fix: a small, dependency-free Swift
package with its own stable binary identity that preflights/requests Screen Recording once, then
captures the *live composited* window via ScreenCaptureKit. This works even when the window is
occluded, and it doesn't touch the render ladder at all.

Build it (must unset `SDKROOT`/`DEVELOPER_DIR` inside the repo's nix devshell, or the system Swift
toolchain breaks):

```
cd tools/ndshot && ./build.sh
```

`build.sh` runs `swift build -c release`, installs the binary to the visible
`tools/ndshot/bin/ndshot` (the System Settings > Screen Recording file picker hides dot-folders
like `.build/`, so the grantable copy must live somewhere Finder can reach; in any macOS file
picker, ⌘⇧. toggles hidden files and ⌘⇧G jumps to a typed path), and ad-hoc signs it with a stable
identifier (`codesign -f -s - -i com.nativedesktop.ndshot bin/ndshot`) so the Screen Recording
grant sticks across rebuilds as long as the compiled bytes don't actually change; a rebuild that
changes the binary's content counts as a new identity to TCC and needs re-granting either way.

ndshot re-spawns itself once with `responsibility_spawnattrs_setdisclaim` so it is its own TCC
"responsible process". Without that, macOS attributes a CLI's permission checks to the terminal
that spawned it, the prompt names the terminal, and a Settings grant for the binary itself is
silently ignored (`ndshot doctor` prints which mode it is running in).

Three subcommands, all under `tools/ndshot/bin/ndshot`:

- `ndshot doctor` reports current Screen Recording permission state (and the binary's
  codesign identity, to help spot a stale grant after a rebuild). Exit 0 if granted, 2 if not.
- `ndshot list` enumerates every capturable window as one JSON object per line: `{"pid":…,
  "windowID":…, "app":"…", "title":"…", "x":…, "y":…, "width":…, "height":…, "onScreen":…}`.
- `ndshot capture --out <path.png> [--pid <pid>] [--title <substring>] [--window-id <id>]`
  captures the first matching window to a full-resolution PNG. `--title` is a case-insensitive
  substring match; `--pid`/`--title` compose (both must match); `--window-id` wins outright.

Example capturing the ND Notes window:

```
tools/ndshot/bin/ndshot capture --title "ND Notes" --out /tmp/nd.png
```

Exit codes across all three subcommands: `0` success, `2` no Screen Recording access (grant
instructions printed to stderr), `3` no window matched the given filters (the candidate window list
is printed to stderr so an agent can self-correct), `4` capture or PNG-write failure.

**One-time grant flow:** the first invocation of `list` or `capture` calls
`CGRequestScreenCaptureAccess()`, which triggers the system permission prompt. That prompt is
interactive, and only the machine's owner can complete it. Grant it via
System Settings → Privacy & Security → Screen Recording once; the grant then sticks to this binary's
path and ad hoc signature (see above) across future runs and rebuilds. Do not script around this or
loop retrying it; `ndshot doctor` exists so an agent can check the state instead of guessing.
