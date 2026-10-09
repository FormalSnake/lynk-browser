import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortName, downloadName, savedPageName, downloadStatus, formatBytes, isDangerous, normalizeDownloads, uniquePath, type DownloadItem } from "./downloads.ts";

const base: DownloadItem = {
  id: "d1",
  url: "https://example.com/files/report.pdf",
  name: "report.pdf",
  path: "/tmp/report.pdf",
  state: "inProgress",
  received: 2_000_000,
  total: 10_000_000,
  speed: 1_000_000,
  startedAt: 0,
};

test("status line reads size, speed and time left", () => {
  expect(downloadStatus(base, false)).toBe("2.0 MB of 10.0 MB · 1.0 MB/s · 8 s left");
  expect(downloadStatus({ ...base, state: "paused" }, false)).toBe("Paused · 2.0 MB of 10.0 MB");
  expect(downloadStatus({ ...base, state: "interrupted", reason: "network" }, false)).toBe("Network error · 2.0 MB of 10.0 MB");
  expect(downloadStatus({ ...base, state: "complete", received: 10_000_000 }, true)).toBe("10.0 MB · example.com");
  expect(downloadStatus({ ...base, state: "complete" }, false)).toBe("Moved or deleted");
  expect(downloadStatus({ ...base, total: 0 }, false)).toBe("2.0 MB · 1.0 MB/s");
});

test("sizes use decimal units", () => {
  expect(formatBytes(1)).toBe("1 byte");
  expect(formatBytes(999)).toBe("999 bytes");
  expect(formatBytes(1_500)).toBe("1.5 KB");
  expect(formatBytes(123_456_789)).toBe("123 MB");
});

test("a new name skips files on disk and downloads still running", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-dl-test-"));
  writeFileSync(join(dir, "a.txt"), "");
  expect(uniquePath(dir, "a.txt", new Set())).toBe(join(dir, "a (2).txt"));
  expect(uniquePath(dir, "a.txt", new Set([join(dir, "a (2).txt")]))).toBe(join(dir, "a (3).txt"));
  expect(uniquePath(dir, "b", new Set())).toBe(join(dir, "b"));
});

test("a suggested name never escapes the folder", () => {
  expect(downloadName("https://x/y", "../../etc/passwd")).toBe("passwd");
  expect(downloadName("https://x/y", ".hidden")).toBe("hidden");
  expect(downloadName("https://x/files/r.pdf")).toBe("r.pdf");
});

test("files that run on open are dangerous, installers are not", () => {
  expect(isDangerous("x.sh")).toBe(true);
  expect(isDangerous("x.jar")).toBe(true);
  expect(isDangerous("x.pdf")).toBe(false);
  expect(isDangerous("x.dmg")).toBe(false);
});

test("a download cut off by quitting comes back as retryable", () => {
  const out = normalizeDownloads({ items: [{ ...base, engineId: "cefdownload-3" }] });
  expect(out.items[0]!.state).toBe("interrupted");
  expect(out.items[0]!.reason).toBe("shutdown");
  expect(out.items[0]!.engineId).toBeUndefined();
});


test("a long name is cut in the middle and keeps its extension", () => {
  const cut = shortName("Quarterly report, final revision, signed copy for the board meeting.pdf");
  expect(cut.length).toBe(44);
  expect(cut.endsWith(".pdf")).toBe(true);
  expect(cut).toContain("…");
  expect(shortName("quarterly-report-2026-for-the-board.txt")).toBe("quarterly-report-2026-for-the-board.txt");
});

test("a saved page is named after its title, other files keep their name", () => {
  expect(savedPageName("Audit: page", "http://127.0.0.1/t.html", "t.html")).toBe("Audit_ page.html");
  expect(savedPageName("Home", "https://example.com/", "download")).toBe("Home.html");
  expect(savedPageName("", "https://example.com/a/index.php")).toBe("index.php");
  expect(savedPageName("", "https://example.com/")).toBe("download.html");
  expect(savedPageName("Report", "https://example.com/files/report.pdf")).toBe("report.pdf");
});
