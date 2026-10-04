import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { loadBlockingState } from "./lib/adblock.ts";
import { bookmarks, normalizeBookmarks } from "./lib/bookmarks.ts";
import { downloads, normalizeDownloads } from "./lib/downloads.ts";
import { openFavicons } from "./lib/favicons.ts";
import { openHistory, recentVisits } from "./lib/history.ts";
import { freshStart, normalize, session } from "./lib/session.ts";
import { normalizeSettings, settings } from "./lib/settings.ts";

const prefs = normalizeSettings(await settings.load());
settings.set(prefs);
const stored = await session.load();
const restored = normalize(prefs.freshWindow ? freshStart(stored, prefs.homepage) : stored);
session.set(restored);

// A capture run seeds the list as it stands mid-download, which a normal
// load would turn into interrupted rows.
const seeded = process.env.NB_TEST_HOOKS === "1" ? process.env.NB_DOWNLOADS_SEED : undefined;
const savedDownloads = await downloads.load();
downloads.set(seeded ? JSON.parse(await Bun.file(seeded).text()) : normalizeDownloads(savedDownloads));

bookmarks.set(normalizeBookmarks(await bookmarks.load()));
await loadBlockingState();

openFavicons();
await openHistory();
const initialHistory = await recentVisits();

await render(<App initialHistory={initialHistory} />);
