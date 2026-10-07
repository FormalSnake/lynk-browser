// The compact layout's tab run: the tabs themselves, drawn in the one toolbar
// row after the reload button. In the main window the active tab is also the
// address: it carries the padlock and the zoom, and a click on it opens the
// command bar on its address, as the sidebar's row does. A private window has
// no command bar, so its row ends in an address field instead.
import { Platform, Spacing } from "@nativedesktop/react";
import type { JSX, MenuEntry } from "@nativedesktop/react";
import { For, Show, createSignal } from "solid-js";

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
/// The active tab when it is the address: room for the padlock, the favicon,
/// a readable run of title, the zoom glyph and the close button. ADDRESS_TAB
/// is what it takes when the row has it, and it is the last to give way.
const ADDRESS_TAB = 280;
const ADDRESS_TAB_FLOOR = 200;

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
/// buttons. Measured 408 on GTK under X11 (plus the 10 px its client-side
/// frame takes out of the width the app is told) and 368 on AppKit. The layout
/// button leaves the row below LAYOUT_BUTTON_WIDTH (the View menu and the
/// chord still switch), which gives back LAYOUT_BUTTON. The extensions
/// button and each pinned extension action add FURNITURE_SLOT.
const FURNITURE = { gtk: 424, appkit: 380 } as const;
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
  /// Whether the active tab is the address (no field in the row).
  address: boolean;
}

/// How wide each tab may be, given the window and how many tabs share the row.
/// Tabs shrink evenly, then the ones that are not active drop to their
/// favicons, then out of the row, before the address field goes under its
/// floor. The widths are what the row ASKS for: on GTK the run sits in a
/// clipping scroller, so a width worked out for a wider window is cut off
/// rather than holding the window at that width.
///
/// `field` is whether the row also holds an address field. Without one the
/// active tab is the address: it is titled even when pinned, it takes up to
/// ADDRESS_TAB, and it keeps ADDRESS_TAB_FLOOR while the others shrink.
export function tabRunMetrics(
  windowWidth: number,
  tabs: CompactTab[],
  activeId: string,
  trailing: number,
  backend: "gtk" | "appkit",
  field: boolean,
): TabRunMetrics {
  const layoutButton = windowWidth < LAYOUT_BUTTON_WIDTH ? LAYOUT_BUTTON : 0;
  const row = windowWidth - FURNITURE[backend] + layoutButton - trailing * FURNITURE_SLOT;
  const icon = ICON_TAB_WIDTH + TAB_GAP;
  if (!field) return addressRun(row, tabs, activeId);
  const pinned = tabs.filter((t) => t.pinned);
  const loose = tabs.filter((t) => !t.pinned);

  // Every pinned tab at its favicon and every other tab titled, at an even
  // share of what the field leaves above its floor.
  const even = loose.length > 0 ? Math.floor((row - ADDRESS_FLOOR - pinned.length * icon) / loose.length) - TAB_GAP : TAB_MAX_WIDTH;
  if (even >= TITLE_FLOOR) {
    const width = Math.min(TAB_MAX_WIDTH, even);
    return { width, titled: true, activeWidth: width, shown: tabs, address: false };
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
    address: false,
  };
}

