// Manifest V2 and V3 parsing, normalized into one shape the rest of the
// runtime works against. Anything the two versions spell differently
// (browser_action vs action, background page vs service worker, permissions vs
// host_permissions) is reconciled here so no other module branches on the
// manifest version.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Messages, localeChain, resolveMessageRefs, type MessageCatalog } from "./i18n.ts";

export type RunAt = "document_start" | "document_end" | "document_idle";
export type ScriptWorld = "ISOLATED" | "MAIN";

export interface ContentScriptGroup {
  matches: string[];
  excludeMatches: string[];
  js: string[];
  css: string[];
  runAt: RunAt;
  allFrames: boolean;
  matchAboutBlank: boolean;
  world: ScriptWorld;
}

export interface ActionSpec {
  defaultTitle: string;
  defaultPopup: string | null;
  defaultIcon: Record<string, string>;
}

export interface CommandSpec {
  name: string;
  description: string;
  /** Chrome's `Alt+Shift+D` spelling, or null when the command has no key. */
  suggestedKey: string | null;
}

export interface ExtensionManifest {
  manifestVersion: number;
  name: string;
  version: string;
  description: string;
  defaultLocale: string;
  icons: Record<string, string>;
  action: ActionSpec | null;
  backgroundPage: string | null;
  serviceWorker: string | null;
  contentScripts: ContentScriptGroup[];
  permissions: string[];
  optionalPermissions: string[];
  hostPermissions: string[];
  commands: CommandSpec[];
  webAccessibleResources: string[];
  /** The policy served with every extension PAGE (not with its subresources),
   * defaulted to Chrome's when the manifest declares none. */
  contentSecurityPolicy: string;
  /** The untouched JSON, which `chrome.runtime.getManifest()` must hand back. */
  raw: Record<string, unknown>;
}

/// Reads every catalog on the locale chain, most specific first. A missing
/// catalog is not an error: Chrome falls through to the default locale.
export function loadMessages(root: string, defaultLocale: string, uiLocale: string): Messages {
  const catalogs: MessageCatalog[] = [];
  const available = new Set<string>();
  try {
    for (const entry of readdirSync(resolve(root, "_locales"), { withFileTypes: true })) {
      if (entry.isDirectory()) available.add(entry.name);
    }
  } catch {
    return new Messages([]);
  }
  for (const locale of localeChain(uiLocale, defaultLocale)) {
    if (!available.has(locale)) continue;
    try {
      catalogs.push(JSON.parse(readFileSync(resolve(root, "_locales", locale, "messages.json"), "utf8")));
    } catch {
      // A corrupt catalog degrades to the next locale rather than failing the load.
    }
  }
  return new Messages(catalogs);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asIconMap(value: unknown): Record<string, string> {
  if (typeof value === "string") return { "16": value };
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [size, path] of Object.entries(value as Record<string, unknown>)) {
    if (typeof path === "string") out[size] = path;
  }
  return out;
}

function parseContentScripts(raw: unknown, manifestVersion: number): ContentScriptGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: ContentScriptGroup[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const group = entry as Record<string, unknown>;
    const runAt = group.run_at;
    const world = group.world;
    groups.push({
      matches: asStringArray(group.matches),
      excludeMatches: asStringArray(group.exclude_matches),
      js: asStringArray(group.js),
      css: asStringArray(group.css),
      runAt:
        runAt === "document_start" || runAt === "document_end" || runAt === "document_idle"
          ? runAt
          : "document_idle",
      allFrames: group.all_frames === true,
      matchAboutBlank: group.match_about_blank === true,
      // MV2 has no `world` key at all: every content script is isolated.
      world: manifestVersion >= 3 && world === "MAIN" ? "MAIN" : "ISOLATED",
    });
  }
  return groups;
}

