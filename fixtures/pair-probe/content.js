// Runs in this extension's own isolated world, alongside whatever other
// extension is installed at the same time. Two things are proven from here:
// that the world got its own `chrome.*` shim at all, and that the world's own
// message bus reaches this extension's background page and comes back.
//
// The answer is parked on the world's global, which is where the drive reads
// it: `window` is shared with the page, `globalThis` in an isolated world is
// not, so an assertion on it cannot be satisfied by the page or by another
// extension's script.
globalThis.__ndpair = "sent";

chrome.runtime.sendMessage({ k: "ping", url: location.href }, function (response) {
  globalThis.__ndpair =
    response && response.pong ? "pong:" + response.pong + ":" + response.n : "no-reply";
});
