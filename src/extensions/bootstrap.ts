// The `chrome.*` shim, as source injected into every world an extension runs
// in: the isolated world of each tab it has content scripts in, and the page
// world of its background and popup views.
//
// Nothing privileged lives here. Every API that touches browser state marshals
// a `call` envelope to the broker in the Bun process over the world's script
// message handler, and the broker answers by evaluating `__ndext.deliver(...)`
// back in the same world. Only the three synchronous APIs Chrome guarantees to
// be synchronous — runtime.id, runtime.getManifest, runtime.getURL, plus
// i18n.getMessage — are answered locally, from data baked into this source at
// injection time.
import type { MatchPattern } from "./match-patterns.ts";

/** The script message handler name registered in each extension world. */
export const BRIDGE_HANDLER = "ndext";

export type ContextKind = "content" | "background" | "popup";

export interface BootstrapConfig {
  extensionId: string;
  kind: ContextKind;
  /** `chrome-extension://<id>`, the base every getURL() resolves against. */
  baseUrl: string;
  manifest: Record<string, unknown>;
  /** Catalog entries for i18n.getMessage, already collapsed along the locale chain. */
  messages: Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
  uiLocale: string;
  /** Commands with their bound accelerator, for chrome.commands.getAll. */
  commands: { name: string; description: string; shortcut: string }[];
  /** Permissions the user granted at install time, for chrome.permissions.contains. */
  granted: string[];
}

/// The host/path halves of the match-pattern engine, mirrored in the injected
/// world. Parsing stays in TypeScript: only pre-parsed patterns cross over, so
/// the two implementations cannot disagree about what a pattern means.
export const MATCHER_JS = `
function ndMatchHost(pattern, host) {
  if (pattern === "*") return true;
  if (pattern.slice(0, 2) === "*.") {
    var domain = pattern.slice(2);
    return host === domain || host.slice(-(domain.length + 1)) === "." + domain;
  }
  return host === pattern;
}
function ndMatchPath(pattern, path) {
  var parts = pattern.split("*");
  if (parts.length === 1) return path === pattern;
  var first = parts[0], last = parts[parts.length - 1];
  if (path.slice(0, first.length) !== first) return false;
  if (last.length && path.slice(-last.length) !== last) return false;
  if (first.length + last.length > path.length) return false;
  var at = first.length, end = path.length - last.length;
  for (var i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue;
    var found = path.indexOf(parts[i], at);
    if (found < 0 || found + parts[i].length > end) return false;
    at = found + parts[i].length;
  }
  return true;
}
function ndMatchUrl(patterns, url) {
  var scheme, host, path;
  try {
    var u = new URL(url);
    scheme = u.protocol.replace(/:$/, "").toLowerCase();
    host = u.hostname.toLowerCase();
    path = u.pathname + u.search;
  } catch (e) { return false; }
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    if (p.schemes.indexOf(scheme) < 0) continue;
    if (!ndMatchHost(p.host, host)) continue;
    if (ndMatchPath(p.path, path)) return true;
  }
  return false;
}
/// about:blank and about:srcdoc frames inherit their parent's origin, which is
/// what Chrome matches them against under match_about_blank. Same-origin by
/// definition, so reading up the chain always succeeds.
function ndEffectiveUrl() {
  var href = location.href;
  if (href.indexOf("about:") !== 0) return href;
  var win = window;
  for (var hops = 0; hops < 32 && win !== win.parent; hops++) {
    win = win.parent;
    try {
      if (win.location.href.indexOf("about:") !== 0) return win.location.href;
    } catch (e) { return ""; }
  }
  return "";
}
`;

