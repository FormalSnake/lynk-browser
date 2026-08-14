import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { ExtensionHost } from "./extensions/host.ts";
import { openFavicons } from "./lib/favicons.ts";
import { openHistory, recentVisits } from "./lib/history.ts";
import { normalize, session } from "./lib/session.ts";
import { settings } from "./lib/settings.ts";

const prefs = await settings.load();
const stored = await session.load();
// "Reopen tabs on launch" off starts on the homepage, or the new-tab page when
// none is set. The tab NUMBERING carries over either way, so a fresh id can
// never collide with one still sitting in the store.
const restored = normalize(
  prefs.restoreOnLaunch
    ? stored
    : {
        ...stored,
        tabs: prefs.homepage ? [{ id: `t${stored.nextTabId}`, url: prefs.homepage, title: "" }] : [],
        activeId: prefs.homepage ? `t${stored.nextTabId}` : "",
        nextTabId: stored.nextTabId + (prefs.homepage ? 1 : 0),
      },
);
session.set(restored);

openFavicons();
await openHistory();
const initialHistory = await recentVisits();

// The chrome-extension:// scheme is registered from inside App: the call needs
// a host connection, which only exists once render() has handshaken, and it
// must still land before the first <webview> mounts.
const extensions = new ExtensionHost();
await extensions.load();

await render(
  <App
    initialHistory={initialHistory}
    initialWidth={restored.windowWidth}
    initialHeight={restored.windowHeight}
    extensions={extensions}
  />,
);
