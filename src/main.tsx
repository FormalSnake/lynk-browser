import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { openFavicons } from "./lib/favicons.ts";
import { openHistory, recentVisits } from "./lib/history.ts";
import { freshStart, normalize, session } from "./lib/session.ts";
import { normalizeSettings, settings } from "./lib/settings.ts";

const prefs = normalizeSettings(await settings.load());
settings.set(prefs);
const stored = await session.load();
const restored = normalize(prefs.freshWindow ? freshStart(stored, prefs.homepage) : stored);
session.set(restored);

openFavicons();
await openHistory();
const initialHistory = await recentVisits();

await render(<App initialHistory={initialHistory} />);