/// The run when the active tab is the address. It is sized first; the rest
/// share what it leaves the way they share the field's leftovers above.
function addressRun(row: number, tabs: CompactTab[], activeId: string): TabRunMetrics {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const others = tabs.filter((t) => t !== active);
  const pinned = others.filter((t) => t.pinned);
  const loose = others.filter((t) => !t.pinned);
  const icon = ICON_TAB_WIDTH + TAB_GAP;
  const pinnedRun = pinned.length * icon;

  // Everyone titled: the address at full width, the others at an even share.
  const room = row - ADDRESS_TAB - TAB_GAP - pinnedRun;
  const even = loose.length > 0 ? Math.floor(room / loose.length) - TAB_GAP : TAB_MAX_WIDTH;
  if (even >= TITLE_FLOOR) {
    return { width: Math.min(TAB_MAX_WIDTH, even), titled: true, activeWidth: Math.min(ADDRESS_TAB, row), shown: tabs, address: true };
  }

  // The others at their favicons, nearest the address first, then the
  // address gives back what is left down to its floor.
  const floor = Math.max(ICON_TAB_WIDTH, Math.min(ADDRESS_TAB_FLOOR, row));
  let left = row - floor - TAB_GAP;
  const keep = new Set<string>(active ? [active.id] : []);
  for (const t of pinned) {
    if (left < icon) break;
    keep.add(t.id);
    left -= icon;
  }
  const at = active ? tabs.indexOf(active) : 0;
  const byDistance = [...loose].sort((a, b) => Math.abs(tabs.indexOf(a) - at) - Math.abs(tabs.indexOf(b) - at));
  for (const t of byDistance) {
    if (left < icon) break;
    keep.add(t.id);
    left -= icon;
  }
  return {
    width: ICON_TAB_WIDTH,
    titled: false,
    activeWidth: Math.min(ADDRESS_TAB, floor + Math.max(0, left)),
    shown: tabs.filter((t) => keep.has(t.id)),
    address: true,
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
  /// What hovering a tab shows: its title and its whole address.
  hoverFor: (tab: CompactTab) => string;
  /// A click on the tab already on show, while it is the address: the command
  /// bar opens on its address.
  onOpenAddress?: () => void;
  /// Drawn inside the active tab while it is the address, before and after
  /// its title: the padlock with the site's information, and the zoom.
  addressLeading?: JSX.Element;
  addressTrailing?: JSX.Element;
  /// A tab put to sleep, whose chip is drawn dimmed until it wakes.
  asleep?: (id: string) => boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /// A tab's right-click menu, and the item picked from it.
  menuFor?: (tab: CompactTab) => MenuEntry[];
  onMenu?: (tab: CompactTab, id: string) => void;
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

export function CompactTabs(props: CompactTabsProps) {
  /// The tab the pointer is on, so its close button can appear. One id rather
  /// than a set, because the pointer is in one place.
  const [hovered, setHovered] = createSignal("");
  const shownTabs = (): CompactTab[] => props.metrics.shown;
  const gtk = Platform.backend === "gtk";

  function Tab(v: { tab: CompactTab }) {
    const active = (): boolean => v.tab.id === props.activeId;
    const address = (): boolean => active() && props.metrics.address;
    // A pinned tab is its site's icon and nothing else, the way every
    // browser draws one, and it keeps that width however crowded the row
    // gets, unless it is the one on show and that is the address.
    const titled = (): boolean => address() || (!v.tab.pinned && (active() || props.metrics.titled));
    const closable = (): boolean => titled() && (active() || hovered() === v.tab.id);
    return (
      <>
        <Show when={props.dropIndex === props.tabs.indexOf(v.tab)}>
          <separator testID={`${props.prefix}tab-drop`} orientation="vertical" />
        </Show>
        <box
          testID={`${props.prefix}tab-slot-${v.tab.id}`}
          orientation="horizontal"
          // The BOX is the chip: one rounded rectangle holding the favicon,
          // the title and the close button. Two linked buttons would draw a
          // seam down the middle of it. An unselected tab draws no chip at
          // all, which is what tells it from the selected one.
          cssClasses={active() ? ["card"] : props.asleep?.(v.tab.id) ? ["dimmed"] : []}
          style={{ minWidth: tabWidth(v.tab, props.activeId, props.metrics), valign: "center", hexpand: false }}
          onHoverChanged={(e) => setHovered(e.checked ? v.tab.id : "")}
        >
          <Show when={address()}>{props.addressLeading}</Show>
          <button
            testID={`${props.prefix}tab-item-${v.tab.id}`}
            label={titled() ? props.labelFor(v.tab) : ""}
            iconData={props.iconFor(v.tab.url)}
            iconName="web-browser-symbolic"
            labelAlign="start"
            ellipsize
            tooltip={props.hoverFor(v.tab)}
            cssClasses={["flat"]}
            style={{ hexpand: true }}
            onClick={() => (address() && props.onOpenAddress ? props.onOpenAddress() : props.onSelect(v.tab.id))}
            contextMenu={props.menuFor?.(v.tab)}
            onContextMenuSelected={(e) => props.onMenu?.(v.tab, e.text)}
            draggable
            dragPayload={props.dragPayload(v.tab)}
            onDragStarted={(e) => props.onDragStart(e.text)}
            onDragEnded={() => props.onDragEnd()}
          />
          <Show when={address()}>{props.addressTrailing}</Show>
          <Show when={titled()}>
            <Show
              when={closable()}
              fallback={
                // Reserved whether or not the pointer is on the tab, so the
                // title does not reflow as the pointer crosses the row.
                <box orientation="horizontal" style={{ minWidth: CLOSE_SLOT_WIDTH }} />
              }
            >
              <button
                testID={`${props.prefix}tab-close-${v.tab.id}`}
                iconName="window-close-symbolic"
                tooltip={`Close ${props.labelFor(v.tab)}`}
                cssClasses={["flat"]}
                size="small"
                style={{ minWidth: CLOSE_SLOT_WIDTH, valign: "center" }}
                onClick={() => props.onClose(v.tab.id)}
              />
            </Show>
          </Show>
        </box>
      </>
    );
  }

  const strip = () => (
    // GTK propagates hexpand up from any child that sets it, so the run would
    // otherwise claim the row's whole free width through the buttons inside
    // it and leave the address field nothing. Stopping it here and on each
    // tab is what keeps the widths this file computes.
    <box
      slot={gtk ? undefined : "start"}
      testID={`${props.prefix}tab-strip`}
      orientation="horizontal"
      spacing={Spacing.xs}
      // A tab title is body text, not the header bar's bold title: the chip
      // is what marks the selected tab, not the weight.
      style={{ hexpand: false, font: { fontWeight: "normal" } }}
      dropTarget
      onDragOver={(e) => props.onDragOverIndex(indexAt(e.data.x, props.tabs, shownTabs(), props.activeId, props.metrics))}
      onDropped={(e) => {
        const index = indexAt(e.data.x, props.tabs, shownTabs(), props.activeId, props.metrics);
        if (process.env.NB_TEST_HOOKS === "1") console.error(`ND_APP DROP ${props.prefix}tab-strip x=${e.data.x} index=${index}`);
        props.onDropAt(e.text, index);
      }}
    >
      <For each={shownTabs()} keyed={(t) => t.id}>
        {(t) => <Tab tab={t()} />}
      </For>
      <Show when={props.dropIndex === props.tabs.length}>
        <separator testID={`${props.prefix}tab-drop`} orientation="vertical" />
      </Show>
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
    <scrollview slot="start" testID={`${props.prefix}tab-clip`} hscroll="clip">
      {strip()}
    </scrollview>
  ) : (
    strip()
  );
}

function tabWidth(t: CompactTab, activeId: string, metrics: TabRunMetrics): number {
  if (t.id === activeId && metrics.address) return metrics.activeWidth;
  if (t.pinned) return ICON_TAB_WIDTH;
  return t.id === activeId ? metrics.activeWidth : metrics.width;
}
