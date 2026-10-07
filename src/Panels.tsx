// History, bookmarks and downloads: each a panel over the window, each
// searchable, each one keystroke away, and Esc puts it away. They are
// `<dialog>`s: a floating card under a header bar on libadwaita, a sheet on
// AppKit, and both close on Esc. The search field has the
// caret when a panel opens; Return opens the first match.
import { Platform, Spacing, sendCommand, useStoreValue } from "@nativedesktop/react";
import type { JSX, NdNodeRef } from "@nativedesktop/react";
import { For, Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";

import { DownloadRow, type DownloadActions } from "./Downloads.tsx";
import { bookmarks, bookmarksMatching, removeBookmark } from "./lib/bookmarks.ts";
import { downloadDir, downloads, isActive } from "./lib/downloads.ts";
import { trackStore } from "./lib/live.ts";
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
function Plate(props: {
  panel: Panel;
  onClose: () => void;
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  placeholder: string;
  children: JSX.Element;
  foot: JSX.Element;
  field: SearchField;
}) {
  let node!: NdNodeRef<"searchinput">;
  // The field has the caret when the panel opens.
  onSettled(() => {
    props.field.current = node;
    sendCommand(node, "focus");
    return () => {
      if (props.field.current === node) props.field.current = null;
    };
  });
  return (
    <dialog
      testID={`${props.panel}-panel`}
      open
      title={PANEL_TITLES[props.panel]}
      contentWidth={WIDTH}
      contentHeight={HEIGHT}
      onClosed={() => props.onClose()}
    >
      <box orientation="vertical" spacing={Spacing.md} style={{ padding: Spacing.lg, hexpand: true, vexpand: true }}>
        <searchinput
          testID={`${props.panel}-search`}
          ref={node}
          placeholder={props.placeholder}
          text={props.query}
          style={{ hexpand: true }}
          onChanged={(e) => props.onQuery(e.text)}
          onActivate={() => props.onSubmit()}
        />
        <scrollview testID={`${props.panel}-scroll`} style={{ hexpand: true, vexpand: true }}>
          <box orientation="vertical" spacing={Spacing.lg} style={{ hexpand: true, padding: { bottom: Spacing.sm } }}>
            {props.children}
          </box>
        </scrollview>
        <separator />
        <box testID={`${props.panel}-foot`} orientation="horizontal" spacing={Spacing.sm} style={{ hexpand: true }}>
          {props.foot}
          {/* libadwaita's header bar carries the close button; a macOS sheet
              has none, and Done is its idiom. */}
          <Show when={Platform.backend === "appkit"}>
            <button testID={`${props.panel}-done`} label="Done" prominent onClick={() => props.onClose()} />
          </Show>
        </box>
      </box>
    </dialog>
  );
}

function Empty(props: { panel: Panel; text: string }) {
  return <label testID={`${props.panel}-empty`} text={props.text} cssClasses={["dimmed"]} style={{ halign: "start" }} />;
}

function Count(props: { panel: Panel; text: string }) {
  return (
    <label
      testID={`${props.panel}-count`}
      text={props.text}
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
export function HistoryPanel(props: {
  onClose: () => void;
  onOpen: (url: string) => void;
  /// Cookies, cache and site data are Chromium's, and chrome://settings is
  /// where they are cleared.
  onClearData: () => void;
  onClearHistory: () => Promise<void>;
}) {
  const [query, setQuery] = createSignal("");
  const field: SearchField = { current: null };
  const [visits, setVisits] = createSignal<Visit[] | null>(null);
  const [clearing, setClearing] = createSignal(false);
  /// The latest lookup asked for; an older answer that lands late is dropped.
  let asked = 0;
  const refresh = (q: string): void => {
    const ask = ++asked;
    void visitsMatching(q, 300).then((v) => {
      if (ask === asked) setVisits(v);
    });
  };
  const rows = (): Visit[] => visits() ?? [];
  createEffect(query, (q) => refresh(q));

  const days = createMemo(() => {
    const out: { day: string; rows: Visit[] }[] = [];
    for (const v of rows()) {
      const day = dayOf(v.ts);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(v);
      else out.push({ day, rows: [v] });
    }
    return out;
  });

  return (
    <Plate
      panel="history"
      field={field}
      onClose={props.onClose}
      query={query()}
      onQuery={setQuery}
      onSubmit={() => {
        const first = rows()[0];
        if (first) props.onOpen(first.url);
      }}
      placeholder="Search everywhere you have been"
      foot={
        <Show
          when={clearing()}
          fallback={
            <>
              <Count panel="history" text={rows().length === 1 ? "1 page" : `${rows().length} pages`} />
              <button testID="history-clear" label="Clear…" onClick={() => setClearing(true)} />
            </>
          }
        >
          <Count panel="history" text="Clearing leaves your bookmarks and downloads alone" />
          <button testID="history-clear-data" label="Cookies and Site Data…" onClick={() => props.onClearData()} />
          <button
            testID="history-clear-confirm"
            label="Clear History"
            destructive
            onClick={() =>
              void props.onClearHistory().then(() => {
                setClearing(false);
                refresh(query());
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
        </Show>
      }
    >
      {/* Nothing until the first answer is in: an empty state swapped for the
          list a beat later is a flash, and AppKit lays out the group that
          takes its place wrong. */}
      <Show when={visits() !== null}>
        <For
          each={days()}
          keyed={(d) => d.day}
          fallback={<Empty panel="history" text={query().trim() ? `Nothing matches “${query().trim()}”.` : "Nothing yet."} />}
        >
          {(day) => (
            <settingsgroup testID={`history-day-${day().day}`} title={day().day}>
              <For each={day().rows} keyed={(v) => v.url}>
                {(v) => (
                  <row
                    testID={`history-row-${v().url}`}
                    title={rowTitle(v().title, v().url)}
                    subtitle={rowAddress(v().url)}
                    iconData={icon(v().url)}
                    iconName={PLACEHOLDER_ICON}
                    activatable
                    onActivate={() => props.onOpen(v().url)}
                  >
                    <label
                      slot="suffix"
                      text={CLOCK.format(new Date(v().ts))}
                      variant="caption"
                      cssClasses={["dimmed", "numeric"]}
                      style={{ valign: "center" }}
                    />
                    <button
                      slot="suffix"
                      testID={`history-remove-${v().url}`}
                      iconName="window-close-symbolic"
                      tooltip="Remove from History"
                      cssClasses={["flat"]}
                      style={{ valign: "center" }}
                      onClick={() =>
                        void forgetVisit(v().url).then(() => {
                          refresh(query());
                          refocus(field);
                        })
                      }
                    />
                  </row>
                )}
              </For>
            </settingsgroup>
          )}
        </For>
      </Show>
    </Plate>
  );
}

/// Pages kept on purpose.
export function BookmarksPanel(props: {
  onClose: () => void;
  onOpen: (url: string) => void;
  /// The window's own page, which the foot offers to keep or let go.
  current: { url: string; title: string };
  onToggleCurrent: () => void;
}) {
  const marks = useStoreValue(bookmarks);
  const [query, setQuery] = createSignal("");
  const field: SearchField = { current: null };
  const shown = createMemo(() => {
    marks();
    return bookmarksMatching(query());
  });
  const kept = (): boolean => marks().items.some((b) => b.url === props.current.url);
  const bookmarkable = (): boolean => /^https?:/.test(props.current.url);

  return (
    <Plate
      panel="bookmarks"
      field={field}
      onClose={props.onClose}
      query={query()}
      onQuery={setQuery}
      onSubmit={() => {
        const first = shown()[0];
        if (first) props.onOpen(first.url);
      }}
      placeholder="Search bookmarks"
      foot={
        <>
          <Count panel="bookmarks" text={shown().length === 1 ? "1 bookmark" : `${shown().length} bookmarks`} />
          <Show when={bookmarkable()}>
            <button
              testID="bookmarks-toggle-current"
              label={kept() ? "Remove This Page" : "Bookmark This Page"}
              onClick={() => props.onToggleCurrent()}
            />
          </Show>
        </>
      }
    >
      <Show
        when={shown().length > 0}
        fallback={
          <Empty
            panel="bookmarks"
            text={
              query().trim()
                ? `Nothing matches “${query().trim()}”.`
                : `No bookmarks yet. ${shortcutLabel(KEYS["bookmark-page"])} keeps the page you are on.`
            }
          />
        }
      >
        <settingsgroup testID="bookmarks-list">
          <For each={shown()} keyed={(b) => b.id}>
            {(b) => (
              <row
                testID={`bookmarks-row-${b().url}`}
                title={rowTitle(b().title, b().url)}
                subtitle={rowAddress(b().url)}
                iconData={icon(b().url)}
                iconName={PLACEHOLDER_ICON}
                activatable
                onActivate={() => props.onOpen(b().url)}
              >
                <button
                  slot="suffix"
                  testID={`bookmarks-remove-${b().url}`}
                  iconName="window-close-symbolic"
                  tooltip="Remove Bookmark"
                  cssClasses={["flat"]}
                  style={{ valign: "center" }}
                  onClick={() => {
                    removeBookmark(b().url);
                    refocus(field);
                  }}
                />
              </row>
            )}
          </For>
        </settingsgroup>
      </Show>
    </Plate>
  );
}

/// Every download, with everything a row can do.
export function DownloadsPanel(props: { onClose: () => void; actions: DownloadActions }) {
  const list = trackStore(downloads);
  const prefs = trackStore(settings);
  const [query, setQuery] = createSignal("");
  const field: SearchField = { current: null };
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? list.items.filter((d) => `${d.name} ${d.url}`.toLowerCase().includes(q)) : list.items;
  });
  // Removing a row takes its button, and the focus, with it.
  const after = <T,>(run: (d: T) => void) => (d: T) => {
    run(d);
    refocus(field);
  };
  const kept: DownloadActions = {
    ...props.actions,
    remove: after(props.actions.remove),
    discard: after(props.actions.discard),
    keep: after(props.actions.keep),
  };
  const clearable = (): boolean => list.items.some((d) => !isActive(d) && d.state !== "dangerous");
  const folder = (): string => downloadDir(prefs.downloadDir);

  return (
    <Plate
      panel="downloads"
      field={field}
      onClose={props.onClose}
      query={query()}
      onQuery={setQuery}
      onSubmit={() => {
        const first = shown().find((d) => d.state === "complete");
        if (first) props.actions.open(first);
      }}
      placeholder="Search downloads"
      foot={
        <>
          <Count
            panel="downloads"
            text={list.items.length === 0 ? `Files land in ${folder().slice(folder().lastIndexOf("/") + 1)}` : "Files stay where they are"}
          />
          <button testID="downloads-open-folder" label="Open Folder" onClick={() => props.actions.openFolder()} />
          <button
            testID="downloads-clear"
            label="Clear List"
            enabled={clearable()}
            onClick={() => {
              props.actions.clear();
              refocus(field);
            }}
          />
        </>
      }
    >
      <Show
        when={shown().length > 0}
        fallback={<Empty panel="downloads" text={query().trim() ? `Nothing matches “${query().trim()}”.` : "Nothing downloaded yet."} />}
      >
        <box orientation="vertical" spacing={Spacing.md} style={{ hexpand: true }}>
          <For each={shown()} keyed={(d) => d.id}>
            {(d) => <DownloadRow d={d()} actions={kept} prefix="all-" />}
          </For>
        </box>
      </Show>
    </Plate>
  );
}
