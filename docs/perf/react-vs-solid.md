# React vs Solid timings on e1504g, g815 and mac

Measured 2026-10-06, 17:00 to 18:50 local. Both builds ran on the same machines in interleaved A/B
order (iteration 1 React then Solid, iteration 2 Solid then React, and so on), so load drift on a
host lands on both sides.

## Headline

| host | metric | React p50 | Solid p50 | change |
|---|---|---|---|---|
| e1504g | Ctrl+Tab between two tabs, input to pixels | 20.4 ms | 23.4 ms | +15% |
| e1504g | Sidebar row click round all tabs, input to pixels | 20.2 ms | 15.7 ms | -22% |
| e1504g | Tab switch JS share (row click, js.event to commit sent) | 3.3 ms | 2.2 ms | -33% |
| e1504g | Command bar keypress to painted | 18.3 ms | 18.1 ms | -1% |
| e1504g | Reload storm: GTK main loop busy applying commits, per run | 573 ms | 864 ms | +51% |
| e1504g | Reload storm: longest GTK main-loop stall per run | 185 ms | 137 ms | -26% |
| e1504g | Startup to session restored, warm profile | 3766 ms | 3858 ms | +2% |
| e1504g | Bun child RSS after 10 tabs | 108 MB | 88 MB | -19% |
| g815 | Ctrl+Tab round all tabs, input to pixels | 12.6 ms | 8.9 ms | -29% |
| g815 | Tab switch JS share (Ctrl+Tab round) | 2.1 ms | 1.4 ms | -33% |
| g815 | Ctrl+L to first command bar pixels | 28.6 ms | 44.2 ms | +55% |
| g815 | Reload storm: GTK main loop busy per run | 138 ms | 252 ms | +83% |
| g815 | Startup to session restored, warm profile | 702 ms | 848 ms | +21% |
| g815 | Bun child RSS after 10 tabs | 108 MB | 89 MB | -17% |
| mac | Tab switch JS share (row click, js.event to commit sent) | 1.36 ms | 1.18 ms | -13% |

Solid's reconcile is faster in every leg except Ctrl+Tab on e1504g: 0.5 to 1 ms less per tab
switch, and one commit of one op per command bar keystroke where React sends four commits. That
saving is small next to the rest of the input-to-pixels path (CEF view swap, GTK layout and paint,
compositor), so end-to-end switch latency moves by a few ms either way and on e1504g Ctrl+Tab got
slower at p50 and p90. Under page-load churn Solid sends about half the commits and fewer ops, yet the GTK main
loop spends 51 to 83% longer applying them, and the JS handlers take longer (Solid runs the
reactive update inside the handler, React defers it to the commit). Warm startup is level on
e1504g and 21% slower on g815; memory is level except the Bun child, which is about 20 MB smaller.

## Builds

| | app | framework |
|---|---|---|
| React | `main` at 5a44360 (600e36a plus the licence commit) | `main` at 9d4869d5 (v0.4.56) |
| Solid | `solid` at 727fa9e | `solid-renderer` at 94073321 |

Each from its own detached worktree (`~/Developer/bench-{react,solid}-{app,fw}`). After the runs,
`main` moved to ee95b69, which merges `solid`; the React numbers here are the last React `main`.

- Linux hosts: `zig build -Doptimize=ReleaseSafe` in each framework tree, inside the framework dev
  shell (bun 1.3.13, zig 0.16.0), on g815. e1504g ran the same built trees copied over, with the
  dev shell's store closure copied in by `nix copy`; nothing was built on e1504g.
- mac hosts: `scripts/mac/dev-cef-bundle.sh` from each framework tree (libnd ReleaseSafe, Swift
  `-c release`), bun 1.4.2.
- JS as `nd package` runs it: React through the app's `compile` script (babel with the React
  Compiler) and `ND_SCRIPT=dist/main.tsx`; Solid through `nd-solid-build` and
  `ND_SCRIPT=dist/main.js` with `BUN_OPTIONS=--preload=@nativedesktop/solid/register`.
