// Turns a manifest's permission list into the sentences the install prompt
// shows. Chrome's own grouping: host access first (the broadest host pattern
// swallows the narrower ones), then API warnings, and a large silent set that
// never earns a line.
import { parseMatchPattern } from "./match-patterns.ts";

/// Permissions with no user-visible consequence. Listing them would train
/// people to skim the prompt, which is the opposite of what it is for.
const SILENT = new Set([
  "activeTab",
  "alarms",
  "background",
  "contextMenus",
  "declarativeContent",
  "fontSettings",
  "idle",
  "offscreen",
  "scripting",
  "storage",
  "unlimitedStorage",
  "webRequest",
]);

const API_WARNINGS: Record<string, string> = {
  bookmarks: "Read and change your bookmarks",
  clipboardRead: "Read data you copy and paste",
  cookies: "Read and change cookies on the sites you visit",
  debugger: "Access page debugging data",
  downloads: "Manage your downloads",
  geolocation: "Know your location",
  history: "Read and change your browsing history",
  management: "Manage your other extensions",
  nativeMessaging: "Exchange messages with programs on this computer",
  notifications: "Show notifications",
  privacy: "Change your privacy settings",
  proxy: "Change your proxy settings",
  tabs: "Access browser tabs",
  topSites: "Read your most visited sites",
  webNavigation: "Read your browsing activity",
};

function isAllHosts(pattern: string): boolean {
  if (pattern === "<all_urls>") return true;
  const parsed = parseMatchPattern(pattern);
  return parsed !== null && parsed.host === "*";
}

/// The hosts a pattern names, for the narrow case. `*.example.com` reads as
/// `example.com`, matching how Chrome phrases a domain-wide grant.
function hostLabel(pattern: string): string | null {
  const parsed = parseMatchPattern(pattern);
  if (!parsed || parsed.host === "" || parsed.host === "*") return null;
  return parsed.host.startsWith("*.") ? parsed.host.slice(2) : parsed.host;
}

export function hostWarning(hostPermissions: string[]): string | null {
  if (hostPermissions.length === 0) return null;
  if (hostPermissions.some(isAllHosts)) return "Read and change all your data on all websites";

  const hosts = [...new Set(hostPermissions.map(hostLabel).filter((h): h is string => h !== null))];
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return `Read and change your data on ${hosts[0]}`;
  if (hosts.length === 2) return `Read and change your data on ${hosts[0]} and ${hosts[1]}`;
  return `Read and change your data on ${hosts.length} websites`;
}

/// The prompt's whole list, host access first. Returns an empty array when the
/// extension asks for nothing worth warning about — the prompt then says so
/// rather than showing an empty box.
export function permissionWarnings(permissions: string[], hostPermissions: string[]): string[] {
  const warnings: string[] = [];
  const host = hostWarning(hostPermissions);
  if (host) warnings.push(host);
  for (const permission of permissions) {
    if (SILENT.has(permission)) continue;
    const warning = API_WARNINGS[permission];
    if (warning && !warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}
