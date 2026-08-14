import { describe, expect, test } from "bun:test";
import {
  compileMatcher,
  matcherAccepts,
  matchesPath,
  matchesPattern,
  parseMatchPattern,
  toWebKitPatterns,
} from "./match-patterns.ts";

function accepts(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) throw new Error(`pattern ${pattern} did not parse`);
  return matchesPattern(parsed, url);
}

describe("parseMatchPattern", () => {
  test("rejects patterns Chrome rejects", () => {
    // No scheme separator, no path, a bare `*` host label, a port, an unknown scheme.
    for (const bad of [
      "http://example.com",
      "example.com/*",
      "http://*foo/bar",
      "http://foo.*.bar/baz",
      "http://example.com:8080/*",
      "chrome-extension://abc/*",
      "",
    ]) {
      expect(parseMatchPattern(bad)).toBeNull();
    }
  });

  test("accepts the canonical forms", () => {
    expect(parseMatchPattern("<all_urls>")?.host).toBe("*");
    expect(parseMatchPattern("*://*/*")?.schemes).toEqual(["http", "https"]);
    expect(parseMatchPattern("file:///foo*")?.host).toBe("");
    expect(parseMatchPattern("HTTP://Example.COM/*")?.host).toBe("example.com");
  });

  test("file: requires an empty host", () => {
    expect(parseMatchPattern("file://host/foo")).toBeNull();
  });
});

describe("scheme matching", () => {
  test("* covers http and https only", () => {
    expect(accepts("*://*/*", "http://a.test/x")).toBe(true);
    expect(accepts("*://*/*", "https://a.test/x")).toBe(true);
    expect(accepts("*://*/*", "ftp://a.test/x")).toBe(false);
    expect(accepts("*://*/*", "file:///x")).toBe(false);
  });

  test("<all_urls> covers file and ftp too", () => {
    expect(accepts("<all_urls>", "file:///etc/hosts")).toBe(true);
    expect(accepts("<all_urls>", "ftp://a.test/x")).toBe(true);
    expect(accepts("<all_urls>", "https://a.test/")).toBe(true);
  });

  test("no pattern matches a non-web scheme", () => {
    expect(accepts("<all_urls>", "chrome-extension://abcdef/popup.html")).toBe(false);
    expect(accepts("<all_urls>", "about:blank")).toBe(false);
    expect(accepts("<all_urls>", "data:text/html,hi")).toBe(false);
  });
});

describe("host matching", () => {
  test("*.domain matches the domain and its subdomains, not a suffix collision", () => {
    expect(accepts("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(accepts("https://*.example.com/*", "https://www.example.com/")).toBe(true);
    expect(accepts("https://*.example.com/*", "https://a.b.example.com/")).toBe(true);
    expect(accepts("https://*.example.com/*", "https://notexample.com/")).toBe(false);
    expect(accepts("https://*.example.com/*", "https://example.com.evil.test/")).toBe(false);
  });

  test("an exact host does not match subdomains", () => {
    expect(accepts("https://example.com/*", "https://www.example.com/")).toBe(false);
  });

  test("the port is ignored", () => {
    expect(accepts("http://127.0.0.1/*", "http://127.0.0.1:8931/page")).toBe(true);
  });

  test("host comparison is case-insensitive", () => {
    expect(accepts("https://Example.com/*", "https://EXAMPLE.COM/")).toBe(true);
  });
});

describe("path matching", () => {
  test("* spans any run of characters, including slashes", () => {
    expect(matchesPath("/*", "/a/b/c")).toBe(true);
    expect(matchesPath("/foo*bar", "/foo/deep/bar")).toBe(true);
    expect(matchesPath("/foo*bar", "/foobar")).toBe(true);
    expect(matchesPath("/foo*bar", "/foo/bar/baz")).toBe(false);
  });

  test("anchors may not overlap", () => {
    expect(matchesPath("/aa*aa", "/aaa")).toBe(false);
    expect(matchesPath("/aa*aa", "/aaaa")).toBe(true);
  });

  test("paths are case-sensitive", () => {
    expect(accepts("https://a.test/Foo", "https://a.test/foo")).toBe(false);
    expect(accepts("https://a.test/Foo", "https://a.test/Foo")).toBe(true);
  });

  test("the query string participates, the fragment does not", () => {
    expect(accepts("https://a.test/p?x=1", "https://a.test/p?x=1#frag")).toBe(true);
    expect(accepts("https://a.test/p", "https://a.test/p?x=1")).toBe(false);
  });

  test("an empty path is only reachable as /", () => {
    expect(accepts("https://a.test/", "https://a.test")).toBe(true);
    expect(accepts("https://a.test/", "https://a.test/x")).toBe(false);
  });
});

describe("compileMatcher", () => {
  test("excludes win over matches", () => {
    const m = compileMatcher(["<all_urls>"], ["*://*.private.test/*"]);
    expect(matcherAccepts(m, "https://a.test/")).toBe(true);
    expect(matcherAccepts(m, "https://x.private.test/page")).toBe(false);
  });

  test("an unparseable entry is dropped rather than widened", () => {
    const m = compileMatcher(["not a pattern", "https://ok.test/*"]);
    expect(m.matches).toHaveLength(1);
    expect(matcherAccepts(m, "https://ok.test/x")).toBe(true);
    expect(matcherAccepts(m, "https://other.test/x")).toBe(false);
  });
});

describe("toWebKitPatterns", () => {
  test("<all_urls> expands per scheme, since WebKit has no such literal", () => {
    const out = toWebKitPatterns(["<all_urls>"]);
    expect(out).toContain("http://*/*");
    expect(out).toContain("https://*/*");
    expect(out).toContain("file://*/*");
    expect(out).not.toContain("<all_urls>");
  });

  test("*:// expands to the two schemes it means", () => {
    expect(toWebKitPatterns(["*://*.example.com/*"])).toEqual([
      "http://*.example.com/*",
      "https://*.example.com/*",
    ]);
  });

  test("concrete patterns pass through unchanged", () => {
    expect(toWebKitPatterns(["https://a.test/x*"])).toEqual(["https://a.test/x*"]);
  });
});