function parseCommands(raw: unknown): CommandSpec[] {
  if (!raw || typeof raw !== "object") return [];
  const out: CommandSpec[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = (value ?? {}) as Record<string, unknown>;
    const keys = (spec.suggested_key ?? {}) as Record<string, unknown>;
    const key = keys.default ?? keys.chromeos ?? keys.linux ?? keys.windows ?? keys.mac;
    out.push({
      name,
      description: typeof spec.description === "string" ? spec.description : "",
      suggestedKey: typeof key === "string" ? key : null,
    });
  }
  return out;
}

/// MV2 lists resources as a flat array; MV3 wraps them in per-match objects.
function parseWebAccessibleResources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object") out.push(...asStringArray((entry as Record<string, unknown>).resources));
  }
  return out;
}

/// MV2 states one policy as a string; MV3 splits it per context and only
/// `extension_pages` applies to what this browser serves. Both versions default
/// to the same thing in Chrome, which is what an extension that declares
/// nothing is entitled to assume.
export const DEFAULT_EXTENSION_CSP = "script-src 'self'; object-src 'self'";

function parseContentSecurityPolicy(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    const pages = (raw as Record<string, unknown>).extension_pages;
    if (typeof pages === "string" && pages.trim()) return pages.trim();
  }
  return DEFAULT_EXTENSION_CSP;
}

export function parseManifest(root: string, uiLocale = "en"): ExtensionManifest {
  const path = resolve(root, "manifest.json");
  if (!existsSync(path)) throw new Error("no manifest.json in this folder");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

  const manifestVersion = typeof raw.manifest_version === "number" ? raw.manifest_version : 2;
  const defaultLocale = typeof raw.default_locale === "string" ? raw.default_locale : "en";
  const messages = loadMessages(root, defaultLocale, uiLocale);
  const localize = (value: unknown): string =>
    typeof value === "string" ? resolveMessageRefs(value, (key) => (messages.has(key) ? messages.get(key) : null)) : "";

  const background = (raw.background ?? {}) as Record<string, unknown>;
  const actionRaw = (raw.action ?? raw.browser_action ?? null) as Record<string, unknown> | null;
  const permissions = asStringArray(raw.permissions);

  // MV2 mixes host patterns into `permissions`; MV3 splits them out. Both end
  // up in `hostPermissions` so the permission prompt has one list to warn on.
  const isHostPattern = (p: string): boolean => p === "<all_urls>" || p.includes("://");

  const name = localize(raw.name) || "Unnamed extension";
  if (typeof raw.version !== "string") throw new Error(`${name} has no version`);

  return {
    manifestVersion,
    name,
    version: raw.version,
    description: localize(raw.description),
    defaultLocale,
    icons: asIconMap(raw.icons),
    action: actionRaw
      ? {
          defaultTitle: localize(actionRaw.default_title) || name,
          defaultPopup: typeof actionRaw.default_popup === "string" ? actionRaw.default_popup : null,
          defaultIcon: asIconMap(actionRaw.default_icon),
        }
      : null,
    backgroundPage: typeof background.page === "string" ? background.page : null,
    serviceWorker: typeof background.service_worker === "string" ? background.service_worker : null,
    contentScripts: parseContentScripts(raw.content_scripts, manifestVersion),
    permissions: permissions.filter((p) => !isHostPattern(p)),
    optionalPermissions: asStringArray(raw.optional_permissions),
    hostPermissions: [...permissions.filter(isHostPattern), ...asStringArray(raw.host_permissions)],
    commands: parseCommands(raw.commands),
    webAccessibleResources: parseWebAccessibleResources(raw.web_accessible_resources),
    contentSecurityPolicy: parseContentSecurityPolicy(raw.content_security_policy),
    raw,
  };
}

/// The icon closest to `wanted` without going under it, falling back to the
/// largest available. Extension icon sets are sparse and inconsistent.
export function pickIcon(icons: Record<string, string>, wanted: number): string | null {
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (sizes.length === 0) return null;
  const atLeast = sizes.find((n) => n >= wanted);
  return icons[String(atLeast ?? sizes[sizes.length - 1])] ?? null;
}
