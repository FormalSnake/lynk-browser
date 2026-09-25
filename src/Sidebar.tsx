// The sidebar layout's column (docs/sidebar.md): the window's own controls in
// the first row, pinned tabs as small tiles, a flat list of the rest, a quiet
// "New tab" row, and a few small glyphs at the foot. Navigation and the
// address live on the keyboard and the command bar, not here. Everything a
// popover hangs off is handed in by the window, which owns those popovers'
// state.
import { Platform, useState } from "@nativedesktop/react";
import { Activity } from "react";

import type { SessionTab } from "./lib/session.ts";
import type { PinStyle } from "./lib/settings.ts";

/// One tab row: a 16 pt favicon and a line of body text with air around it.
export const TAB_ROW_HEIGHT = 28;
/// The gap between two rows.
const ROW_GAP = 2;
/// The sidebar's padding. On GTK it is also the page card's inset from the
/// window (the framework's card margin), so the first row and the card's top
/// edge line up and the gaps around the card read as one.
export const INSET = 8;
/// A pinned tile's height, and its width while three share a row.
const PIN_HEIGHT = 34;
const PIN_GAP = 4;
/// A floor above any tile's natural width, given to tiles and to the fillers
/// of a short last row alike: expanding boxes share the spare width equally
/// on top of their natural width, so equal floors make equal tiles.
const PIN_FLOOR = 52;
/// The width the row's trailing glyph (close, or the load spinner) takes,
/// reserved on every row so a title does not reflow as the pointer crosses
/// the list.
const TRAIL_WIDTH = 24;
/// Row titles are body text. Adwaita sets its button labels bold, and a
/// tab's weight is not what marks it selected; the row's fill is.
const REGULAR = { fontWeight: "normal" } as const;

/// Three tiles to a row up to six pins, then one more column per two pins,
/// so the block stays two rows deep as long as it can.
function pinColumns(count: number): number {
  return Math.max(3, Math.ceil(count / 2));
}

