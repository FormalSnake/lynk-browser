// The compact layout's tab run: the tabs themselves, drawn in the one toolbar
// row between the reload button and the address field. Shared by the main
// window and a private one, which draw the same row.
import { Platform, Spacing, useState } from "@nativedesktop/react";

/// A tab is about 156pt when the row has space for it. TITLE_FLOOR is where a
/// title is down to a few characters beside the favicon and the close button,
/// which says less than the favicon alone, so a tab drops to its icon there.
/// The active tab never does: it keeps ACTIVE_FLOOR, room for its favicon and
/// the start of its title, and the others give up their titles and then
/// their places first.
const TAB_MAX_WIDTH = 156;
const TITLE_FLOOR = 120;
const ACTIVE_FLOOR = 140;
const ICON_TAB_WIDTH = 36;

/// The address field's minimum. It is a constant rather than anything worked
/// out from the window, because on GTK every minimum in the row adds up to the
/// window's own minimum.
export const ADDRESS_MIN_WIDTH = 160;
/// Where the tabs start giving up width to keep the field readable. Below it
/// only the active tab's title still takes from the field, down to the
/// minimum.
const ADDRESS_FLOOR = 240;

const CLOSE_SLOT_WIDTH = 26;

/// What the row spends on everything that is not a tab or the address field,
/// read off the row at 720 and 1440 px and rounded up, since a guess on the
/// low side hands the tabs room the field needed: the window's own padding
/// and controls (the traffic lights on macOS, three buttons in the row on
/// GTK), back, forward, reload, new tab, and the layout, downloads and menu
/// buttons. Measured 408 on GTK under X11 and 368 on AppKit. The layout
/// button leaves the row below LAYOUT_BUTTON_WIDTH (the View menu and the
/// chord still switch), which gives back LAYOUT_BUTTON. The extensions
/// button and each pinned extension action add FURNITURE_SLOT.
const FURNITURE = { gtk: 412, appkit: 380 } as const;
const FURNITURE_SLOT = 44;
const LAYOUT_BUTTON = 40;
export const LAYOUT_BUTTON_WIDTH = 960;
/// The gap `spacing` puts between two tabs.
const TAB_GAP = Spacing.xs;

export interface CompactTab {
  id: string;
  url: string;
  title: string;
  pinned: boolean;
}

export interface TabRunMetrics {
  /// How wide an unpinned tab other than the active one is.
  width: number;
  /// Whether those tabs draw their titles.
  titled: boolean;
  /// How wide the active tab is. It always draws its title unless it is
  /// pinned.
  activeWidth: number;
  /// The tabs the row draws. A tab that no longer fits at favicon width is
  /// left out of the row rather than squeezed into it; the command bar's tab
  /// switcher still reaches it.
  shown: CompactTab[];
}

