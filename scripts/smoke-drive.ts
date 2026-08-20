#!/usr/bin/env bun
// Stage-0 acceptance: boot the scaffolded app headlessly with automation
// enabled and confirm the automation socket answers getTree with a window
// node. launchApp resolves the host binary via @nativedesktop/host's
// source-checkout fallback (no hardcoded path needed — it walks up from
// wherever the @nativedesktop/host package's real files live on disk, which
// the file:/override deps in package.json point at ../nd-browser-wave).
import { launchApp } from "@nativedesktop/test";

const app = await launchApp({ entry: "src/main.tsx" });

const { windows } = await app.windows();
if (windows.length !== 1) throw new Error(`expected 1 window, got ${windows.length}`);

const tree = await app.tree();
if (tree.root.type !== "Window") throw new Error(`root node type=${tree.root.type}, want "Window"`);

console.log("NB_STAGE0_OK");
await app.close();
