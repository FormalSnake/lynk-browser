// The zoom indicator: a magnifier at the trailing end of the address field
// while the page is not at 100%, and a popover under it with the value and
// the controls. It replaces Chromium's zoom bubble, which has no location bar
// to anchor to in this browser and would sit over the middle of the page.
//
// Two parts, so any layout that owns an address field can carry it:
// `zoomFieldProps` goes on the field itself, and `<ZoomPopover>` is portalled
// into the window and anchored to that field's trailing icon.
import { Spacing, createPortal, useEffect, useRef, useState } from "@nativedesktop/react";
import type { NdNodeRef } from "@nativedesktop/react";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_NOTICE_MS, isDefaultZoom, zoomPercent } from "./lib/zoom.ts";

/// The value label's width, sized for the widest value ("500%") so the
/// buttons beside it never move as the value changes.
const VALUE_WIDTH = 48;

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
    trailingIconName: visible ? (factor < 1 ? "zoom-out-symbolic" : "zoom-in-symbolic") : "",
    trailingIconTooltip: `Zoom: ${zoomPercent(factor)}`,
    trailingIconLabel: "Page zoom",
    onTrailingIconClicked: onClick,
  };
}

/// Open state for the popover. A click opens it until it is dismissed; a
/// `notice` bump on the same tab (a chord, a menu step) opens it for
/// ZOOM_NOTICE_MS unless the user already opened it.
export function useZoomPopover(
  tabId: string,
  notice: number,
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

export interface ZoomPopoverProps {
  anchor: React.RefObject<NdNodeRef<"searchinput"> | null>;
  open: boolean;
  factor: number;
  /// Prefix for testIDs, so every window's popover can be told apart.
  prefix: string;
  onStep: (direction: 1 | -1) => void;
  onReset: () => void;
  onClosed: () => void;
}

export function ZoomPopover({ anchor, open, factor, prefix, onStep, onReset, onClosed }: ZoomPopoverProps): React.ReactNode {
  return createPortal(
    <popover
      testID={`${prefix}zoom-popover`}
      anchorRef={anchor}
      anchorSlot="trailingIcon"
      open={open}
      position="bottom"
      onClosed={onClosed}
    >
      <box
        testID={`${prefix}zoom-panel`}
        orientation="horizontal"
        spacing={Spacing.sm}
        style={{ padding: Spacing.sm }}
      >
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
          onClick={onReset}
        />
      </box>
    </popover>,
  );
}
