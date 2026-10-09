# Chromium pages: which ones the app draws itself

The owner's rule: replace a Chromium page when its job belongs to the
browser's own UI and nothing it does is lost; keep the rest as Chromium pages.
Arc drew the same line. It replaced the new tab page with its command bar and
moved downloads into its own Library, and kept Chromium's settings, extensions
and history pages under `arc://` ([Library](https://resources.arc.net/hc/en-us/articles/19230634389911),
[bookmarks](https://resources.arc.net/hc/en-us/articles/19400407903767),
[history](https://resources.arc.net/hc/en-us/articles/25591309234199)).

`src/lib/pages.ts` holds the mapping. Every route to a replaced page goes
through it: a typed address (`navigate`), a tab a page or an extension opens
(`openTab`, `openTabFromPage`), and a page that navigates there itself or a
restored tab (`onNavigated`, which sends the tab back to where it was).

| Page | Decision | Why |
| --- | --- | --- |
| `chrome://downloads` | Replaced | See below. |
| `chrome://newtab` | Replaced | The app has its own new tab page (a tab with no address), and Cmd/Ctrl+T opens the command bar (omnibox branch). `chrome://newtab`, `chrome://new-tab-page`, `about:newtab` and the local NTP become that tab, so Chromium's NTP never shows. |
| `chrome://tab-search` | Replaced | It is a toolbar bubble, not a page, and the command bar already searches open tabs. The URL opens the command bar. The Cmd/Ctrl+Shift+A chord reaches the app as a Chrome command, which the `no-escape` branch routes (`IDC_TAB_SEARCH` wants a `tabSearch` entry there). |
| `chrome://history` | Replaced | The History panel: every visit by day, searchable, a line removed with its button, Clear… for the list, and Cookies and Site Data… opens Chromium's own clearing page. It reads the app's visit log; Chromium's history database, which `chrome.history` extensions see, is not cleared from here. |
| `chrome://bookmarks` | Replaced | The Bookmarks panel: the app's own list (bookmarks.json), searchable, Bookmark This Page from the View menu or the panel's foot. Flat: folders are the sidebar's pinned tabs. `chrome.bookmarks` extensions see Chromium's model, not this list. |
| `chrome://settings`, `extensions`, `passwords`, `flags`, `version`, `policy`, ... | Kept | Owner's call: these stay Chromium's. |

## Downloads

Chromium runs every download (framework `downloadRequested` with an `id`,
`respondDownload`, `downloadUpdated`, plus `pauseDownload`, `resumeDownload`,
`cancelDownload` and `startDownload`); the app only decides where the file
goes and draws every surface. There is one list, the `downloads` store in
`src/lib/downloads.ts`, and one row component, `DownloadRow`. The old path, where the engine cancelled and Bun
re-fetched the URL, lost the page's cookies, POST bodies, `blob:` URLs and the
`download` attribute, and it stays only as the system-engine fallback.

Surfaces:

- The Downloads popover (`downloadsControl` in `src/BrowserWindow.tsx`;
  recent six, Open Downloads Folder, Show All): the sidebar foot's button and
  the compact toolbar's. It opens by itself when a download starts. Names past
  44 characters are cut in the middle there, since AppKit would widen the
  popover to the longest one; the panel shows them whole.
- The Downloads panel (`src/Panels.tsx`): every download, searchable, with
  Open Folder and Clear List. `chrome://downloads`, Show All and the menu
  chord land here.

## Panels

History, Downloads and Bookmarks are one kind of thing: a `<dialog>` over the window (a floating card
under a header bar on libadwaita, a sheet on AppKit), the search field holding
the caret, Return opening the first match, Esc or the same chord putting it
away. Chords are Chrome's own, in `src/lib/keys.ts` with the rest: History ⌘Y /
Ctrl+H, Downloads ⇧⌘J / Ctrl+J, Bookmarks ⌥⌘B / Ctrl+Shift+O, Bookmark This
Page ⌘D / Ctrl+D. Each is also a command bar row.

Routes: the Downloads menu item (⇧⌘J on macOS, Ctrl+J on Linux), the toolbar
button, the command bar's Downloads command,
typed `chrome://downloads` or `about:downloads`, a link or redirect to it, an
extension opening it as a tab. Chromium's `IDC_SHOW_DOWNLOADS` (its own chord
while a page has focus) is refused by the engine and reaches the app as
`browserCommand: "downloads"`; the app then opens the same panel (and
`history`, `bookmarks`, `bookmarkPage` likewise). Chromium's download bubble, its "Show all
downloads" item and its download-started arrow never appear: the framework
hides the arrow and nothing else of Chrome's download UI is created.

What is kept from Chromium's page, and where:

| Chromium | Here |
| --- | --- |
| Live progress, speed, time left | Progress ring and one status line ("4.2 MB of 12.0 MB · 1.3 MB/s · 6 s left"); a spinner when the size is unknown |
| Pause, resume, cancel | Row buttons, through the engine's own item callback |
| Retry a failed or cancelled download | Resumes in place when Chromium still has it, restarts from the URL otherwise, in the same row |
| Open, Show in Finder/Files | The file icon opens it; the folder button reveals it |
| Drag the file out | Icon and name drag the file itself (`file://` drag payload, copy only) |
| Dangerous-file warning, Keep/Discard | Types that run code when opened on this platform land as `Unconfirmed NNNNNN.crdownload` and wait; Keep renames, Discard deletes. Installers (.dmg, .pkg) are left to Gatekeeper, as Chrome leaves them |
| Save location, "Ask where to save" | Settings > Downloads: Change… and a switch; a save panel for every download |
| Clear the list, remove one | Clear List in the Downloads panel, a row's remove button; files on disk are never touched |
| Persistence across restarts | `downloads` store (`downloads.json`); a download cut off by quitting comes back as retryable |
| "Moved or deleted" | Checked against the disk whenever a row renders |
| A tab that aimed at the download | Goes back to the page it was showing; a new tab with nothing to go back to stays as a new tab |
| Private windows | Their downloads use the private view and land in the same list |
| Save Page As (⌘S / Ctrl+S) | The page's address downloaded again with its cookies, always through the save panel, named after the page's title (HTML only: no "Webpage, Complete") |

Not covered, and why:

- `chrome.downloads.download()` from an extension's service worker has no
  browser, so CEF has no download handler to ask. Unverified which way it
  goes; worth a leg with a real extension.
- Chrome's Safe Browsing verdicts (dangerous URL, uncommon file). Stock CEF
  ships without Safe Browsing, so there are no verdicts to show.

Gates: app `scripts/pages-drive.ts` (real engine: each panel opened by its
chord, searched and an entry opened; a real download shown by its whole name;
pause, resume, cancel, retry, Keep and Discard; the chrome:// routes; restart
and Ask Where to Save), `scripts/pages-shots.ts` (captures plus geometry
assertions for the popover and the three panels, both widths, either
appearance) and, on macOS, `scripts/mac-download-drag.ts` (a finished download
dragged into Finder with the real cursor lands as a copy).
