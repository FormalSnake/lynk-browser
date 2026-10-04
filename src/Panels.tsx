// History, bookmarks and downloads: each a panel over the window, each
// searchable, each one keystroke away, and Esc puts it away. They are
// `<dialog>`s: a floating card under a header bar on libadwaita, a sheet on
// AppKit, and both close on Esc. The search field has the
// caret when a panel opens; Return opens the first match.
import { Platform, Spacing, sendCommand, useEffect, useRef, useState, useStoreValue } from "@nativedesktop/react";
import type { NdNodeRef } from "@nativedesktop/react";

import { DownloadRow, type DownloadActions } from "./Downloads.tsx";
import { bookmarks, bookmarksMatching, removeBookmark } from "./lib/bookmarks.ts";
import { downloadDir, downloads, isActive } from "./lib/downloads.ts";
import { faviconFor } from "./lib/favicons.ts";
import { forgetVisit, visitsMatching, type Visit } from "./lib/history.ts";
import { KEYS } from "./lib/keys.ts";
import { shortcutLabel } from "./lib/omnibox.ts";
import { settings } from "./lib/settings.ts";
import { displayUrl } from "./lib/url.ts";

/// A row is one line of title and one of address, as in the sidebar: a long
/// title is cut at its end, a long address in its middle so the page's own
/// name at the end survives. The lengths are what one line of the panel's
/// fixed width holds at Adwaita's body size, the wider of the two backends;
/// libadwaita wraps a row's title rather than cutting it.
function rowTitle(title: string, url: string): string {
  const t = title || displayUrl(url);
  return t.length > 50 ? `${t.slice(0, 49).trimEnd()}…` : t;
}

function rowAddress(url: string): string {
  const a = displayUrl(url);
  return a.length > 58 ? `${a.slice(0, 36)}…${a.slice(-21)}` : a;
}

/// What a row without a usable favicon shows, so its title stays in line with
/// the rows that have one. Rows take it alongside the favicon: the image wins
/// when the toolkit can draw it, and an icon it cannot decode (an SVG on a GTK
/// without the loader) leaves this in its place instead of an empty gap.
const PLACEHOLDER_ICON = "web-browser-symbolic";

/// The favicon when it is image bytes; a cached entry can still be an address.
function icon(url: string): string | undefined {
  const f = faviconFor(url);
  return f?.startsWith("data:") ? f : undefined;
}

export type Panel = "history" | "bookmarks" | "downloads";

export const PANEL_TITLES: Record<Panel, string> = {
  history: "History",
  bookmarks: "Bookmarks",
  downloads: "Downloads",
};


const WIDTH = 600;
const HEIGHT = 560;

type SearchField = { current: NdNodeRef<"searchinput"> | null };

/// The caret back in the search field. A row's own button that removes the
/// row takes the focus with it, and GTK then leaves it on the window, outside
/// the dialog, where Esc no longer reaches it.
function refocus(field: SearchField): void {
  if (field.current) sendCommand(field.current, "focus");
}

/// What every panel is made of: the dialog, the search field, a scrolling
/// body and a foot. Each panel only says what goes in them.
function Plate({
  panel,
  onClose,
  query,
  onQuery,
  onSubmit,
  placeholder,
  children,
  foot,
  field,
}: {
  panel: Panel;
  onClose: () => void;
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  placeholder: string;
  children: React.ReactNode;
  foot: React.ReactNode;
  field: SearchField;
}): React.ReactNode {
  const focused = useRef(0);
  return (
    <dialog
      testID={`${panel}-panel`}
      open
      title={PANEL_TITLES[panel]}
      contentWidth={WIDTH}
      contentHeight={HEIGHT}
      onClosed={onClose}
    >
      <box orientation="vertical" spacing={Spacing.md} style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}>
        <searchinput
          testID={`${panel}-search`}
          ref={(node) => {
            const n = node as NdNodeRef<"searchinput"> | null;
            field.current = n;
            // Once per field: a ref callback runs on every render.
            if (n && focused.current !== n.id) {
              focused.current = n.id;
              sendCommand(n, "focus");
            }
          }}
          placeholder={placeholder}
          text={query}
          style={{ hexpand: true }}
          onChanged={(e) => onQuery(e.text)}
          onActivate={onSubmit}
        />
        <scrollview testID={`${panel}-scroll`} style={{ hexpand: true, vexpand: true }}>
          <box orientation="vertical" spacing={Spacing.lg} style={{ hexpand: true, padding: { bottom: Spacing.sm } }}>
            {children}
          </box>
        </scrollview>
        <separator />
        <box testID={`${panel}-foot`} orientation="horizontal" spacing={Spacing.sm} style={{ hexpand: true }}>
          {foot}
          {/* libadwaita's header bar carries the close button; a macOS sheet
              has none, and Done is its idiom. */}
          {Platform.backend === "appkit" ? (
            <button testID={`${panel}-done`} label="Done" prominent onClick={onClose} />
          ) : null}
        </box>
      </box>
    </dialog>
  );
}