/// The guard every content script is wrapped in. WebKit's own allow/block
/// lists already filter most of this natively, but their pattern dialect is
/// not identical to Chrome's, so the JS check is what makes a mismatch fail
/// closed rather than open. Self-contained on purpose: a MAIN-world script
/// runs in the page, where the bootstrap deliberately does not exist.
export function contentScriptWrapper(
  source: string,
  matches: MatchPattern[],
  excludes: MatchPattern[],
  matchAboutBlank: boolean,
  runAtIdle: boolean,
): string {
  const wire = (list: MatchPattern[]): string =>
    JSON.stringify(list.map((p) => ({ schemes: p.schemes, host: p.host, path: p.path })));
  const body = runAtIdle
    ? `if (document.readyState === "complete") { run(); } else { window.addEventListener("load", run, { once: true }); }`
    : `run();`;
  return `(function(){
${MATCHER_JS}
${matchAboutBlank ? "" : `if (location.href.indexOf("about:") === 0) return;`}
var url = ndEffectiveUrl();
if (!url) return;
if (!ndMatchUrl(${wire(matches)}, url)) return;
if (ndMatchUrl(${wire(excludes)}, url)) return;
function run() {
// Counts the content scripts that cleared the guard in this document. The
// extension runtime is otherwise invisible from the outside, and this is what
// a drive can assert against.
globalThis.__ndextRan = (globalThis.__ndextRan || 0) + 1;
${source}
}
${body}
})();`;
}

/// CSS from a content script is injected by script: WebKit's user *style
/// sheets* have no per-view registry the way user scripts do, and the shared
/// DOM means a <style> built in the isolated world styles the page all the same.
export function contentStyleWrapper(css: string): string {
  return `var el = document.createElement("style");
el.textContent = ${JSON.stringify(css)};
(document.head || document.documentElement).appendChild(el);`;
}

