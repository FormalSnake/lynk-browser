// The zoom indicator: a magnifier at the trailing end of the address field
// while the page is not at 100%, and a popover under it with the value and
// the controls. It replaces Chromium's zoom bubble, which has no location bar
// to anchor to in this browser and would sit over the middle of the page.
//
// Compact has an address field: `zoomFieldProps` goes on the field itself, and
// `<ZoomPopover>` is portalled into the window and anchored to that field's
// trailing icon. The sidebar layout has no address field, so `<ZoomFootControl>`
// puts the magnifier among the small glyphs at the sidebar's foot, beside the
// padlock, with the popover above it.
import { Platform, Spacing, createPortal, useEffect, useRef, useState } from "@nativedesktop/react";
import type { NdNodeRef } from "@nativedesktop/react";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_NOTICE_MS, isDefaultZoom, zoomPercent } from "./lib/zoom.ts";

/// The value label's width, sized for the widest value ("500%") so the
/// buttons beside it never move as the value changes.
const VALUE_WIDTH = 48;

/// A magnifier on both platforms. SF Symbols has one with the direction in it;
/// Adwaita's zoom-in and zoom-out are a boxed plus and minus, which read as
/// "add" in an address field, so GTK gets the plain magnifier.
function zoomIcon(factor: number): string {
  if (Platform.backend !== "appkit") return "system-search-symbolic";
  return factor < 1 ? "zoom-out-symbolic" : "zoom-in-symbolic";
}

export interface ZoomFieldProps {
  trailingIconName: string;
  trailingIconTooltip: string;
  trailingIconLabel: string;
  onTrailingIconClicked: () => void;
}

/// Props for the address field. The icon name is always passed, empty while
/// hidden: GTK only gives a search field an icon slot when it mounts with one.
export function zoomFieldProps(factor: number, shown: boolean, onClick: () => void): ZoomFieldProps {
  const visible = shown || !isDefaultZoom(factor);
  return {
    trailingIconName: visible ? zoomIcon(factor) : "",
    trailingIconTooltip: `Zoom: ${zoomPercent(factor)}`,
    trailingIconLabel: "Page zoom",
    onTrailingIconClicked: onClick,
  };
}

/// Open state for the popover. A click opens it until it is dismissed; a
/// `notice` bump on the same tab (a chord, a menu step) opens it for
/// ZOOM_NOTICE_MS unless the user already opened it, and calls `onNotice`.
export function useZoomPopover(
  tabId: string,
  notice: number,
  onNotice?: () => void,
): {
  open: boolean;
  pinned: boolean;
  toggle: () => void;
  close: () => void;
} {
  const [mode, setMode] = useState<"closed" | "notice" | "pinned">("closed");
  const seen = useRef({ tabId, notice });
  useEffect(() => {
    const last = seen.current;
    seen.current = { tabId, notice };
    // Another tab's count is not a new change, and the popover belongs to the
    // page that was showing.
    if (last.tabId !== tabId) {
      setMode("closed");
      return;
    }
    if (last.notice === notice) return;
    onNotice?.();
    setMode((m) => (m === "pinned" ? m : "notice"));
    const timer = setTimeout(() => setMode((m) => (m === "notice" ? "closed" : m)), ZOOM_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [tabId, notice]);
  return {
    open: mode !== "closed",
    pinned: mode === "pinned",
    toggle: () => setMode((m) => (m === "pinned" ? "closed" : "pinned")),
    close: () => setMode("closed"),
  };
}

interface ZoomPanelProps {
  factor: number;
  /// Prefix for testIDs, so every window's popover can be told apart.
  prefix: string;
  onStep: (direction: 1 | -1) => void;
  onReset: () => void;
}

function ZoomPanel({ factor, prefix, onStep, onReset }: ZoomPanelProps): React.ReactNode {
  return (
    <box testID={`${prefix}zoom-panel`} orientation="horizontal" spacing={Spacing.xs} style={{ padding: Spacing.xs }}>
      <button
        testID={`${prefix}zoom-out`}
        iconName="list-remove-symbolic"
        tooltip="Zoom Out"
        enabled={factor > ZOOM_MIN + 0.001}
        cssClasses={["flat"]}
        onClick={() => onStep(-1)}
      />
      <label
        testID={`${prefix}zoom-value`}
        text={zoomPercent(factor)}
        cssClasses={["numeric"]}
        style={{ minWidth: VALUE_WIDTH, valign: "center" }}
      />
      <button
        testID={`${prefix}zoom-in`}
        iconName="list-add-symbolic"
        tooltip="Zoom In"
        enabled={factor < ZOOM_MAX - 0.001}
        cssClasses={["flat"]}
        onClick={() => onStep(1)}
      />
      <button
        testID={`${prefix}zoom-reset`}
        label="Reset"
        enabled={!isDefaultZoom(factor)}
        cssClasses={["flat"]}
        onClick={onReset}
      />
    </box>
  );
}

export interface ZoomPopoverProps extends ZoomPanelProps {
  anchor: React.RefObject<NdNodeRef<"searchinput"> | null>;
  open: boolean;
  onClosed: () => void;
}

export function ZoomPopover({ anchor, open, onClosed, ...panel }: ZoomPopoverProps): React.ReactNode {
  return createPortal(
    <popover
      testID={`${panel.prefix}zoom-popover`}
      anchorRef={anchor}
      anchorSlot="trailingIcon"
      open={open}
      position="bottom"
      onClosed={onClosed}
    >
      <ZoomPanel {...panel} />
    </popover>,
  );
}

export interface ZoomFootControlProps extends ZoomPanelProps {
  open: boolean;
  onToggle: () => void;
  onClosed: () => void;
}

/// Nothing while the page is at 100% and the popover is closed.
export function ZoomFootControl({ open, onToggle, onClosed, ...panel }: ZoomFootControlProps): React.ReactNode {
  if (!open && isDefaultZoom(panel.factor)) return null;
  return (
    // Boxed: a popover anchors on its tree parent.
    <box testID={`${panel.prefix}zoom-anchor`} orientation="horizontal">
      <button
        testID={`${panel.prefix}zoom-indicator`}
        iconName={zoomIcon(panel.factor)}
        tooltip={`Zoom: ${zoomPercent(panel.factor)}`}
        cssClasses={["flat"]}
        style={{ valign: "center" }}
        onClick={onToggle}
      />
      <popover testID={`${panel.prefix}zoom-popover`} open={open} position="top" onClosed={onClosed}>
        <ZoomPanel {...panel} />
      </popover>
    </box>
  );
}