function Empty({ panel, text }: { panel: Panel; text: string }): React.ReactNode {
  return <label testID={`${panel}-empty`} text={text} cssClasses={["dimmed"]} style={{ halign: "start" }} />;
}

function Count({ panel, text }: { panel: Panel; text: string }): React.ReactNode {
  return (
    <label
      testID={`${panel}-count`}
      text={text}
      variant="caption"
      cssClasses={["dimmed"]}
      style={{ hexpand: true, halign: "start", valign: "center" }}
    />
  );
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" });

function dayOf(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return DAY.format(d);
}

/// Where you have been, by day, newest first.
export function HistoryPanel({
  onClose,
  onOpen,
  onClearData,
  onClearHistory,
}: {
  onClose: () => void;
  onOpen: (url: string) => void;
  /// Cookies, cache and site data are Chromium's, and chrome://settings is
  /// where they are cleared.
  onClearData: () => void;
  onClearHistory: () => Promise<void>;
}): React.ReactNode {
  const [query, setQuery] = useState("");
  const field = useRef<NdNodeRef<"searchinput"> | null>(null);
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [clearing, setClearing] = useState(false);
  const refresh = (q: string): void => void visitsMatching(q, 300).then(setVisits);
  const rows = visits ?? [];
  useEffect(() => refresh(query), [query]);

  const days: { day: string; rows: Visit[] }[] = [];
  for (const v of rows) {
    const day = dayOf(v.ts);
    const last = days[days.length - 1];
    if (last && last.day === day) last.rows.push(v);
    else days.push({ day, rows: [v] });
  }

  return (
    <Plate
      panel="history"
      field={field}
      onClose={onClose}
      query={query}
      onQuery={setQuery}
      onSubmit={() => rows[0] && onOpen(rows[0].url)}
      placeholder="Search everywhere you have been"
      foot={
        clearing ? (
          <>
            <Count panel="history" text="Clearing leaves your bookmarks and downloads alone" />
            <button testID="history-clear-data" label="Cookies and Site Data…" onClick={onClearData} />
            <button
              testID="history-clear-confirm"
              label="Clear History"
              destructive
              onClick={() =>
                void onClearHistory().then(() => {
                  setClearing(false);
                  refresh(query);
                  refocus(field);
                })
              }
            />
            <button
              testID="history-clear-back"
              label="Cancel"
              onClick={() => {
                setClearing(false);
                refocus(field);
              }}
            />
          </>
        ) : (
          <>
            <Count panel="history" text={rows.length === 1 ? "1 page" : `${rows.length} pages`} />
            <button testID="history-clear" label="Clear…" onClick={() => setClearing(true)} />
          </>
        )
      }
    >
      {/* Nothing until the first answer is in: an empty state swapped for the
          list a beat later is a flash, and AppKit lays out the group that
          takes its place wrong. */}
      {visits === null ? null : rows.length === 0 ? (
        <Empty panel="history" text={query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing yet."} />
      ) : (
        days.map(({ day, rows: dayRows }) => (
          <settingsgroup key={day} testID={`history-day-${day}`} title={day}>
            {dayRows.map((v) => (
              <row
                key={v.url}
                testID={`history-row-${v.url}`}
                title={rowTitle(v.title, v.url)}
                subtitle={rowAddress(v.url)}
                iconData={icon(v.url)}
                iconName={PLACEHOLDER_ICON}
                activatable
                onActivate={() => onOpen(v.url)}
              >
                <label
                  slot="suffix"
                  text={CLOCK.format(new Date(v.ts))}
                  variant="caption"
                  cssClasses={["dimmed", "numeric"]}
                  style={{ valign: "center" }}
                />
                <button
                  slot="suffix"
                  testID={`history-remove-${v.url}`}
                  iconName="window-close-symbolic"
                  tooltip="Remove from History"
                  cssClasses={["flat"]}
                  style={{ valign: "center" }}
                  onClick={() =>
                    void forgetVisit(v.url).then(() => {
                      refresh(query);
                      refocus(field);
                    })
                  }
                />
              </row>
            ))}
          </settingsgroup>
        ))
      )}
    </Plate>
  );
}

/// Pages kept on purpose.
export function BookmarksPanel({
  onClose,
  onOpen,
  current,
  onToggleCurrent,
}: {
  onClose: () => void;
  onOpen: (url: string) => void;
  /// The window's own page, which the foot offers to keep or let go.
  current: { url: string; title: string };
  onToggleCurrent: () => void;
}): React.ReactNode {
  useStoreValue(bookmarks);
  const [query, setQuery] = useState("");
  const field = useRef<NdNodeRef<"searchinput"> | null>(null);
  const shown = bookmarksMatching(query);
  const kept = bookmarks.get().items.some((b) => b.url === current.url);
  const bookmarkable = /^https?:/.test(current.url);

  return (
    <Plate
      panel="bookmarks"
      field={field}
      onClose={onClose}
      query={query}
      onQuery={setQuery}
      onSubmit={() => shown[0] && onOpen(shown[0].url)}
      placeholder="Search bookmarks"
      foot={
        <>
          <Count panel="bookmarks" text={shown.length === 1 ? "1 bookmark" : `${shown.length} bookmarks`} />
          {bookmarkable ? (
            <button
              testID="bookmarks-toggle-current"
              label={kept ? "Remove This Page" : "Bookmark This Page"}
              onClick={onToggleCurrent}
            />
          ) : null}
        </>
      }
    >
      {shown.length === 0 ? (
        <Empty
          panel="bookmarks"
          text={
            query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : `No bookmarks yet. ${shortcutLabel(KEYS["bookmark-page"])} keeps the page you are on.`
          }
        />
      ) : (
        <settingsgroup testID="bookmarks-list">
          {shown.map((b) => (
            <row
              key={b.id}
              testID={`bookmarks-row-${b.url}`}
              title={rowTitle(b.title, b.url)}
              subtitle={rowAddress(b.url)}
              iconData={icon(b.url)}
              iconName={PLACEHOLDER_ICON}
              activatable
              onActivate={() => onOpen(b.url)}
            >
              <button
                slot="suffix"
                testID={`bookmarks-remove-${b.url}`}
                iconName="window-close-symbolic"
                tooltip="Remove Bookmark"
                cssClasses={["flat"]}
                style={{ valign: "center" }}
                onClick={() => {
                  removeBookmark(b.url);
                  refocus(field);
                }}
              />
            </row>
          ))}
        </settingsgroup>
      )}
    </Plate>
  );
}

/// Every download, with everything a row can do.
export function DownloadsPanel({ onClose, actions }: { onClose: () => void; actions: DownloadActions }): React.ReactNode {
  const { items } = useStoreValue(downloads);
  const prefs = useStoreValue(settings);
  const [query, setQuery] = useState("");
  const field = useRef<NdNodeRef<"searchinput"> | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((d) => `${d.name} ${d.url}`.toLowerCase().includes(q)) : items;
  // Removing a row takes its button, and the focus, with it.
  const after = <T,>(run: (d: T) => void) => (d: T) => {
    run(d);
    refocus(field);
  };
  const kept: DownloadActions = { ...actions, remove: after(actions.remove), discard: after(actions.discard), keep: after(actions.keep) };
  const clearable = items.some((d) => !isActive(d) && d.state !== "dangerous");
  const folder = downloadDir(prefs.downloadDir);

  return (
    <Plate
      panel="downloads"
      field={field}
      onClose={onClose}
      query={query}
      onQuery={setQuery}
      onSubmit={() => {
        const first = shown.find((d) => d.state === "complete");
        if (first) actions.open(first);
      }}
      placeholder="Search downloads"
      foot={
        <>
          <Count
            panel="downloads"
            text={items.length === 0 ? `Files land in ${folder.slice(folder.lastIndexOf("/") + 1)}` : "Files stay where they are"}
          />
          <button testID="downloads-open-folder" label="Open Folder" onClick={actions.openFolder} />
          <button
            testID="downloads-clear"
            label="Clear List"
            enabled={clearable}
            onClick={() => {
              actions.clear();
              refocus(field);
            }}
          />
        </>
      }
    >
      {shown.length === 0 ? (
        <Empty panel="downloads" text={q ? `Nothing matches “${query.trim()}”.` : "Nothing downloaded yet."} />
      ) : (
        <box orientation="vertical" spacing={Spacing.md} style={{ hexpand: true }}>
          {shown.map((d) => (
            <DownloadRow key={d.id} d={d} actions={kept} prefix="all-" />
          ))}
        </box>
      )}
    </Plate>
  );
}
