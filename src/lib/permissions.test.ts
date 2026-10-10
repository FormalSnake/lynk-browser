import { expect, test } from "bun:test";
import { permissionSentence, splitTypes } from "./permissions.ts";

test("a request with no type still reads as a sentence", () => {
  expect(permissionSentence("example.com", splitTypes(""))).toBe(
    "example.com wants to use a feature that needs your permission.",
  );
  expect(permissionSentence("", [])).toBe("This page wants to use a feature that needs your permission.");
});

test("types sharing a verb share it, an unknown type is spelled out", () => {
  expect(permissionSentence("example.com", ["camera", "microphone"])).toBe(
    "example.com wants to use your camera and your microphone.",
  );
  expect(permissionSentence("example.com", ["webPrinting"])).toBe("example.com wants to use web printing.");
});