/// The letter a tile shows when the site has no icon yet.
function monogram(label: string): string {
  const ch = label.replace(/^www\./, "").trim().charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

export interface SidebarProps {
  /// TestID prefix; see BrowserWindow.
  p: string;
  tabs: SessionTab[];
  activeId: string;
  /// Whether the tab on show is loading, which its row says with a spinner.
  loading: boolean;
  labelFor: (tab: SessionTab) => string;
  addressFor: (tab: SessionTab) => string;
  iconFor: (url: string) => string | undefined;
  /// Whether a tile shows the site's icon or only its first letter.
  pinStyle: PinStyle;
  /// The small glyphs at the foot: the padlock with its site-info popover,
  /// the extension actions, downloads.
  siteInfo: React.ReactNode;
  extensions: React.ReactNode;
  downloads: React.ReactNode;
  /// A secondary window's own menu, in the foot.
  windowMenu: React.ReactNode;

  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /// A click on the row already on show opens the command bar on its
  /// address, the one place the address is edited.
  onOpenAddress: () => void;
  onOpenSettings: () => void;
  dragPayload: (tab: SessionTab) => string;
  /// Where a dragged tab would land, as an index into `tabs`; null while no
  /// drag is over the column.
  dropIndex: number | null;
  onDragOverIndex: (index: number) => void;
  /// `pinned` is the section the drop landed in, which the tab joins.
  onDropAt: (payload: string, index: number, pinned: boolean) => void;
  onDragStart: (payload: string) => void;
  onDragEnd: () => void;
}

export function Sidebar(props: SidebarProps): React.ReactNode {
  const { p, tabs, activeId } = props;
  const gtk = Platform.backend === "gtk";
  /// A row's content inset. Adwaita's flat buttons carry their own padding;
  /// AppKit's borderless ones draw their icon at the frame's edge.
  const rowInset = gtk ? 0 : 6;
  /// The row the pointer is on, so its close button can appear.
  const [hovered, setHovered] = useState("");
  /// Whether the desktop puts any window controls on the leading side. With
  /// none there (GNOME's trailing layout, or none at all on a tiling
  /// compositor) the row would be empty air, so it hides.
  const [leadingControls, setLeadingControls] = useState(!gtk);

  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);
  const cols = pinColumns(pinned.length);

  function pick(t: SessionTab): void {
    if (t.id === activeId) props.onOpenAddress();
    else props.onSelect(t.id);
  }

  /// A slot in the list, as an index into the whole tab list: before the row
  /// whose middle the point has not reached.
  function slotAt(y: number): number {
    const step = TAB_ROW_HEIGHT + ROW_GAP;
    const i = Math.max(0, Math.min(loose.length, Math.floor((y + step / 2) / step)));
    if (loose.length === 0) return tabs.length;
    return i < loose.length ? tabs.indexOf(loose[i]!) : tabs.indexOf(loose[loose.length - 1]!) + 1;
  }

  function drag(t: SessionTab) {
    return {
      draggable: true,
      dragPayload: props.dragPayload(t),
      onDragStarted: (e: { text: string }) => props.onDragStart(e.text),
      onDragEnded: props.onDragEnd,
    };
  }

  function pin(t: SessionTab): React.ReactNode {
    const live = t.id === activeId;
    const icon = props.pinStyle === "icons" ? props.iconFor(t.url) : undefined;
    return (
      <box
        key={t.id}
        testID={`${p}tab-slot-${t.id}`}
        orientation="horizontal"
        cssClasses={["view"]}
        style={{ hexpand: true, minHeight: PIN_HEIGHT, minWidth: PIN_FLOOR }}
      >
        <button
          testID={`${p}tab-${t.id}`}
          iconData={icon}
          label={icon ? undefined : monogram(props.labelFor(t))}
          tooltip={props.labelFor(t)}
          cssClasses={live ? ["flat"] : ["flat", "dimmed"]}
          style={{ hexpand: true, valign: "fill", font: REGULAR }}
          onClick={() => pick(t)}
          {...drag(t)}
        />
        {/* Draws nothing: the tree's only record of which tile is on show,
            since a tile has no close button to carry it. */}
        {live && <box testID={`${p}tab-live-${t.id}`} orientation="horizontal" />}
      </box>
    );
  }

  function row(t: SessionTab): React.ReactNode[] {
    const live = t.id === activeId;
    const pointed = hovered === t.id;
    const index = tabs.indexOf(t);
    const marker =
      props.dropIndex === index ? [<separator key={`drop-${t.id}`} testID={`${p}tab-drop`} orientation="horizontal" />] : [];
    let trail: React.ReactNode = <box orientation="horizontal" style={{ minWidth: TRAIL_WIDTH }} />;
    if (live && props.loading && !pointed) {
      trail = <spinner testID={`${p}tab-spinner-${t.id}`} spinning style={{ minWidth: TRAIL_WIDTH, valign: "center", halign: "center" }} />;
    } else if (live || pointed) {
      trail = (
        <button
          testID={`${p}tab-close-${t.id}`}
          iconName="window-close-symbolic"
          tooltip={`Close ${props.labelFor(t)}`}
          cssClasses={["flat", "dimmed"]}
          size="small"
          style={{ minWidth: TRAIL_WIDTH, valign: "center" }}
          onClick={() => props.onClose(t.id)}
        />
      );
    }
    return [
      ...marker,
      <box
        key={t.id}
        testID={`${p}tab-slot-${t.id}`}
        orientation="horizontal"
        // The tab on show is the one filled row; the rest only answer the
        // pointer, and read in the quieter ink.
        cssClasses={live ? ["view"] : ["activatable"]}
        style={{ minHeight: TAB_ROW_HEIGHT, hexpand: true, padding: { left: rowInset, right: 2 } }}
        onHoverChanged={(e) => setHovered(e.checked ? t.id : "")}
      >
        <button
          testID={`${p}tab-${t.id}`}
          label={props.labelFor(t)}
          iconData={props.iconFor(t.url)}
          iconName="web-browser-symbolic"
          labelAlign="start"
          ellipsize
          tooltip={props.addressFor(t)}
          cssClasses={live ? ["flat", "body"] : ["flat", "body", "dimmed"]}
          style={{ hexpand: true, valign: "center", font: REGULAR }}
          onClick={() => pick(t)}
          {...drag(t)}
        />
        {trail}
      </box>,
    ];
  }

  const pinRows: SessionTab[][] = [];
  for (let i = 0; i < pinned.length; i += cols) pinRows.push(pinned.slice(i, i + cols));
  const looseEnd = loose.length === 0 ? -1 : tabs.indexOf(loose[loose.length - 1]!) + 1;

  return (
    <box
      slot="sidebar"
      testID={`${p}sidebar`}
      orientation="vertical"
      spacing={0}
      style={{ vexpand: true, padding: { top: INSET, left: INSET, right: INSET, bottom: INSET } }}
    >
      {/* The window's controls, where the desktop puts them on the leading
          side (all three on macOS); the rest of the row moves the window.
          Trailing ones sit over the page's top right, in the window's strip
          (BrowserWindow). Hidden rather than unmounted when there are none,
          so a change of the setting is still heard. */}
      <Activity mode={leadingControls ? "visible" : "hidden"}>
        <box testID={`${p}controls-row`} orientation="horizontal" windowHandle style={{ minHeight: 32 }}>
          <windowcontrols
            testID={`${p}controls-start`}
            side="start"
            style={{ valign: "center" }}
            onEmptyChanged={(e) => setLeadingControls(!e.checked)}
          />
          <box testID={`${p}controls-gap`} orientation="horizontal" style={{ hexpand: true }} />
        </box>
      </Activity>

      {/* Every tab, pinned and not, under one node: the pinned block stays put
          while the rows under it scroll. */}
      <box testID={`${p}tab-list`} orientation="vertical" style={{ vexpand: true }}>
        {pinned.length > 0 && (
          <box
            testID={`${p}pinned-tabs`}
            orientation="vertical"
            spacing={PIN_GAP}
            style={{ margin: { top: leadingControls ? 8 : 0, bottom: 10 } }}
            dropTarget
            onDropped={(e) => props.onDropAt(e.text, pinned.length, true)}
          >
            {pinRows.map((line, r) => (
              <box key={r} orientation="horizontal" spacing={PIN_GAP} style={{ hexpand: true }}>
                {line.map(pin)}
                {/* A short last row keeps every tile the same width. */}
                {Array.from({ length: cols - line.length }, (_, i) => (
                  <box key={`fill-${i}`} orientation="horizontal" style={{ hexpand: true, minWidth: PIN_FLOOR }} />
                ))}
              </box>
            ))}
          </box>
        )}

        <scrollview testID={`${p}tab-scroll`} hscroll="never" style={{ vexpand: true, margin: { top: pinned.length > 0 || !leadingControls ? 0 : 8 } }}>
          <box testID={`${p}tab-rows`} orientation="vertical" spacing={ROW_GAP} style={{ hexpand: true }}>
            <box
              testID={`${p}today-tabs`}
              orientation="vertical"
              spacing={ROW_GAP}
              style={{ hexpand: true }}
              dropTarget
              onDragOver={(e) => props.onDragOverIndex(slotAt(e.data.y))}
              onDropped={(e) => props.onDropAt(e.text, slotAt(e.data.y), false)}
            >
              {loose.flatMap(row)}
              {props.dropIndex !== null && props.dropIndex === looseEnd && (
                <separator testID={`${p}tab-drop`} orientation="horizontal" />
              )}
            </box>
            {/* The quiet "New tab" row. GNOME's idiom is the bare plus in the
                foot instead, which is where the GTK build puts it. */}
            {!gtk && (
              <button
                testID={`${p}new-tab`}
                label="New tab"
                iconName="list-add-symbolic"
                labelAlign="start"
                cssClasses={["flat", "body", "dim-label"]}
                style={{ hexpand: true, minHeight: TAB_ROW_HEIGHT, font: REGULAR, margin: { left: rowInset } }}
                onClick={props.onNewTab}
              />
            )}
          </box>
        </scrollview>
      </box>

      {/* The foot: small glyphs, settings first on macOS; on GTK downloads
          lead and the New Tab plus closes the row. */}
      <box testID={`${p}bottom-bar`} orientation="horizontal" spacing={2}>
        {gtk && props.downloads}
        <button
          testID={`${p}sidebar-settings`}
          iconName="emblem-system-symbolic"
          tooltip="Settings"
          cssClasses={["flat", "dimmed"]}
          style={{ valign: "center" }}
          onClick={props.onOpenSettings}
        />
        {props.siteInfo}
        {props.extensions}
        {!gtk && props.downloads}
        {props.windowMenu}
        <box orientation="horizontal" style={{ hexpand: true }} />
        {gtk && (
          <button
            testID={`${p}new-tab`}
            iconName="list-add-symbolic"
            tooltip="New Tab"
            cssClasses={["flat"]}
            style={{ valign: "center" }}
            onClick={props.onNewTab}
          />
        )}
      </box>
    </box>
  );
}