- React runs its development build in both release and here: nothing sets `NODE_ENV`, and with
  `NODE_ENV=production` `@nativedesktop/react` fails at startup ("React Refresh runtime should not
  be included in the production bundle"), so a production React could not be measured. Solid's
  register preload picks the production `solid.js` outside `nd dev`.

## Method

Every Linux leg runs in its own nested Hyprland (headless mutter parent, the framework's
`scripts/snappy/rig.sh`) at 1920x1080, scale 1, with the dev shell's Mesa so GTK and CEF render on
the integrated GPU (`gpu_compositing=enabled`, ANGLE on Intel ADL-N on e1504g, Intel ARL on g815).
One rig at a time per host under the host's rig lock. Fresh profile per leg, 10-tab session in the
sidebar layout. The measurement scripts come from framework `main` for both sides; they are
byte-identical on `solid-renderer`.

- Tab switch: `scripts/switch-latency-drive.ts` against the app, 10 tabs, 20 rounds, host and
  child with `ND_LAT_TRACE=1`. Input is XTEST; a switch ends when the X server holds the new tab's
  colour at a point in the page. JS share is the `js.event` to `js.commitSend` gap from the
  per-switch hop lines. 4 runs per side, so 80 pair and round switches, 28 Ctrl+digit, 80 row-click
  pairs and 40 row-click rounds per side.
- Snappy leg, 10 runs per side, host with `ND_PERF_TRACE=1`: three launches on the 10-tab session
  (cold profile, then two warm) timed by `scripts/latency-x11.ts` to first window paint and to the
  active tab painted; Ctrl+Tab through all 10 tabs; RSS of the host process and its Bun child and
  PSS of the whole tree after 5 s idle; three command bar rounds (Ctrl+L, then six keys, each timed
  to the next pixel change in the bar region); then `scripts/snappy/reload.ts` reloading all 10 tabs
  every 400 ms for 9 s while two more bar rounds are typed. GTK main-loop numbers are the host's
  `ND_PERF job` lines (one per commit applied on the UI thread) inside that phase.
- mac: JS share only, 4 runs per side, 60 automation clicks on sidebar rows per run (30 between
  two tabs, 30 round all 10), timed from the host log's `ND_LAT` and `ND_PERF` lines. One CEF host
  at a time under `scripts/mac/cef-gate-lock.sh`.

## e1504g (the slow laptop, 8 cores, 7.5 GB)


**Tab switch, input to pixels (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+Tab between two tabs | 80 / 80 | 20.4 | 41.7 | 23.4 | 112 | +15% |
| Ctrl+Tab round all 10 tabs | 80 / 80 | 26.4 | 108 | 34.2 | 158 | +30% |
| Ctrl+digit | 28 (4 timed out) / 28 (4 timed out) | 31.1 | 269 | 26.4 | 198 | -15% |
| Sidebar row click, two tabs | 80 / 80 | 17.7 | 25.9 | 17.9 | 31.9 | +1% |
| Sidebar row click, round all tabs | 40 / 40 | 20.2 | 37.9 | 15.7 | 24.5 | -22% |
| Row highlight painted, row click round | 40 / 40 | 55.1 | 74.4 | 42.9 | 63.4 | -22% |

**Tab switch, JS share: js.event to js.commitSend (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+Tab between two tabs | 80 / 80 | 3.3 | 6.7 | 3.6 | 12.3 | +9% |
| Ctrl+Tab round all 10 tabs | 80 / 80 | 3.2 | 6.3 | 3.0 | 11.0 | -6% |
| Ctrl+digit | 28 / 28 | 3.1 | 16.9 | 2.8 | 8.3 | -10% |
| Sidebar row click, two tabs | 80 / 80 | 3.3 | 5.5 | 2.2 | 3.1 | -33% |
| Sidebar row click, round all tabs | 40 / 40 | 2.9 | 9.6 | 2.0 | 3.2 | -31% |
| Input to js.commitSend, Ctrl+Tab round | 80 / 80 | 4.6 | 14.7 | 5.0 | 20.6 | +9% |

**Command bar (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+L to first bar pixels | 27 (3 timed out) / 27 (3 timed out) | 65.5 | 145 | 63.0 | 157 | -4% |
| Keypress to updated bar painted | 111 (69 timed out) / 146 (34 timed out) | 18.3 | 47.5 | 18.1 | 56.1 | -1% |
| queryChanged to commit (JS) | 87 / 116 | 3.9 | 7.7 | 1.4 | 3.2 | -64% |
| Commits per run (3 opens, 18 keys) | 10 / 10 | 92.0 | 94.0 | 24.0 | 24.0 | -74% |
| Ops per run | 10 / 10 | 242 | 303 | 24.0 | 76.0 | -90% |
| Longest UI-thread job per run | 10 / 10 | 63.4 | 305 | 55.7 | 76.5 | -12% |

**Page-load churn, 10 tabs reloading every 400 ms for 9 s**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| loadProgress event to commit (ms) | 289 / 258 | 16.5 | 43.4 | 11.3 | 85.0 | -32% |
| Host events per run | 10 / 10 | 1690 | 2065 | 1993 | 2606 | +18% |
| Commits per run | 10 / 10 | 238 | 302 | 127 | 188 | -47% |
| Ops per run | 10 / 10 | 2304 | 3159 | 1180 | 3215 | -49% |
| JS handler time per run (ms) | 10 / 10 | 167 | 178 | 313 | 364 | +87% |
| GTK main loop busy applying commits per run (ms) | 10 / 10 | 573 | 703 | 864 | 1065 | +51% |
| GTK main-loop stall: longest job per run (ms) | 10 / 10 | 185 | 401 | 137 | 363 | -26% |
| Frame time (ms) | 2485 / 2571 | 9.7 | 52.7 | 8.7 | 49.5 | -10% |
| Ctrl+L to bar pixels during the storm (ms) | 20 / 20 | 121 | 524 | 129 | 806 | +7% |
| Keypress to bar painted during the storm (ms) | 61 (59 timed out) / 95 (25 timed out) | 42.6 | 193 | 49.0 | 438 | +15% |

**Startup, 10-tab session (ms from exec)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Cold profile: first window paint | 10 / 10 | 2796 | 4864 | 3471 | 4860 | +24% |
| Cold profile: session restored (active tab painted) | 10 / 10 | 3965 | 6355 | 5457 | 6501 | +38% |
| Warm profile: first window paint | 20 / 20 | 2791 | 4161 | 2925 | 4619 | +5% |
| Warm profile: session restored | 20 / 20 | 3766 | 5458 | 3858 | 6288 | +2% |

**Memory after 10 tabs woken (MB)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Bun child RSS | 10 / 10 | 108 | 110 | 88.2 | 88.9 | -19% |
| Host process RSS | 10 / 10 | 416 | 420 | 416 | 424 | 0% |
| Whole process tree PSS | 10 / 10 | 728 | 747 | 722 | 730 | -1% |

## g815 (NixOS, 24 threads, 30 GB)


**Tab switch, input to pixels (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+Tab between two tabs | 80 / 80 | 10.7 | 28.9 | 8.2 | 15.2 | -23% |
| Ctrl+Tab round all 10 tabs | 80 / 80 | 12.6 | 24.2 | 8.9 | 16.0 | -29% |
| Ctrl+digit | 28 (4 timed out) / 28 (4 timed out) | 10.0 | 15.7 | 8.0 | 14.6 | -20% |
| Sidebar row click, two tabs | 80 / 80 | 8.8 | 19.8 | 8.6 | 16.8 | -2% |
| Sidebar row click, round all tabs | 40 / 40 | 13.2 | 36.4 | 10.5 | 19.0 | -20% |
| Row highlight painted, row click round | 40 / 40 | 33.7 | 92.0 | 25.1 | 45.9 | -26% |

**Tab switch, JS share: js.event to js.commitSend (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+Tab between two tabs | 80 / 80 | 2.1 | 4.0 | 1.6 | 2.1 | -24% |
| Ctrl+Tab round all 10 tabs | 80 / 80 | 2.1 | 3.5 | 1.4 | 1.8 | -33% |
| Ctrl+digit | 28 / 28 | 1.9 | 2.9 | 1.4 | 2.2 | -26% |
| Sidebar row click, two tabs | 80 / 80 | 1.8 | 3.2 | 1.3 | 1.8 | -28% |
| Sidebar row click, round all tabs | 40 / 40 | 2.1 | 3.1 | 1.2 | 2.1 | -43% |
| Input to js.commitSend, Ctrl+Tab round | 80 / 80 | 3.5 | 6.7 | 2.6 | 3.5 | -26% |

**Command bar (ms)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Ctrl+L to first bar pixels | 29 (1 timed out) / 30 | 28.6 | 62.1 | 44.2 | 107 | +55% |
| Keypress to updated bar painted | 180 / 180 | 17.3 | 36.1 | 16.8 | 33.9 | -3% |
| queryChanged to commit (JS) | 150 / 143 | 1.7 | 2.7 | 0.7 | 1.0 | -61% |
| Commits per run (3 opens, 18 keys) | 10 / 10 | 92.0 | 94.0 | 24.0 | 24.0 | -74% |
| Ops per run | 10 / 10 | 226 | 248 | 24.0 | 24.0 | -89% |
| Longest UI-thread job per run | 10 / 10 | 20.1 | 38.9 | 24.3 | 50.8 | +21% |

**Page-load churn, 10 tabs reloading every 400 ms for 9 s**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| loadProgress event to commit (ms) | 658 / 330 | 1.3 | 4.7 | 1.7 | 20.4 | +34% |
| Host events per run | 10 / 10 | 2934 | 2943 | 2937 | 2941 | 0% |
| Commits per run | 10 / 10 | 586 | 691 | 247 | 261 | -58% |
| Ops per run | 10 / 10 | 6523 | 7803 | 4766 | 5332 | -27% |
| JS handler time per run (ms) | 10 / 10 | 43.8 | 59.7 | 67.9 | 87.0 | +55% |
| GTK main loop busy applying commits per run (ms) | 10 / 10 | 138 | 199 | 252 | 362 | +83% |
| GTK main-loop stall: longest job per run (ms) | 10 / 10 | 17.4 | 28.5 | 19.6 | 43.4 | +13% |
| Frame time (ms) | 5393 / 5345 | 3.8 | 14.9 | 5.2 | 14.7 | +38% |
| Ctrl+L to bar pixels during the storm (ms) | 20 / 20 | 27.4 | 45.6 | 40.0 | 86.8 | +46% |
| Keypress to bar painted during the storm (ms) | 120 / 120 | 20.9 | 57.6 | 24.0 | 62.6 | +15% |

**Startup, 10-tab session (ms from exec)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Cold profile: first window paint | 10 / 10 | 1078 | 1446 | 677 | 2792 | -37% |
| Cold profile: session restored (active tab painted) | 10 / 10 | 1251 | 1632 | 2127 | 3869 | +70% |
| Warm profile: first window paint | 20 / 20 | 609 | 1819 | 705 | 1421 | +16% |
| Warm profile: session restored | 20 / 20 | 702 | 1901 | 848 | 1985 | +21% |

**Memory after 10 tabs woken (MB)**

| | n (R/S) | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|---|
| Bun child RSS | 10 / 10 | 108 | 109 | 89.4 | 90.4 | -17% |
| Host process RSS | 10 / 10 | 418 | 421 | 427 | 429 | +2% |
| Whole process tree PSS | 10 / 10 | 751 | 755 | 740 | 743 | -1% |

## mac (JS share only)

Sidebar row click, 240 per side.

| | React p50 | React p90 | Solid p50 | Solid p90 | p50 change |
|---|---|---|---|---|---|
| js.event to js.commitSend (ms) | 1.36 | 2.64 | 1.18 | 2.08 | -13% |
| clicked event to commit, `ND_PERF` (ms) | 1.40 | 2.49 | 1.20 | 2.09 | -14% |
| click handler alone (ms) | 0.09 | 0.21 | 0.29 | 0.52 | +222% |
| js.event to host apply finished (ms) | 11.10 | 15.18 | 10.17 | 14.74 | -8% |
| ops per commit | 18 | 18 | 14 | 14 | -22% |

## Caveats

- Load. g815 was shared with other agents' rigs throughout: load average 1.9 to 30.8. e1504g is
  the owner's live desktop (Helium open): load 2.6 to 6.5 and 2.6 to 4.1 GB available; the bench
  ran at `oom_score_adj` 1000 and only started a leg with 1.8 GB free. The mac's load average was 50
  to 365 during its runs. Interleaving spreads this over both sides; it does not remove it, and
  the p90 columns carry most of it.
- e1504g typing: a keypress that changed nothing in the bar region within the latency tool's
  timeout is counted as timed out, not as a number (69 of 180 React and 34 of 180 Solid keypresses
  at rest; 59 and 25 of 120 during the storm). They follow a Ctrl+L that opened the bar late or not
  at all, so the typing medians cover the rounds where the bar opened.
- Ctrl+digit: one Ctrl+digit per switch run timed out on both sides (4 per side).
- "Ctrl+L to first bar pixels" is the first pixel change in the bar's region, which need not be
  the frame that already holds the rows.
- Startup has 10 cold samples per side, and on e1504g each launch competed with the owner's
  session; the cold page-painted gap there (+38%) is inside the spread of either side.
- `event_to_commit` counts from the first host event after the previous commit. React commits
  after nearly every event; Solid sends nothing for an event that changes nothing, so its window
  can start at an earlier no-op event. Only `loadProgress` and `queryChanged` are reported, and
  the per-run totals (commits, ops, handler time, main-loop time) are the sturdier numbers.
- The switch drive was run on the snappy rig rather than `scripts/headless-app-chrome.sh`'s hypr
  rig: on that rig the first fixture tab never showed its swatch colour, so the drive could not
  tell which tab was on show and most switches timed out.
- The mac row clicks are automation clicks, which enter the same `clicked` event path as a real
  click from the host on. The framework's mac drive sends real ⇧⌘] chords through `app.cursor`; on
  this machine they did not switch tabs, so its pixel timings could not be used.
- Bench scripts and raw logs: `~/Developer/bench-rvs-mac/` on the mac (`bench/` for the scripts,
  `results/` for every run). The copies on g815 and e1504g were removed after the runs.
