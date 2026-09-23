import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { openFavicons } from "./lib/favicons.ts";
import { openHistory, recentVisits } from "./lib/history.ts";
import { WINDOW_HEIGHT, WINDOW_WIDTH, normalize, session } from "./lib/session.ts";
import { normalizeSettings, settings } from "./lib/settings.ts";

const prefs = normalizeSettings(await settings.load());
settings.set(prefs);
const stored = await session.load();
// "Reopen tabs on launch" off starts one window on the homepage, or the
// new-tab page when none is set. The tab and window NUMBERING carries over
// either way, so a fresh id can never collide with one still in the store.
const first = stored.windows[0];
const restored = normalize(
  prefs.restoreOnLaunch
    ? stored
    : {
        ...stored,
        windows: prefs.homepage
          ? [
              {
                id: first?.id ?? `w${stored.nextWindowId}`,
                tabs: [{ id: `t${stored.nextTabId}`, url: prefs.homepage, title: "", pinned: false }],
                activeId: `t${stored.nextTabId}`,
                width: first?.width ?? WINDOW_WIDTH,
                height: first?.height ?? WINDOW_HEIGHT,
              },
            ]
          : [],
        nextTabId: stored.nextTabId + (prefs.homepage ? 1 : 0),
      },
);
session.set(restored);

openFavicons();
await openHistory();
const initialHistory = await recentVisits();

await render(<App initialHistory={initialHistory} />);