export function bootstrapSource(config: BootstrapConfig): string {
  return `(function(){
if (globalThis.__ndext) return;
var CFG = ${JSON.stringify(config)};
${MATCHER_JS}

var pending = Object.create(null);
var seq = 0;
var token = "t" + Math.random().toString(36).slice(2) + Date.now().toString(36);
var ready = false;
var queue = [];
var identity = { tabId: -1, frameId: 0, documentId: null };
var lastError = null;

function post(env) {
  env.token = token;
  var handlers = window.webkit && window.webkit.messageHandlers;
  var bridge = handlers && handlers.${BRIDGE_HANDLER};
  if (bridge) bridge.postMessage(env);
}

function send(env) {
  if (!ready && env.k !== "hello") { queue.push(env); return; }
  post(env);
}

/// Every asynchronous chrome.* method funnels here. Chrome's contract is a
/// trailing optional callback; a promise is returned too, which is what MV3
/// code expects and MV2 code ignores.
function call(api, args, callback) {
  var id = "c" + (++seq);
  return new Promise(function (resolve) {
    pending[id] = function (ok, value, error) {
      lastError = ok ? null : { message: error || "unknown error" };
      try {
        if (typeof callback === "function") callback(value);
      } finally {
        lastError = null;
      }
      resolve(value);
    };
    send({ k: "call", id: id, api: api, args: args });
  });
}

/// Chrome lets the last argument be omitted; this pulls it off only when it is
/// really a callback so \`get(keys)\` and \`get(keys, cb)\` both work.
function popCallback(args) {
  return typeof args[args.length - 1] === "function" ? args.pop() : undefined;
}

function Event() {
  this._listeners = [];
}
Event.prototype.addListener = function (fn) {
  if (this._listeners.indexOf(fn) < 0) this._listeners.push(fn);
};
Event.prototype.removeListener = function (fn) {
  var at = this._listeners.indexOf(fn);
  if (at >= 0) this._listeners.splice(at, 1);
};
Event.prototype.hasListener = function (fn) {
  return this._listeners.indexOf(fn) >= 0;
};
Event.prototype.hasListeners = function () {
  return this._listeners.length > 0;
};
Event.prototype.emit = function (args) {
  var out;
  for (var i = 0; i < this._listeners.length; i++) {
    try {
      var r = this._listeners[i].apply(null, args);
      if (r !== undefined && out === undefined) out = r;
    } catch (e) {
      console.error("[nativebrowser] extension listener failed", e);
    }
  }
  return out;
};

var events = Object.create(null);
function event(name) {
  return events[name] || (events[name] = new Event());
}

// --- ports ---------------------------------------------------------------
var ports = Object.create(null);

function makePort(portId, name, sender) {
  var port = {
    name: name,
    sender: sender,
    onMessage: new Event(),
    onDisconnect: new Event(),
    postMessage: function (message) {
      send({ k: "portMsg", portId: portId, message: message });
    },
    disconnect: function () {
      if (!ports[portId]) return;
      delete ports[portId];
      send({ k: "portClose", portId: portId });
    },
  };
  ports[portId] = port;
  return port;
}

// --- inbound -------------------------------------------------------------
/// \`addressed\` is true when the broker aimed this message at exactly this
/// frame. A broadcast frame answers only if one of its listeners actually
/// produced a response, so a listener-less frame cannot close the channel out
/// from under the frame that was going to answer.
function handleMessage(env, addressed) {
  var listeners = event("runtime.onMessage")._listeners.slice();
  if (!addressed && listeners.length === 0) return;
  var responded = false;
  var sendResponse = function (response) {
    if (responded) return;
    responded = true;
    send({ k: "msgres", id: env.id, response: response === undefined ? null : response });
  };
  var wantsAsync = false;
  for (var i = 0; i < listeners.length; i++) {
    try {
      var result = listeners[i](env.message, env.sender || {}, sendResponse);
      if (result === true) wantsAsync = true;
    } catch (e) {
      console.error("[nativebrowser] onMessage listener failed", e);
    }
  }
  // Chrome closes the channel when no listener asked to keep it open. The
  // broker needs the same signal or its caller waits forever.
  if (addressed && !wantsAsync && !responded) sendResponse(undefined);
}

var api = {
  deliver: function (env) {
    // Only a view's MAIN frame can be evaluated into, so anything addressed at
    // one specific frame arrives here first and is passed down the tree.
    if (env.to && env.to !== token) return relayDown(env);
    switch (env.k) {
      case "ready":
        identity = { tabId: env.tabId, frameId: env.frameId, documentId: env.documentId };
        ready = true;
        for (var i = 0; i < queue.length; i++) post(queue[i]);
        queue = [];
        return;
      case "ret": {
        var settle = pending[env.id];
        if (!settle) return;
        delete pending[env.id];
        settle(env.ok, env.value, env.error);
        return;
      }
      case "msg": {
        // Addressed either by token (a documentId lookup resolved to this
        // frame) or by frame number; anything else is a broadcast.
        var aimed = env.to === token || (env.frameId !== undefined && env.frameId !== null);
        if (env.frameId !== undefined && env.frameId !== null && env.frameId !== identity.frameId && env.to !== token) {
          return relay(env);
        }
        handleMessage(env, aimed);
        return relay(env);
      }
      case "evt":
        event(env.name).emit(env.args || []);
        return relay(env);
      case "portOpen":
        event("runtime.onConnect").emit([makePort(env.portId, env.name, env.sender)]);
        return;
      case "portMsg": {
        var open = ports[env.portId];
        if (open) open.onMessage.emit([env.message, open]);
        return;
      }
      case "portClose": {
        var closing = ports[env.portId];
        if (!closing) return;
        delete ports[env.portId];
        closing.onDisconnect.emit([closing]);
        return;
      }
    }
  },
};

/// executeJavaScript only reaches a view's main frame, so anything addressed
/// at a subframe rides down the frame tree by postMessage. The envelope is
/// tagged with the extension id and the receiving frame filters by frameId, so
/// a frame never acts on another frame's message.
function relayDown(env) {
  for (var i = 0; i < window.frames.length; i++) {
    try {
      window.frames[i].postMessage({ __ndext: CFG.extensionId, env: env }, "*");
    } catch (e) {
      // A frame that refuses the post is one this extension cannot reach anyway.
    }
  }
}

function relay(env) {
  if (env.spread) relayDown(env);
}

window.addEventListener("message", function (e) {
  var data = e.data;
  if (!data || data.__ndext !== CFG.extensionId || !data.env) return;
  api.deliver(data.env);
});

globalThis.__ndext = api;

// --- the chrome namespace ------------------------------------------------
function storageArea(area) {
  var onChanged = event("storage." + area + ".onChanged");
  return {
    get: function () {
      var args = [].slice.call(arguments);
      var cb = popCallback(args);
      return call("storage.get", { area: area, keys: args[0] === undefined ? null : args[0] }, cb);
    },
    set: function (items, cb) { return call("storage.set", { area: area, items: items }, cb); },
    remove: function (keys, cb) { return call("storage.remove", { area: area, keys: keys }, cb); },
    clear: function (cb) { return call("storage.clear", { area: area }, cb); },
    getBytesInUse: function () {
      var args = [].slice.call(arguments);
      var cb = popCallback(args);
      return call("storage.getBytesInUse", { area: area, keys: args[0] === undefined ? null : args[0] }, cb);
    },
    onChanged: onChanged,
    QUOTA_BYTES: area === "sync" ? 102400 : 10485760,
  };
}

function messageText(key, substitutions) {
  var entry = CFG.messages[key];
  if (!entry) return "";
  var args = substitutions === undefined ? [] : (Array.isArray(substitutions) ? substitutions : [substitutions]);
  var named = entry.message.replace(/\\$([A-Za-z0-9_@]+)\\$/g, function (whole, name) {
    var p = entry.placeholders && (entry.placeholders[name] || entry.placeholders[name.toLowerCase()]);
    return p ? p.content : whole;
  });
  return named.replace(/\\$(\\$|[1-9])/g, function (_, t) {
    return t === "$" ? "$" : (args[Number(t) - 1] === undefined ? "" : args[Number(t) - 1]);
  });
}

function url(path) {
  if (!path) return CFG.baseUrl + "/";
  if (path.indexOf("chrome-extension://") === 0) return path;
  return CFG.baseUrl + (path.charAt(0) === "/" ? "" : "/") + path;
}

var runtime = {
  id: CFG.extensionId,
  getManifest: function () { return JSON.parse(JSON.stringify(CFG.manifest)); },
  getURL: url,
  getPlatformInfo: function (cb) { return call("runtime.getPlatformInfo", {}, cb); },
  setUninstallURL: function (u, cb) { return call("runtime.setUninstallURL", { url: u }, cb); },
  reload: function () { return call("runtime.reload", {}); },
  connect: function (a, b) {
    var info = (typeof a === "object" ? a : b) || {};
    var portId = "p" + token + "-" + (++seq);
    var port = makePort(portId, info.name || "", { id: CFG.extensionId });
    send({ k: "portOpen", portId: portId, name: info.name || "" });
    return port;
  },
  sendMessage: function () {
    var args = [].slice.call(arguments);
    var cb = popCallback(args);
    // sendMessage([extensionId,] message [, options]) — the id is only an id
    // when a message follows it.
    var message = args.length > 1 && typeof args[0] === "string" ? args[1] : args[0];
    return call("runtime.sendMessage", { message: message }, cb);
  },
  onMessage: event("runtime.onMessage"),
  onMessageExternal: event("runtime.onMessageExternal"),
  onConnect: event("runtime.onConnect"),
  onInstalled: event("runtime.onInstalled"),
  onStartup: event("runtime.onStartup"),
  onSuspend: event("runtime.onSuspend"),
  onUpdateAvailable: event("runtime.onUpdateAvailable"),
};
Object.defineProperty(runtime, "lastError", { get: function () { return lastError || undefined; } });

function actionApi() {
  return {
    setIcon: function (d, cb) { return call("action.setIcon", d || {}, cb); },
    setTitle: function (d, cb) { return call("action.setTitle", d || {}, cb); },
    setPopup: function (d, cb) { return call("action.setPopup", d || {}, cb); },
    setBadgeText: function (d, cb) { return call("action.setBadgeText", d || {}, cb); },
    setBadgeBackgroundColor: function (d, cb) { return call("action.setBadgeBackgroundColor", d || {}, cb); },
    getBadgeText: function (d, cb) { return call("action.getBadgeText", d || {}, cb); },
    onClicked: event("action.onClicked"),
  };
}

var chromeApi = {
  runtime: runtime,
  extension: {
    getURL: url,
    isAllowedFileSchemeAccess: function (cb) { return call("extension.isAllowedFileSchemeAccess", {}, cb); },
    getBackgroundPage: function () { return null; },
  },
  storage: {
    local: storageArea("local"),
    sync: storageArea("sync"),
    session: storageArea("session"),
    onChanged: event("storage.onChanged"),
  },
  i18n: {
    getMessage: messageText,
    getUILanguage: function () { return CFG.uiLocale; },
    getAcceptLanguages: function (cb) { if (cb) cb([CFG.uiLocale]); return Promise.resolve([CFG.uiLocale]); },
  },
  alarms: {
    create: function (name, info) {
      if (typeof name === "object") { info = name; name = ""; }
      return call("alarms.create", { name: name, info: info || {} });
    },
    clear: function (name, cb) { return call("alarms.clear", { name: name || "" }, cb); },
    clearAll: function (cb) { return call("alarms.clearAll", {}, cb); },
    get: function (name, cb) { return call("alarms.get", { name: name || "" }, cb); },
    getAll: function (cb) { return call("alarms.getAll", {}, cb); },
    onAlarm: event("alarms.onAlarm"),
  },
  tabs: {
    query: function (q, cb) { return call("tabs.query", { query: q || {} }, cb); },
    get: function (tabId, cb) { return call("tabs.get", { tabId: tabId }, cb); },
    getCurrent: function (cb) { return call("tabs.get", { tabId: identity.tabId }, cb); },
    create: function (props, cb) { return call("tabs.create", { props: props || {} }, cb); },
    update: function (tabId, props, cb) {
      if (typeof tabId === "object") { cb = props; props = tabId; tabId = identity.tabId; }
      return call("tabs.update", { tabId: tabId, props: props || {} }, cb);
    },
    reload: function (tabId, props, cb) {
      if (typeof tabId === "object") { cb = props; props = tabId; tabId = identity.tabId; }
      return call("tabs.reload", { tabId: tabId, props: props || {} }, cb);
    },
    remove: function (tabId, cb) { return call("tabs.remove", { tabId: tabId }, cb); },
    sendMessage: function (tabId, message, options, cb) {
      if (typeof options === "function") { cb = options; options = undefined; }
      return call("tabs.sendMessage", { tabId: tabId, message: message, options: options || {} }, cb);
    },
    connect: function (tabId, info) {
      info = info || {};
      var portId = "p" + token + "-" + (++seq);
      var port = makePort(portId, info.name || "", { id: CFG.extensionId });
      send({ k: "portOpen", portId: portId, name: info.name || "", tabId: tabId, frameId: info.frameId });
      return port;
    },
    executeScript: function (tabId, details, cb) {
      if (typeof tabId === "object") { cb = details; details = tabId; tabId = identity.tabId; }
      return call("tabs.executeScript", { tabId: tabId, details: details || {} }, cb);
    },
    insertCSS: function (tabId, details, cb) {
      if (typeof tabId === "object") { cb = details; details = tabId; tabId = identity.tabId; }
      return call("tabs.insertCSS", { tabId: tabId, details: details || {} }, cb);
    },
    onCreated: event("tabs.onCreated"),
    onUpdated: event("tabs.onUpdated"),
    onActivated: event("tabs.onActivated"),
    onRemoved: event("tabs.onRemoved"),
    onReplaced: event("tabs.onReplaced"),
  },
  windows: {
    WINDOW_ID_CURRENT: -2,
    create: function (props, cb) { return call("windows.create", { props: props || {} }, cb); },
    update: function (windowId, props, cb) { return call("windows.update", { props: props || {} }, cb); },
    getCurrent: function (cb) { return call("windows.getCurrent", {}, cb); },
    getAll: function (props, cb) {
      if (typeof props === "function") { cb = props; }
      return call("windows.getAll", {}, cb);
    },
    onFocusChanged: event("windows.onFocusChanged"),
  },
  commands: {
    getAll: function (cb) { if (cb) cb(CFG.commands); return Promise.resolve(CFG.commands); },
    onCommand: event("commands.onCommand"),
  },
  contextMenus: {
    create: function (props, cb) { void call("contextMenus.create", { props: props || {} }, cb); return (props && props.id) || ""; },
    update: function (id, props, cb) { return call("contextMenus.update", { id: id, props: props || {} }, cb); },
    remove: function (id, cb) { return call("contextMenus.remove", { id: id }, cb); },
    removeAll: function (cb) { return call("contextMenus.removeAll", {}, cb); },
    onClicked: event("contextMenus.onClicked"),
  },
  notifications: {
    create: function (id, options, cb) {
      if (typeof id === "object") { cb = options; options = id; id = ""; }
      return call("notifications.create", { id: id, options: options || {} }, cb);
    },
    clear: function (id, cb) { return call("notifications.clear", { id: id }, cb); },
    onClicked: event("notifications.onClicked"),
    onClosed: event("notifications.onClosed"),
  },
  permissions: {
    contains: function (p, cb) { return call("permissions.contains", p || {}, cb); },
    request: function (p, cb) { return call("permissions.request", p || {}, cb); },
    remove: function (p, cb) { return call("permissions.remove", p || {}, cb); },
    getAll: function (cb) { if (cb) cb({ permissions: CFG.granted, origins: [] }); return Promise.resolve({ permissions: CFG.granted, origins: [] }); },
    onAdded: event("permissions.onAdded"),
    onRemoved: event("permissions.onRemoved"),
  },
  fontSettings: {
    getFontList: function (cb) { return call("fontSettings.getFontList", {}, cb); },
  },
  webNavigation: {
    onCommitted: event("webNavigation.onCommitted"),
    onCompleted: event("webNavigation.onCompleted"),
    onBeforeNavigate: event("webNavigation.onBeforeNavigate"),
    onHistoryStateUpdated: event("webNavigation.onHistoryStateUpdated"),
  },
  scripting: {
    // An injected func is a real function on this side of the bridge and
    // source text on the other: nothing else survives the hop to the broker.
    executeScript: function (injection, cb) {
      var wire = {};
      for (var key in injection || {}) wire[key] = injection[key];
      if (typeof wire.func === "function") {
        wire.funcSource = wire.func.toString();
        delete wire.func;
      }
      return call("scripting.executeScript", wire, cb);
    },
    insertCSS: function (injection, cb) { return call("scripting.insertCSS", injection || {}, cb); },
    removeCSS: function (injection, cb) { return call("scripting.removeCSS", injection || {}, cb); },
    registerContentScripts: function (scripts, cb) { return call("scripting.registerContentScripts", { scripts: scripts }, cb); },
    unregisterContentScripts: function (filter, cb) { return call("scripting.unregisterContentScripts", filter || {}, cb); },
    getRegisteredContentScripts: function (filter, cb) { return call("scripting.getRegisteredContentScripts", filter || {}, cb); },
  },
  // WebKit exposes no closed-shadow-root escape hatch, so this answers only
  // for open roots. Dark Reader treats a null the same as "nothing to theme".
  dom: {
    openOrClosedShadowRoot: function (element) { return element ? element.shadowRoot : null; },
  },
};

chromeApi.action = actionApi();
chromeApi.browserAction = chromeApi.action;
chromeApi.pageAction = chromeApi.action;

globalThis.chrome = chromeApi;
if (!globalThis.browser) globalThis.browser = chromeApi;

send({ k: "hello", url: location.href, top: window === window.top, kind: CFG.kind });

// A background page registers its runtime.onInstalled / onStartup listeners
// while its own deferred script runs, so the broker waits for this before
// firing them rather than guessing at a delay.
if (document.readyState === "complete") send({ k: "loaded" });
else window.addEventListener("load", function () { send({ k: "loaded" }); }, { once: true });
})();`;
}
