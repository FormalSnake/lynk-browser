import { expect, test } from "bun:test";
import { toUrl, fieldAddress } from "./url.ts";

test("an untouched address keeps the page's own scheme", () => {
  const page = "http://127.0.0.1:8080/deep/path?q=1";
  expect(fieldAddress("127.0.0.1:8080/deep/path?q=1", page)).toBe(page);
  expect(fieldAddress(" 127.0.0.1:8080/deep/path?q=1 ", page)).toBe(page);
  expect(toUrl(fieldAddress("127.0.0.1:8080/deep/path?q=1", page))).toBe(page);
});

test("an edited address is typed text", () => {
  expect(fieldAddress("example.com", "http://127.0.0.1:8080/")).toBe("example.com");
  expect(fieldAddress("example.com", "")).toBe("example.com");
});
