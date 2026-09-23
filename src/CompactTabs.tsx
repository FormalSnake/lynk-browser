// The compact layout's tab run: the tabs themselves, drawn in the one toolbar
// row between the reload button and the address field. Shared by the main
// window and a private one, which draw the same row.
import { Spacing, useState } from "@nativedesktop/react";

/// A tab is about 156pt when the row has space for it. TITLE_FLOOR is where a
/// title has shrunk to two characters and an ellipsis, which says less than
/// the favicon alone, so the tab drops to its icon there.
const TAB_MAX_WIDTH = 156;
const TITLE_FLOOR = 88;
const ICON_TAB_WIDTH = 36;

/// The floor the address field keeps whatever the tabs are doing.
export const ADDRESS_MIN_WIDTH = 240;

const CLOSE_SLOT_WIDTH = 26;

/// What the row spends on everything that is not a tab, measured off a capture
/// at 1270 px rather than guessed: LEADING covers the window's own padding,
/// back, forward, reload, the new-tab button and the padlock; TRAILING covers
/// the extensions, downloads, layout and menu buttons plus the window
/// controls. One pinned extension action adds TRAILING_SLOT.
const LEADING = 300;
const TRAILING = 280;
const TRAILING_SLOT = 36;
/// The gap `spacing` puts between two tabs.
const TAB_GAP = Spacing.xs;

export interface CompactTab {
  id: string;
  url: string;
  title: string;
  pinned: boolean;
}

export interface TabRunMetrics {
  width: number;
  titled: boolean;
  /// What the address field has to be SET to. The host promotes a search
  /// entry packed into a header bar to the title widget and sets hexpand on
  /// it (NativeDesktop src/generated/widgets.zig:5183-5186), but the title
  /// slot is still sized from the widget's natural width, so the field sits
  /// at its floor with the rest of the row left empty. Until the framework
  /// has a way to make that slot expand, the app works out the leftover
  /// itself.
  addressWidth: number;
}

/// How wide one tab may be, given the window and how many tabs share the row.
/// Tabs shrink evenly and the address field keeps its floor: the row gives up
/// titles, and then everything but the favicon, before the field narrows.
export function tabRunMetrics(windowWidth: number, tabs: CompactTab[], trailing: number): TabRunMetrics {
  const pinned = tabs.filter((t) => t.pinned).length;
  const loose = tabs.length - pinned;
  const furniture = LEADING + TRAILING + trailing * TRAILING_SLOT;
  const pinnedRun = pinned * (ICON_TAB_WIDTH + TAB_GAP);
  if (loose <= 0) {
    return {
      width: TAB_MAX_WIDTH,
      titled: true,
      addressWidth: Math.max(ADDRESS_MIN_WIDTH, windowWidth - furniture - pinnedRun),
    };
  }
  const run = windowWidth - furniture - ADDRESS_MIN_WIDTH - pinnedRun;
  const width = Math.max(ICON_TAB_WIDTH, Math.min(TAB_MAX_WIDTH, Math.floor(run / loose) - TAB_GAP));
  const used = pinnedRun + loose * (width + TAB_GAP);
  return {
    width,
    titled: width >= TITLE_FLOOR,
    addressWidth: Math.max(ADDRESS_MIN_WIDTH, windowWidth - furniture - used),
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

/// The slot a point along the row falls in: before the first tab whose
/// middle it has not reached. The widths are the ones this file hands out,
/// which is what makes the row's own coordinates enough to answer.
function indexAt(x: number, tabs: CompactTab[], metrics: TabRunMetrics): number {
  let edge = 0;
  for (let i = 0; i < tabs.length; i++) {
    const width = tabs[i]!.pinned ? ICON_TAB_WIDTH : metrics.width;
    if (x < edge + width / 2) return i;
    edge += width + TAB_GAP;
  }
  return tabs.length;
}

export function CompactTabs({
  tabs,
  activeId,
  metrics,
  prefix,
  iconFor,
  labelFor,
  addressFor,
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

  return (
    // GTK propagates hexpand up from any child that sets it, so the run would
    // otherwise claim the row's whole free width through the buttons inside
    // it and leave the address field nothing. Stopping it here and on each
    // tab is what keeps the widths this file computes.
    <box
      slot="start"
      testID={`${prefix}tab-strip`}
      orientation="horizontal"
      spacing={Spacing.xs}
      style={{ hexpand: false }}
      dropTarget
      onDragOver={(e) => onDragOverIndex(indexAt(e.data.x, tabs, metrics))}
      onDropped={(e) => onDropAt(e.text, indexAt(e.data.x, tabs, metrics))}
    >
      {tabs.flatMap((t, i) => {
        const active = t.id === activeId;
        // A pinned tab is its site's icon and nothing else, the way every
        // browser draws one, and it keeps that width however crowded the row
        // gets.
        const titled = metrics.titled && !t.pinned;
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
            cssClasses={active ? ["card"] : []}
            style={{ minWidth: t.pinned ? ICON_TAB_WIDTH : metrics.width, valign: "center", hexpand: false }}
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
              // `body` is what takes the header bar's bold off the label: a
              // weight set on the BUTTON loses to Adwaita's own rule on the
              // label inside it. A tab title is body text; the chip is what
              // marks the selected tab, not the weight.
              cssClasses={["flat", "body"]}
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
}
