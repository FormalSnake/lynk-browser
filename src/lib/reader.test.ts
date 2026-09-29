import { expect, test } from "bun:test";

import { READER_BRIDGE_SCRIPT, leaveReaderScript, readerSchemeScript, readerState, toggleReaderScript } from "./reader.ts";

test("every page script is one expression the engine can evaluate", () => {
  for (const code of [toggleReaderScript("light"), toggleReaderScript("dark"), leaveReaderScript(), readerSchemeScript("dark"), READER_BRIDGE_SCRIPT]) {
    expect(() => new Function(`return ${code}`)).not.toThrow();
  }
});

test("the toggle carries Readability and the scheme it was asked for", () => {
  const code = toggleReaderScript("dark");
  expect(code).toContain("function Readability(");
  expect(code).toContain('host.dataset.scheme = "dark"');
});

test("anything but on or none reads as off", () => {
  expect(readerState("on")).toBe("on");
  expect(readerState("none")).toBe("none");
  expect(readerState("")).toBe("off");
});

test("escape leaves and says so on the document", () => {
  const code = toggleReaderScript("light");
  expect(code).toContain('e.key !== "Escape"');
  expect(code).toContain('new CustomEvent("ndreader:left")');
  expect(READER_BRIDGE_SCRIPT).toContain('"ndreader:left"');
});