/// How wide each tab may be, given the window and how many tabs share the row.
/// Tabs shrink evenly, then the ones that are not active drop to their
/// favicons, then out of the row, before the address field goes under its
/// floor. The widths are what the row ASKS for: on GTK the run sits in a
/// clipping scroller, so a width worked out for a wider window is cut off
/// rather than holding the window at that width.
export function tabRunMetrics(
  windowWidth: number,
  tabs: CompactTab[],
  activeId: string,
  trailing: number,
  backend: "gtk" | "appkit",
): TabRunMetrics {
  const layoutButton = windowWidth < LAYOUT_BUTTON_WIDTH ? LAYOUT_BUTTON : 0;
  const row = windowWidth - FURNITURE[backend] + layoutButton - trailing * FURNITURE_SLOT;
  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);
  const icon = ICON_TAB_WIDTH + TAB_GAP;

  // Every pinned tab at its favicon and every other tab titled, at an even
  // share of what the field leaves above its floor.
  const even = loose.length > 0 ? Math.floor((row - ADDRESS_FLOOR - pinned.length * icon) / loose.length) - TAB_GAP : TAB_MAX_WIDTH;
  if (even >= TITLE_FLOOR) {
    const width = Math.min(TAB_MAX_WIDTH, even);
    return { width, titled: true, activeWidth: width, shown: tabs };
  }

  // The active tab titled, then as many of the rest at their favicons as fit,
  // pinned ones first and then the loose run nearest the active tab.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const titledActive = active !== undefined && !active.pinned;
  const activeWidth = titledActive
    ? Math.max(ICON_TAB_WIDTH, Math.min(ACTIVE_FLOOR, row - ADDRESS_MIN_WIDTH - TAB_GAP))
    : ICON_TAB_WIDTH;
  let room = row - ADDRESS_FLOOR - activeWidth - TAB_GAP;
  const keep = new Set<string>(active ? [active.id] : []);
  for (const t of pinned) {
    if (keep.has(t.id) || room < icon) continue;
    keep.add(t.id);
    room -= icon;
  }
  const at = Math.max(0, loose.findIndex((t) => t.id === active?.id));
  for (let d = 1; d < loose.length && room >= icon; d += 1) {
    for (const i of [at + d, at - d]) {
      const t = loose[i];
      if (!t || keep.has(t.id) || room < icon) continue;
      keep.add(t.id);
      room -= icon;
    }
  }
  return {
    width: ICON_TAB_WIDTH,
    titled: false,
    // What the others leave goes to the active tab, up to a full tab.
    activeWidth: titledActive ? Math.min(TAB_MAX_WIDTH, activeWidth + Math.max(0, room)) : activeWidth,
    shown: tabs.filter((t) => keep.has(t.id)),
  };
}

export interface CompactTabsProps {
  tabs: CompactTab[];
  activeId: string;
  metrics: TabRunMetrics;
  /// TestID prefix, so a private window's row is addressable apart from the
  /// main window's.
  prefix: string;
  iconFor: (url: string) => string | undefined;
  labelFor: (tab: CompactTab) => string;
  addressFor: (tab: CompactTab) => string;
  /// A tab put to sleep, whose chip is drawn dimmed until it wakes.
  asleep?: (id: string) => boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /// What a drag of this tab carries, so the window it lands in can tell
  /// where it came from and whether its page can move.
  dragPayload: (tab: CompactTab) => string;
  /// Where a tab being dragged over the row would land, drawn as a divider
  /// between two tabs; null while nothing is being dragged over it.
  dropIndex: number | null;
  onDragOverIndex: (index: number) => void;
  onDropAt: (payload: string, index: number) => void;
  onDragStart: (payload: string) => void;
  onDragEnd: () => void;
}

/// The slot a point along the row falls in: before the first drawn tab whose
/// middle it has not reached, as an index into every tab. The widths are the
/// ones this file hands out, which is what makes the row's own coordinates
/// enough to answer.
function indexAt(x: number, tabs: CompactTab[], shown: CompactTab[], activeId: string, metrics: TabRunMetrics): number {
  let edge = 0;
  for (const t of shown) {
    const width = tabWidth(t, activeId, metrics);
    if (x < edge + width / 2) return tabs.indexOf(t);
    edge += width + TAB_GAP;
  }
  const last = shown[shown.length - 1];
  return last ? tabs.indexOf(last) + 1 : tabs.length;
}

