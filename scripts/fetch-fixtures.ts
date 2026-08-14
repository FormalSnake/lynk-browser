#!/usr/bin/env bun
// Downloads the Dark Reader builds the extension drive runs against. They are
// real Chrome releases, far too large for the repo, so `fixtures/` is
// gitignored and this script reproduces it on any machine with `gh` authed.
// Unpacking goes through fflate rather than the `unzip` binary, which is not
// installed on the Linux runner outside the nix shell.
//
//   bun scripts/fetch-fixtures.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";

const VERSION = "v4.9.129";
const ROOT = resolve(import.meta.dir, "..", "fixtures");

const BUILDS = [
  { asset: "darkreader-chrome.zip", dir: "darkreader-mv2" },
  { asset: "darkreader-chrome-mv3.zip", dir: "darkreader-mv3" },
];

mkdirSync(ROOT, { recursive: true });

for (const { asset, dir } of BUILDS) {
  const zip = resolve(ROOT, asset);
  const out = resolve(ROOT, dir);
  if (!existsSync(zip)) {
    const proc = Bun.spawn(
      ["gh", "release", "download", VERSION, "--repo", "darkreader/darkreader", "-p", asset],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if ((await proc.exited) !== 0) throw new Error(`gh release download ${asset} failed`);
  }

  rmSync(out, { recursive: true, force: true });
  const entries = unzipSync(new Uint8Array(await Bun.file(zip).arrayBuffer()));
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const path = resolve(out, name);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  }

  const manifest = await Bun.file(resolve(out, "manifest.json")).json();
  console.log(`${dir}: ${manifest.name} ${manifest.version} (manifest v${manifest.manifest_version})`);
}
