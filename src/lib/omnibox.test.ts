process.env.NB_TEST_HOOKS = "1";
process.env.NB_TEST_SEARCH_PREFIX = "https://search.test/?q=";

import { expect, test } from "bun:test";

const { completionFor, omniRows, shortcutLabel } = await import("./omnibox.ts");

const base = {
  mode: "address" as const,
  target: "current" as const,
  query: "",
  tabs: [],
  history: [],
  engineName: "Google",
  chromium: true,
  favicon: () => undefined,
};

test("completes to the bare host first, then host and path", () => {
  const urls = ["https://www.github.com/anthropics/claude", "https://news.ycombinator.com/item?id=1"];
  expect(completionFor("git", urls)).toEqual({ text: "github.com", url: "https://www.github.com/" });
  expect(completionFor("GitHub.com/an", urls)).toEqual({
    text: "github.com/anthropics/claude",
    url: "https://www.github.com/anthropics/claude",
  });
  expect(completionFor("news", urls)?.text).toBe("news.ycombinator.com");
  expect(completionFor("git hub", urls)).toBeNull();
  expect(completionFor("https://git", urls)).toBeNull();
  expect(completionFor("zzz", urls)).toBeNull();
});

test("the completed address leads, then the typed row, tabs, history, commands", () => {
  const rows = omniRows({
    ...base,
    query: "gith",
    tabs: [{ id: "t2", title: "GitHub issues", url: "https://github.com/issues" }],
    history: [
      { url: "https://github.com/pulls", title: "Pull requests" },
      { url: "https://github.com/issues", title: "GitHub issues" },
    ],
  });
  expect(rows.map((r) => r.id)).toEqual(["go:https://github.com/", "url", "tab:t2", "hist:https://github.com/pulls"]);
  expect(rows[0]!.completion).toBe("github.com");
  expect(rows[1]).toMatchObject({ title: "gith", subtitle: "Google Search", hint: "Search" });
  expect(rows[2]!.hint).toBe("Switch to Tab");
  expect(rows[3]!.hint).toBe("Open");
});

test("completion comes from history only, never from an open tab", () => {
  const rows = omniRows({ ...base, query: "exa", tabs: [{ id: "t1", title: "Ex", url: "https://example.com/" }] });
  expect(rows.some((r) => r.completion)).toBe(false);
});

test("a new-tab bar says where Enter goes", () => {
  const rows = omniRows({ ...base, target: "new-tab", query: "example.com" });
  expect(rows[0]).toMatchObject({ id: "url", title: "example.com", hint: "Open in New Tab" });
});

test("an untitled page names its address once", () => {
  const rows = omniRows({ ...base, history: [{ url: "https://example.com/a", title: "" }] });
  expect(rows[0]).toMatchObject({ title: "example.com/a", subtitle: undefined });
});

test("the switcher lists open tabs first, then every command", () => {
  const tabs = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `Tab ${i}`, url: `https://s${i}.com/` }));
  const rows = omniRows({ ...base, mode: "switcher", tabs, history: [{ url: "https://h.com/", title: "H" }], mac: true });
  expect(rows.filter((r) => r.id.startsWith("tab:")).length).toBe(8);
  expect(rows[0]).toMatchObject({ id: "tab:t0", hint: "Switch to Tab" });
  expect(rows.some((r) => r.id.startsWith("hist:"))).toBe(false);
  expect(rows.find((r) => r.id === "cmd:reopen-tab")?.hint).toBe("⇧⌘T");
  expect(rows.some((r) => r.id === "cmd:copy-address")).toBe(true);
});

test("a filtered switcher keeps matching tabs and commands", () => {
  expect(omniRows({ ...base, mode: "switcher", query: "zoom" }).map((r) => r.id)).toEqual([
    "cmd:zoom-in",
    "cmd:zoom-out",
    "cmd:zoom-reset",
  ]);
  expect(omniRows({ ...base, mode: "switcher", query: "unpin", pinned: true }).map((r) => r.title)).toEqual(["Unpin Tab"]);
  expect(omniRows({ ...base, mode: "switcher", query: "exten", chromium: false })).toEqual([]);
});

test("shortcut labels follow the platform", () => {
  expect(shortcutLabel("primary+shift+t", true)).toBe("⇧⌘T");
  expect(shortcutLabel("primary+comma", true)).toBe("⌘,");
  expect(shortcutLabel("primary+shift+t", false)).toBe("Ctrl+Shift+T");
  expect(shortcutLabel("primary+tab", false)).toBe("Ctrl+Tab");
});

test("hints come from the declared shortcuts", () => {
  const rows = omniRows({ ...base, mode: "switcher", mac: true });
  const hint = (id: string) => rows.find((r) => r.id === `cmd:${id}`)?.hint;
  if (process.platform === "darwin") {
    expect(hint("next-tab")).toBe("⇧⌘]");
    expect(hint("prev-tab")).toBe("⇧⌘[");
  }
  expect(hint("private")).toBe("⇧⌘N");
  expect(hint("zoom-in")).toBe("⌘+");
});

test("tabs step with Ctrl+Tab off macOS", () => {
  if (process.platform === "darwin") return;
  const rows = omniRows({ ...base, mode: "switcher", mac: false });
  const hint = (id: string) => rows.find((r) => r.id === `cmd:${id}`)?.hint;
  expect(hint("next-tab")).toBe("Ctrl+Tab");
  expect(hint("prev-tab")).toBe("Ctrl+Shift+Tab");
});

test("Put Tab to Sleep is offered only for a tab that can sleep", () => {
  const ids = (canSleep: boolean) => omniRows({ ...base, mode: "switcher", query: "sleep", canSleep }).map((r) => r.id);
  expect(ids(true)).toEqual(["cmd:sleep-tab"]);
  expect(ids(false)).toEqual([]);
  expect(omniRows({ ...base, mode: "switcher", query: "memory", canSleep: true }).map((r) => r.id)).toEqual(["cmd:sleep-tab"]);
});

test("reading mode and the floating video are commands with their chords", () => {
  const rows = omniRows({ ...base, mode: "switcher", query: "read" });
  expect(rows.find((r) => r.id === "cmd:reader")?.hint).toBe(process.platform === "darwin" ? "⇧⌘R" : "Ctrl+Shift+R");
  const reading = omniRows({ ...base, mode: "switcher", reading: true, mac: false });
  expect(reading.find((r) => r.id === "cmd:reader")?.title).toBe("Leave Reading Mode");
  expect(reading.find((r) => r.id === "cmd:float")?.hint).toBe("Ctrl+Alt+P");
  expect(omniRows({ ...base, mode: "switcher", query: "float", mac: true }).find((r) => r.id === "cmd:float")?.hint).toBe("⌥⌘P");
  expect(omniRows({ ...base, mode: "switcher", query: "pip" }).map((r) => r.id)).toContain("cmd:float");
  const webkit = omniRows({ ...base, mode: "switcher", chromium: false }).map((r) => r.id);
  expect(webkit).not.toContain("cmd:reader");
  expect(webkit).not.toContain("cmd:float");
});

test("no two declared shortcuts share a chord", async () => {
  const { KEYS } = await import("./keys.ts");
  const chords = Object.values(KEYS);
  expect(new Set(chords).size).toBe(chords.length);
});
