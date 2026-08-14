# Zig 0.16 idiom: wrong vs right

Coding agents are trained on corpora that predate most of Zig's `std.Io`/allocator-interface
rework. Every row below is a drift the NativeDesktop implementation actually hit and had to correct
(recorded in `CLAUDE-activeContext.md`, the project's session memory bank); none are hypothetical.
If you are writing or reviewing Zig in this repo, assume your training-data idiom is stale until
you have grepped `src/` for the real pattern.

| Concept | Pre-2025 idiom (hallucinated) | Zig 0.16 idiom (this repo) |
|---|---|---|
| Std out / markers | `std.io.getStdOut().writer()` | markers via `std.debug.print(...)` to stderr; framed I/O via `std.Io.Reader`/`std.Io.Writer` with caller-supplied buffers and explicit `.flush()` (see `src/automation.zig` `serveClient`) |
| Allocator | `std.heap.GeneralPurposeAllocator(.{}){}` | `init.gpa` from the juicy `main(init: std.process.Init)` entry (`src/main.zig`) |
| Sleep / time | `std.time.sleep(ns)` / `std.time.milliTimestamp()` (GONE) | `std.Io.sleep(io, .fromMilliseconds(n), .awake)`; poll-count bounds instead of wall-clock timing (see `src/automation.zig` `dispatchWaitFor`) |
| getenv / unlink | `std.posix.getenv(...)` / `std.posix.unlink(...)` | `init.environ_map.get(...)` for env; `std.Io.Dir.deleteFileAbsolute(io, path)` for file removal (see `src/automation.zig` `Server.start`) |
| Sockets | `std.net.StreamServer` | `std.Io.net.UnixAddress.init(path)` then `.listen(io, .{})`, `std.Io.net.Server`/`std.Io.net.Stream` (see `src/runtime.zig`, `src/automation.zig`) |
| Mutex | `std.Thread.Mutex{}` | `std.Io.Mutex = .init`. Never do `self.* = undefined` before assigning it; that skips the struct's field defaults and leaves the mutex bricked (see `src/runtime.zig` `writer_mutex`) |
| Spawn + env | pass environment as a raw slice | `std.process.spawn(io, .{ .environ_map = &map, ... })`. Note `environ_map` **replaces** the child's environment rather than extending it; PATH lookup for the spawned binary needs `std.Io.Threaded.init(gpa, .{ .environ = real_environ })` (see `src/runtime.zig`) |
| GTK / C interop | `@cImport(@cInclude("gtk/gtk.h"))` | gone from this codebase entirely; use the vendored zig-gobject modules (`@import("gtk")`, `@import("glib")`, etc. at `vendor/gobject-bindings`); no hand-written C headers anywhere in `src/` |
| Test discovery | assume `@import`ing a file pulls its `test` blocks into the build | no. Zig 0.16 does not collect tests transitively through `@import`; every test-bearing file needs its own `b.addTest(...)` root wired in `build.zig` (this bit the project once: `style.zig`'s tests were silently never run until a dedicated `addTest` was added, see `build.zig`) |
| Dynamic arrays | `std.ArrayList(T).init(alloc)` (managed) | unmanaged form: `var xs: std.ArrayList(T) = .empty;` then `xs.append(alloc, item)`. The allocator is passed per-call, not stored on the list (see `src/style.zig`, `src/null_backend.zig`) |

## Closing note

These are not style preferences: several of them (`std.Io.Mutex` needing `.init`, `environ_map`
replacing rather than merging, `addTest` needing an explicit root per file) are silent-failure traps
that compile and pass locally before breaking a specific runtime path. When in doubt, `rg` the
actual pattern in `src/` before writing new Zig; the living code is the up-to-date reference, not
this table and not pre-2025 training data.
