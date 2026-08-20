// Chrome extension match patterns, per
// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns.
//
// A pattern is `<scheme>://<host><path>`, with `<all_urls>` as the one special
// form. The parts are NOT interchangeable with a regex: `*` means "any host" as
// a whole host but "any leading label" only in `*.example.com`, the path is
// case-sensitive while the host is not, and the port never participates. That
// is why this is a parser rather than a string-to-RegExp shortcut.

/** The schemes `<all_urls>` covers. Chrome's list, minus the ones no engine here can load. */
const ALL_URLS_SCHEMES = ["http", "https", "file", "ftp", "ws", "wss"];

/** `*` as a scheme means http and https only — not "every scheme". */
const STAR_SCHEMES = ["http", "https"];

const VALID_SCHEMES = new Set([...ALL_URLS_SCHEMES, "urn", "*"]);

export interface MatchPattern {
  /** Lowercase schemes this pattern accepts. */
  schemes: string[];
  /** Lowercase host, `*` for any, or `*.example.com` for a domain and its subdomains. Empty for `file:`. */
  host: string;
  /** Path glob, always starting with `/`. `*` matches any run of characters. */
  path: string;
  source: string;
}

/// Parses one match pattern. Returns null for anything Chrome would reject, so
/// a malformed entry in a manifest fails closed rather than matching the world.
export function parseMatchPattern(input: string): MatchPattern | null {
  if (input === "<all_urls>") {
    return { schemes: [...ALL_URLS_SCHEMES], host: "*", path: "/*", source: input };
  }

  const sep = input.indexOf("://");
  if (sep < 0) return null;
  const scheme = input.slice(0, sep).toLowerCase();
  if (!VALID_SCHEMES.has(scheme)) return null;

  const rest = input.slice(sep + 3);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = rest.slice(0, slash).toLowerCase();
  const path = rest.slice(slash);

  // file: URLs have no host, and Chrome requires the empty host there.
  if (scheme === "file") {
    if (host !== "") return null;
  } else if (!isValidHostPattern(host)) {
    return null;
  }

  const schemes = scheme === "*" ? [...STAR_SCHEMES] : [scheme];
  return { schemes, host, path, source: input };
}

function isValidHostPattern(host: string): boolean {
  if (host === "") return false;
  if (host === "*") return true;
  // `*` is only legal as the whole host or as the leading label.
  const body = host.startsWith("*.") ? host.slice(2) : host;
  if (body.length === 0 || body.includes("*")) return false;
  // A port never participates in host matching, and Chrome rejects one outright.
  return !body.includes(":") && !body.includes("/");
}

/// Splits a URL into the three parts a pattern compares against. Returns null
/// for URLs no pattern can match (`about:`, `data:`, an extension origin, …).
export function splitUrl(url: string): { scheme: string; host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  // `pathname + search` is what Chrome matches; the fragment is excluded.
  return { scheme, host: parsed.hostname.toLowerCase(), path: `${parsed.pathname}${parsed.search}` };
}

export function matchesPattern(pattern: MatchPattern, url: string): boolean {
  const parts = splitUrl(url);
  if (!parts) return false;
  if (!pattern.schemes.includes(parts.scheme)) return false;
  if (!matchesHost(pattern.host, parts.host)) return false;
  return matchesPath(pattern.path, parts.path);
}

export function matchesHost(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const domain = pattern.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === pattern;
}

/// Glob match where `*` is the only metacharacter and spans any run of
/// characters, including `/`. Case-sensitive, as Chrome specifies for paths.
export function matchesPath(pattern: string, path: string): boolean {
  const segments = pattern.split("*");
  if (segments.length === 1) return path === pattern;

  const first = segments[0]!;
  if (!path.startsWith(first)) return false;
  const last = segments[segments.length - 1]!;
  if (!path.endsWith(last)) return false;
  // The leading and trailing anchors may not overlap.
  if (first.length + last.length > path.length) return false;

  let at = first.length;
  const end = path.length - last.length;
  for (const segment of segments.slice(1, -1)) {
    if (segment === "") continue;
    const found = path.indexOf(segment, at);
    if (found < 0 || found + segment.length > end) return false;
    at = found + segment.length;
  }
  return true;
}

export interface CompiledMatcher {
  matches: MatchPattern[];
  excludes: MatchPattern[];
}

export function compileMatcher(matches: string[], excludeMatches: string[] = []): CompiledMatcher {
  const parse = (list: string[]): MatchPattern[] =>
    list.map(parseMatchPattern).filter((p): p is MatchPattern => p !== null);
  return { matches: parse(matches), excludes: parse(excludeMatches) };
}

export function matcherAccepts(matcher: CompiledMatcher, url: string): boolean {
  if (!matcher.matches.some((p) => matchesPattern(p, url))) return false;
  return !matcher.excludes.some((p) => matchesPattern(p, url));
}

/// WebKit's own allow/block lists take `UserContentURLPattern` strings, which
/// share Chrome's grammar but have no `<all_urls>` form — it parses by looking
/// for `://` and rejects anything without it. Expanding to one pattern per
/// scheme keeps the native filter as tight as the JS guard.
export function toWebKitPatterns(patterns: string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const parsed = parseMatchPattern(raw);
    if (!parsed) continue;
    if (raw !== "<all_urls>" && !raw.startsWith("*://")) {
      out.push(raw);
      continue;
    }
    for (const scheme of parsed.schemes) out.push(`${scheme}://${parsed.host}${parsed.path}`);
  }
  return [...new Set(out)];
}
