#!/usr/bin/env bun
// Proves a SIGTERM'd host takes the graceful quit rather than dying mid-write:
// the host's ND_TERMINATE_SIGNAL marker has to reach the log on teardown. The
// harness swallows host stderr on green runs, so this is the only place that
// asserts the signal path at all. Run under scripts/headless.sh on Linux.
import { readFileSync } from "node:fs";

import { launchApp } from "@nativedesktop/test";

const LOG = "/tmp/nb-sigterm-host.log";

const app = await launchApp({ entry: "src/main.tsx", logPath: LOG });
await app.windows();
await app.restart();
await app.windows();
await app.close();

// logPath truncates per launch, so only the second instance's log survives;
// its teardown marker is the assertion.
const markers = readFileSync(LOG, "utf8")
  .split("\n")
  .filter((line) => line.includes("ND_TERMINATE_SIGNAL")).length;
if (markers < 1) throw new Error("the host died without taking the graceful quit (no ND_TERMINATE_SIGNAL in its log)");
console.log(`NB_SIGTERM_OK graceful teardown confirmed (${markers} marker${markers === 1 ? "" : "s"})`);
