import { describe, expect, test } from "bun:test";

import { ContextMenuRegistry, frameworkId, parseFrameworkId } from "./context-menus.ts";

const EXT = "aaaabbbbccccddddeeeeffffgggghhhh";
const OTHER = "1111222233334444555566667777888";

function registry(): ContextMenuRegistry {
  return new ContextMenuRegistry();
}

describe("registration", () => {
  test("create returns the id it stored, generating one when asked", () => {
    const menus = registry();
    expect(menus.create(EXT, { id: "toggle", title: "Toggle" })).toBe("toggle");
    const generated = menus.create(EXT, { title: "Second" });
    expect(generated).toStartWith("nb-menu-");
    expect(menus.entries(EXT).map((e) => e.id)).toEqual(["toggle", generated]);
  });

  test("create with a known id replaces that item in place", () => {
    const menus = registry();
    menus.create(EXT, { id: "a", title: "A" });
    menus.create(EXT, { id: "b", title: "B" });
    menus.create(EXT, { id: "a", title: "A2" });
    expect(menus.entries(EXT).map((e) => [e.id, e.title])).toEqual([
      ["a", "A2"],
      ["b", "B"],
    ]);
  });

  test("update patches only what it names", () => {
    const menus = registry();
    menus.create(EXT, { id: "a", title: "A", contexts: ["link"], enabled: false });
    menus.update(EXT, "a", { title: "Renamed" });
    const entry = menus.entry(EXT, "a")!;
    expect(entry.title).toBe("Renamed");
    expect(entry.contexts).toEqual(["link"]);
    expect(entry.enabled).toBe(false);
    expect(menus.update(EXT, "missing", { title: "x" })).toBe(false);
  });

  test("remove takes the subtree, removeAll takes the extension", () => {
    const menus = registry();
    menus.create(EXT, { id: "parent", title: "Parent" });
    menus.create(EXT, { id: "child", title: "Child", parentId: "parent" });
    menus.create(EXT, { id: "grandchild", title: "Grandchild", parentId: "child" });
    menus.create(EXT, { id: "loner", title: "Loner" });
    menus.remove(EXT, "parent");
    expect(menus.entries(EXT).map((e) => e.id)).toEqual(["loner"]);
    menus.removeAll(EXT);
    expect(menus.entries(EXT)).toEqual([]);
  });
});

describe("checkbox and radio state", () => {
  test("a checkbox click toggles the model and reports both states", () => {
    const menus = registry();
    menus.create(EXT, { id: "c", title: "C", type: "checkbox" });
    const first = menus.applyClick(EXT, menus.entry(EXT, "c")!);
    expect(first).toEqual({ checked: true, wasChecked: false });
    const second = menus.applyClick(EXT, menus.entry(EXT, "c")!);
    expect(second).toEqual({ checked: false, wasChecked: true });
  });

  test("checking one radio unchecks the rest of its group, and only that group", () => {
    const menus = registry();
    menus.create(EXT, { id: "r1", title: "One", type: "radio", checked: true });
    menus.create(EXT, { id: "r2", title: "Two", type: "radio" });
    menus.create(EXT, { id: "sep", title: "", type: "separator" });
    menus.create(EXT, { id: "r3", title: "Three", type: "radio", checked: true });

    const clicked = menus.applyClick(EXT, menus.entry(EXT, "r2")!);
    expect(clicked).toEqual({ checked: true, wasChecked: false });
    expect(menus.entry(EXT, "r1")!.checked).toBe(false);
    expect(menus.entry(EXT, "r2")!.checked).toBe(true);
    // The separator ends the run, so the radio after it keeps its own state.
    expect(menus.entry(EXT, "r3")!.checked).toBe(true);
  });

  test("update checked: true also takes the group", () => {
    const menus = registry();
    menus.create(EXT, { id: "r1", title: "One", type: "radio", checked: true });
    menus.create(EXT, { id: "r2", title: "Two", type: "radio" });
    menus.update(EXT, "r2", { checked: true });
    expect(menus.entry(EXT, "r1")!.checked).toBe(false);
  });
});

