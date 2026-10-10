/// What a page asked for, as the browser tracks it until it is answered. An
/// unanswered id leaves the page waiting for ever, so every prompt that leaves
/// the queue answers first.
export interface PermissionPrompt {
  /// The framework's request id, echoed back through `respondPermission`.
  id: string;
  /// The tab whose view asked. A prompt belongs to its tab, not to the window:
  /// a background tab's request waits until that tab is looked at.
  tabId: string;
  origin: string;
  types: string[];
}

export type PermissionDecision = "allow" | "block";

/// What `respondPermission` sends. `dismiss` refuses without recording a
/// decision, for a prompt the user waved away.
export type PermissionResult = "allow" | "deny" | "dismiss";

/// Decisions the user has made, by origin and then by permission type. Chrome
/// remembers a click on Allow or Block; a dismissal remembers nothing, which is
/// why only the two buttons write here.
export type SitePermissions = Record<string, Record<string, PermissionDecision>>;

/// One request can carry several types (`getUserMedia({audio, video})` asks for
/// both), which the framework sends as one comma-separated string.
export function splitTypes(types: string): string[] {
  return types
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/// How each permission reads in a sentence. The verb is separate from the noun
/// because "use your camera" and "send you notifications" cannot share one.
const PHRASES: Record<string, { verb: string; noun: string }> = {
  geolocation: { verb: "use", noun: "your location" },
  camera: { verb: "use", noun: "your camera" },
  cameraPanTiltZoom: { verb: "use", noun: "your camera" },
  microphone: { verb: "use", noun: "your microphone" },
  notifications: { verb: "send", noun: "you notifications" },
  clipboard: { verb: "read", noun: "your clipboard" },
  midiSysex: { verb: "use", noun: "your MIDI devices" },
  sensors: { verb: "use", noun: "your device sensors" },
  idleDetection: { verb: "see", noun: "when you are away" },
  windowManagement: { verb: "manage", noun: "windows on your screens" },
  localFonts: { verb: "see", noun: "the fonts on this device" },
  fileSystemAccess: { verb: "use", noun: "files on this device" },
  storageAccess: { verb: "use", noun: "its cookies on this site" },
  topLevelStorageAccess: { verb: "use", noun: "its cookies on this site" },
  protectedMediaIdentifier: { verb: "play", noun: "protected media" },
  multipleDownloads: { verb: "download", noun: "several files" },
  pointerLock: { verb: "take", noun: "control of your pointer" },
  keyboardLock: { verb: "take", noun: "control of your keyboard" },
  vrSession: { verb: "start", noun: "a virtual reality session" },
  arSession: { verb: "start", noun: "an augmented reality session" },
  handTracking: { verb: "track", noun: "your hands" },
  localNetwork: { verb: "reach", noun: "devices on your network" },
  localNetworkAccess: { verb: "reach", noun: "devices on your network" },
  loopbackNetwork: { verb: "reach", noun: "software on this device" },
  registerProtocolHandler: { verb: "open", noun: "links of its own kind" },
  webAppInstallation: { verb: "install", noun: "itself as an app" },
  diskQuota: { verb: "store", noun: "more data on this device" },
  capturedSurfaceControl: { verb: "control", noun: "the screen it is sharing" },
  identityProvider: { verb: "sign", noun: "you in" },
};

/// A permission Chromium named but this browser has no sentence for: spaced out
/// from its camelCase name so the prompt still says something true.
function fallback(type: string): { verb: string; noun: string } {
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return { verb: "use", noun: words };
}

const EXTERNAL_PREFIX = "externalProtocol:";

/// A site allowed to open another application's links (mailto:, zoommtg:)
/// without asking is kept beside its permissions, one type per scheme.
export function externalProtocolType(scheme: string): string {
  return `${EXTERNAL_PREFIX}${scheme}`;
}

/// The permission's own name, for a row listing what a site has been given.
export function permissionName(type: string): string {
  if (type.startsWith(EXTERNAL_PREFIX)) return `Open ${type.slice(EXTERNAL_PREFIX.length)} links`;
  const noun = (PHRASES[type] ?? fallback(type)).noun.replace(/^(your|you|its|the|a|an) /, "");
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/// One sentence, however many types the request carries. Types that share a
/// verb share it in the sentence ("use your camera and your microphone");
/// types that do not get a clause each.
export function permissionSentence(host: string, types: string[]): string {
  const groups: { verb: string; nouns: string[] }[] = [];
  for (const type of types) {
    const phrase = PHRASES[type] ?? fallback(type);
    const last = groups[groups.length - 1];
    if (last && last.verb === phrase.verb) last.nouns.push(phrase.noun);
    else groups.push({ verb: phrase.verb, nouns: [phrase.noun] });
  }
  const clauses = groups.map((g) => `${g.verb} ${joinClauses(g.nouns)}`);
  // The framework sends no type for a request Chromium names nothing for.
  if (clauses.length === 0) return `${host || "This page"} wants to use a feature that needs your permission.`;
  return `${host || "This page"} wants to ${joinClauses(clauses)}.`;
}

/// Chromium reports an origin with a trailing slash ("http://host:port/")
/// while `URL.origin` has none, and the two have to key the same decision.
export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/// The answer already on record, or null when any of the request's types has
/// never been decided. A mixed request is asked again rather than half
/// answered: `respondPermission` takes one verdict for the whole id.
export function rememberedDecision(
  saved: SitePermissions,
  origin: string,
  types: string[],
): PermissionDecision | null {
  const forOrigin = saved[normalizeOrigin(origin)];
  if (!forOrigin || types.length === 0) return null;
  let answer: PermissionDecision | null = null;
  for (const type of types) {
    const decision = forOrigin[type];
    if (!decision) return null;
    if (answer && answer !== decision) return "block";
    answer = decision;
  }
  return answer;
}

export function rememberDecision(
  saved: SitePermissions,
  origin: string,
  types: string[],
  decision: PermissionDecision,
): SitePermissions {
  const key = normalizeOrigin(origin);
  const forOrigin = { ...(saved[key] ?? {}) };
  for (const type of types) forOrigin[type] = decision;
  return { ...saved, [key]: forOrigin };
}

export function forgetOrigin(saved: SitePermissions, origin: string): SitePermissions {
  const next = { ...saved };
  delete next[normalizeOrigin(origin)];
  return next;
}

/// What a site has been given, in a stable order so the list does not reshuffle
/// as decisions are added.
export function decisionsFor(saved: SitePermissions, origin: string): { type: string; decision: PermissionDecision }[] {
  return Object.entries(saved[normalizeOrigin(origin)] ?? {})
    .map(([type, decision]) => ({ type, decision }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/// The origin a decision is keyed by. Chromium reports one already, but a view
/// that has none (a new tab) must not key everything under "".
export function originOf(url: string): string {
  try {
    return normalizeOrigin(new URL(url).origin);
  } catch {
    return "";
  }
}
