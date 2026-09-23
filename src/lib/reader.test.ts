import { expect, test } from "bun:test";

import { leaveReaderScript, readerSchemeScript, readerState, toggleReaderScript } from "./reader.ts";

test("every page script is one expression the engine can evaluate", () => {
  for (const code of [toggleReaderScript("light"), toggleReaderScript("dark"), leaveReaderScript(), readerSchemeScript("dark")]) {
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