export function CompactTabs({
  tabs,
  activeId,
  metrics,
  prefix,
  iconFor,
  labelFor,
  addressFor,
  asleep,
  onSelect,
  onClose,
  dragPayload,
  dropIndex,
  onDragOverIndex,
  onDropAt,
  onDragStart,
  onDragEnd,
}: CompactTabsProps): React.ReactNode {
  /// The tab the pointer is on, so its close button can appear. One id rather
  /// than a set, because the pointer is in one place.
  const [hovered, setHovered] = useState("");
  const shownTabs = metrics.shown;

  const gtk = Platform.backend === "gtk";
  const strip = (
    // GTK propagates hexpand up from any child that sets it, so the run would
    // otherwise claim the row's whole free width through the buttons inside
    // it and leave the address field nothing. Stopping it here and on each
    // tab is what keeps the widths this file computes.
    <box
      slot={gtk ? undefined : "start"}
      testID={`${prefix}tab-strip`}
      orientation="horizontal"
      spacing={Spacing.xs}
      // A tab title is body text, not the header bar's bold title: the chip
      // is what marks the selected tab, not the weight.
      style={{ hexpand: false, font: { fontWeight: "normal" } }}
      dropTarget
      onDragOver={(e) => onDragOverIndex(indexAt(e.data.x, tabs, shownTabs, activeId, metrics))}
      onDropped={(e) => {
        const index = indexAt(e.data.x, tabs, shownTabs, activeId, metrics);
        if (process.env.NB_TEST_HOOKS === "1") console.error(`ND_APP DROP ${prefix}tab-strip x=${e.data.x} index=${index}`);
        onDropAt(e.text, index);
      }}
    >
      {shownTabs.flatMap((t) => {
        const i = tabs.indexOf(t);
        const active = t.id === activeId;
        // A pinned tab is its site's icon and nothing else, the way every
        // browser draws one, and it keeps that width however crowded the row
        // gets.
        const titled = !t.pinned && (active || metrics.titled);
        const closable = titled && (active || hovered === t.id);
        const marker =
          dropIndex === i ? [<separator key="drop" testID={`${prefix}tab-drop`} orientation="vertical" />] : [];
        return [
          ...marker,
          <box
            key={t.id}
            testID={`${prefix}tab-slot-${t.id}`}
            orientation="horizontal"
            // The BOX is the chip: one rounded rectangle holding the favicon,
            // the title and the close button. Two linked buttons would draw a
            // seam down the middle of it. An unselected tab draws no chip at
            // all, which is what tells it from the selected one.
            cssClasses={active ? ["card"] : asleep?.(t.id) ? ["dimmed"] : []}
            style={{ minWidth: tabWidth(t, activeId, metrics), valign: "center", hexpand: false }}
            onHoverChanged={(e) => setHovered(e.checked ? t.id : "")}
          >
            <button
              testID={`${prefix}tab-item-${t.id}`}
              label={titled ? labelFor(t) : ""}
              iconData={iconFor(t.url)}
              iconName="web-browser-symbolic"
              labelAlign="start"
              ellipsize
              // A tab narrowed to its favicon has no readable title left, so
              // the tooltip carries both.
              tooltip={titled ? addressFor(t) : `${labelFor(t)} (${addressFor(t)})`}
              cssClasses={["flat"]}
              style={{ hexpand: true }}
              onClick={() => onSelect(t.id)}
              draggable
              dragPayload={dragPayload(t)}
              onDragStarted={(e) => onDragStart(e.text)}
              onDragEnded={onDragEnd}
            />
            {titled &&
              (closable ? (
                <button
                  testID={`${prefix}tab-close-${t.id}`}
                  iconName="window-close-symbolic"
                  tooltip={`Close ${labelFor(t)}`}
                  cssClasses={["flat"]}
                  size="small"
                  style={{ minWidth: CLOSE_SLOT_WIDTH, valign: "center" }}
                  onClick={() => onClose(t.id)}
                />
              ) : (
                // Reserved whether or not the pointer is on the tab, so the
                // title does not reflow as the pointer crosses the row.
                <box orientation="horizontal" style={{ minWidth: CLOSE_SLOT_WIDTH }} />
              ))}
          </box>,
        ];
      })}
      {dropIndex === tabs.length && <separator testID={`${prefix}tab-drop`} orientation="vertical" />}
    </box>
  );
  // The widths above come from the window's width, and on GTK every minimum
  // in a header bar adds up to the window's minimum: drawn straight into the
  // row, a run sized for a wide window would stop it ever getting narrower.
  // The clipping scroller asks for the run's width without making it a
  // minimum, and cuts the run off in the moment before a narrower window's
  // widths arrive. The AppKit toolbar gives every item the width it asks for
  // and never holds the window, so the run goes in as it is.
  return gtk ? (
    <scrollview slot="start" testID={`${prefix}tab-clip`} hscroll="clip">
      {strip}
    </scrollview>
  ) : (
    strip
  );
}

function tabWidth(t: CompactTab, activeId: string, metrics: TabRunMetrics): number {
  if (t.pinned) return ICON_TAB_WIDTH;
  return t.id === activeId ? metrics.activeWidth : metrics.width;
}