describe("the tree the framework is given", () => {
  const named = [{ id: EXT, name: "Pair Probe" }];

  test("one item rides inline, several group under the extension's name", () => {
    const menus = registry();
    menus.create(EXT, { id: "only", title: "Only", contexts: ["all"] });
    const single = menus.itemsForPage(named, "https://example.com/");
    expect(single).toHaveLength(1);
    expect(single[0]!.label).toBe("Only");
    expect(single[0]!.id).toBe(frameworkId(EXT, "only"));

    menus.create(EXT, { id: "second", title: "Second", contexts: ["link"] });
    const grouped = menus.itemsForPage(named, "https://example.com/");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.label).toBe("Pair Probe");
    expect(grouped[0]!.children?.map((c) => c.label)).toEqual(["Only", "Second"]);
    // The group has to show wherever any child would, or the child never shows.
    expect(grouped[0]!.contexts).toContain("link");
    expect(grouped[0]!.contexts).toContain("page");
  });

  test("parentId becomes a submenu, with type, checked and enabled carried over", () => {
    const menus = registry();
    menus.create(EXT, { id: "parent", title: "Parent", contexts: ["all"] });
    menus.create(EXT, { id: "kid", title: "Kid", parentId: "parent", contexts: ["all"] });
    menus.create(EXT, { id: "box", title: "Box", parentId: "parent", type: "checkbox", checked: true });
    menus.create(EXT, { id: "off", title: "Off", parentId: "parent", enabled: false });

    const [item] = menus.itemsForPage(named, "https://example.com/");
    expect(item!.label).toBe("Parent");
    const children = item!.children!;
    expect(children.map((c) => c.label)).toEqual(["Kid", "Box", "Off"]);
    expect(children[1]!.type).toBe("checkbox");
    expect(children[1]!.checked).toBe(true);
    expect(children[2]!.enabled).toBe(false);
  });

  test("contexts map onto the five the framework knows, and the unmappable are dropped", () => {
    const menus = registry();
    menus.create(EXT, { id: "all", title: "All", contexts: ["all"] });
    menus.create(EXT, { id: "frame", title: "Frame", contexts: ["frame"] });
    menus.create(EXT, { id: "media", title: "Media", contexts: ["video", "audio"] });
    const items = menus.itemsForPage(named, "https://example.com/")[0]!.children!;
    expect(items.find((i) => i.label === "All")!.contexts).toEqual([
      "page",
      "link",
      "image",
      "selection",
      "editable",
    ]);
    expect(items.find((i) => i.label === "Frame")!.contexts).toEqual(["page"]);
    expect(items.find((i) => i.label === "Media")).toBeUndefined();
  });

  test("documentUrlPatterns filter per page, not per click", () => {
    const menus = registry();
    menus.create(EXT, { id: "docs", title: "Docs only", contexts: ["all"], documentUrlPatterns: ["*://docs.example.com/*"] });
    expect(menus.itemsForPage(named, "https://example.com/")).toEqual([]);
    expect(menus.itemsForPage(named, "https://docs.example.com/a")).toHaveLength(1);
  });

  test("targetUrlPatterns ride along as globs and are re-checked on the click", () => {
    const menus = registry();
    menus.create(EXT, {
      id: "img",
      title: "Only pngs",
      contexts: ["image"],
      targetUrlPatterns: ["*://*.example.com/*.png"],
    });
    const [item] = menus.itemsForPage(named, "https://example.com/");
    expect(item!.targetUrlGlobs).toEqual(["*://*.example.com/*.png"]);

    const entry = menus.entry(EXT, "img")!;
    expect(menus.clickAllowed(entry, "https://example.com/", "https://img.example.com/cat.png")).toBe(true);
    expect(menus.clickAllowed(entry, "https://example.com/", "https://img.example.com/cat.jpg")).toBe(false);
    // A glob would accept this; the pattern engine does not, so the extension
    // is never told about the click.
    expect(
      menus.clickAllowed(entry, "https://example.com/", "https://evil.test/?u=https://a.example.com/x.png"),
    ).toBe(false);
  });

  test("invisible items and items with no label are left out", () => {
    const menus = registry();
    menus.create(EXT, { id: "hidden", title: "Hidden", contexts: ["all"], visible: false });
    menus.create(EXT, { id: "blank", title: "", contexts: ["all"] });
    expect(menus.itemsForPage(named, "https://example.com/")).toEqual([]);
  });

  test("each extension keeps its own items", () => {
    const menus = registry();
    menus.create(EXT, { id: "a", title: "A", contexts: ["all"] });
    menus.create(OTHER, { id: "a", title: "B", contexts: ["all"] });
    const items = menus.itemsForPage(
      [
        { id: EXT, name: "First" },
        { id: OTHER, name: "Second" },
      ],
      "https://example.com/",
    );
    expect(items.map((i) => i.label)).toEqual(["A", "B"]);
    menus.forget(EXT);
    expect(menus.entries(EXT)).toEqual([]);
    expect(menus.entries(OTHER)).toHaveLength(1);
  });
});

describe("framework ids", () => {
  test("round trip, including an entry id with colons of its own", () => {
    const id = frameworkId(EXT, "group:child:1");
    expect(parseFrameworkId(id)).toEqual({ extensionId: EXT, entryId: "group:child:1" });
  });

  test("an app's own item id is not an extension's", () => {
    expect(parseFrameworkId("nb-open-link")).toBeNull();
  });
});
