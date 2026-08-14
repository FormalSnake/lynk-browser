import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { ExtensionHost } from "./extensions/host.ts";
import { openHistory, recentVisits } from "./lib/history.ts";
import { normalize, session } from "./lib/session.ts";

const restored = normalize(await session.load());
session.set(restored);

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
