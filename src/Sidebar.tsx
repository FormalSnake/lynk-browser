// The sidebar layout's column (docs/sidebar.md): the window's own controls in
// the first row, pinned tabs as small tiles, a flat list of the rest, a quiet
// "New tab" row, and a few small glyphs at the foot. Navigation and the
// address live on the keyboard and the command bar, not here. Everything a
// popover hangs off is handed in by the window, which owns those popovers'
// state.
import { Platform, useState } from "@nativedesktop/react";
import { Activity } from "react";

import type { MenuEntry } from "@nativedesktop/react";
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
/// AppKit: the column's leading and trailing margin, and the traffic lights'
/// gap from the window's left edge and from its top, which a toolbar window
/// gives them (Search's 19 pt). The first row is 32 tall and the close button
/// 14, so a top padding of 10 puts its top edge the same 19 down.
const MAC_MARGIN = 19;
const MAC_TOP = MAC_MARGIN + 7 - 16;
/// Pinned tiles are Arc's favourites grid: the row spans the column's
/// content width, with as many columns as fit at PIN_MIN_WIDTH (three in a
/// 720 pt window, four from about 900), never more than four, and each tile
/// as tall as Arc's (80 x 108 px in the owner's reference, 0.74 of its
/// width). The box lays it out natively, so a resized sidebar reflows it in
/// the same pass.
const PIN_MIN_WIDTH = 40;
const PIN_MAX_COLUMNS = 4;
const PIN_ASPECT = 0.74;
const PIN_GAP = 6;
/// The width the row's trailing glyph (close, or the load spinner) takes,
/// reserved on every row so a title does not reflow as the pointer crosses
/// the list.
const TRAIL_WIDTH = 24;
/// Row titles are body text. Adwaita sets its button labels bold, and a
/// tab's weight is not what marks it selected; the row's fill is.
const REGULAR = { fontWeight: "normal" } as const;

/// `list` with `id` moved to slot `to`.
function moveTo<T extends { id: string }>(list: T[], id: string, to: number): T[] {
  const item = list.find((t) => t.id === id);
  if (!item) return list;
  const rest = list.filter((t) => t.id !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, item);
  return rest;
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
  /// A tab put to sleep, whose row or tile is drawn dimmed until it wakes.
  asleep: (id: string) => boolean;
  /// The small glyphs at the foot: the padlock with its site-info popover,
  /// the page zoom while it is not 100%, the extension actions, downloads.
  siteInfo: React.ReactNode;
  zoom: React.ReactNode;
  extensions: React.ReactNode;
  downloads: React.ReactNode;
  /// A secondary window's own menu, in the foot.
  windowMenu: React.ReactNode;

  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /// A tab's right-click menu, and the item picked from it.
  menuFor: (tab: SessionTab) => MenuEntry[];
  onMenu: (tab: SessionTab, id: string) => void;
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
  /// A pinned tile dragged over the others: the tiles are drawn with it in
  /// the slot under the pointer, the others moved aside, until a drop in the
  /// block commits that order or the drag ends anywhere else (Escape, or
  /// outside the window), which puts them back.
  const [dragging, setDragging] = useState("");
  const [reorder, setReorder] = useState<{ id: string; to: number } | null>(null);
  const shown = reorder ? moveTo(pinned, reorder.id, reorder.to) : pinned;

  /// A drop in the pinned block: a tile dragged within it lands in the slot
  /// it was shown in, anything else is pinned at the end.
  function dropPinned(payload: string): void {
    if (reorder && pinned.some((t) => t.id === reorder.id)) {
      const from = pinned.findIndex((t) => t.id === reorder.id);
      const to = Math.min(reorder.to, pinned.length - 1);
      setReorder(null);
      if (from === to) return;
      // An index into the whole list, before which the tab is put back.
      props.onDropAt(payload, tabs.indexOf(pinned[to]!) + (from < to ? 1 : 0), true);
      return;
    }
    props.onDropAt(payload, pinned.length, true);
  }

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

  function sleeping(t: SessionTab): string[] {
    return props.asleep(t.id) ? ["dimmed"] : [];
  }

  function pin(t: SessionTab, slot: number): React.ReactNode {
    const live = t.id === activeId;
    const icon = props.pinStyle === "icons" ? props.iconFor(t.url) : undefined;
    return (
      <box
        key={t.id}
        testID={`${p}tab-slot-${t.id}`}
        orientation="horizontal"
        // No gap for the empty live marker, which would push the mark off
        // the tile's centre.
        spacing={0}
        // AppKit: each tile its own glass pill, the one on show raised and
        // brighter. GTK keeps the flat tile.
        cssClasses={[...(gtk ? ["view"] : live ? ["view", "glass", "raised"] : ["view", "glass"]), ...sleeping(t)]}
        dropTarget
        onDragOver={() => {
          if (dragging && (reorder?.to ?? -1) !== slot) setReorder({ id: dragging, to: slot });
        }}
        onDropped={(e) => dropPinned(e.text)}
      >
        <button
          testID={`${p}tab-${t.id}`}
          iconData={icon}
          label={icon ? undefined : monogram(props.labelFor(t))}
          tooltip={props.labelFor(t)}
          cssClasses={live ? ["flat"] : ["flat", "dimmed"]}
          // Adwaita's side padding would make a column wider than a
          // letter or an icon needs, and cost the grid a column.
          style={{ hexpand: true, valign: "fill", font: REGULAR, padding: gtk ? { left: 0, right: 0 } : undefined }}
          onClick={() => pick(t)}
          contextMenu={props.menuFor(t)}
          onContextMenuSelected={(e) => props.onMenu(t, e.text)}
          {...drag(t)}
          onDragStarted={(e: { text: string }) => {
            setDragging(t.id);
            props.onDragStart(e.text);
          }}
          onDragEnded={() => {
            setDragging("");
            setReorder(null);
            props.onDragEnd();
          }}
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
        cssClasses={live ? ["view"] : ["activatable", ...sleeping(t)]}
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
          contextMenu={props.menuFor(t)}
          onContextMenuSelected={(e) => props.onMenu(t, e.text)}
          {...drag(t)}
        />
        {trail}
      </box>,
    ];
  }

  const looseEnd = loose.length === 0 ? -1 : tabs.indexOf(loose[loose.length - 1]!) + 1;

  return (
    <box
      slot="sidebar"
      testID={`${p}sidebar`}
      orientation="vertical"
      spacing={0}
      style={{
        vexpand: true,
        padding: gtk
          ? { top: INSET, left: INSET, right: INSET, bottom: INSET }
          : { top: MAC_TOP, left: MAC_MARGIN, right: MAC_MARGIN, bottom: MAC_TOP },
      }}
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
            orientation="horizontal"
            spacing={PIN_GAP}
            tileMinWidth={PIN_MIN_WIDTH}
            tileMaxColumns={PIN_MAX_COLUMNS}
            tileAspect={PIN_ASPECT}
            style={{ margin: { top: leadingControls ? 8 : 0, bottom: 10 } }}
            dropTarget
            onDropped={(e) => dropPinned(e.text)}
          >
            {shown.map(pin)}
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
        {props.zoom}
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
