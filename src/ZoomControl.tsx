// The zoom indicator: a magnifier while the page is not at 100%, and a
// popover off it with the value and the controls. It replaces Chromium's zoom
// bubble, which has no location bar to anchor to in this browser and would sit
// over the middle of the page. The sidebar puts it among the small glyphs at
// its foot, beside the padlock, with the popover above it; compact puts it at
// the end of the active tab, with the popover below.
import { Platform, Spacing } from "@nativedesktop/react";
import { Show, createEffect, createSignal, untrack } from "solid-js";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_NOTICE_MS, isDefaultZoom, zoomPercent } from "./lib/zoom.ts";

/// The value label's width, sized for the widest value ("500%") so the
/// buttons beside it never move as the value changes.
const VALUE_WIDTH = 48;

/// A magnifier on both platforms. SF Symbols has one with the direction in it;
/// Adwaita's zoom-in and zoom-out are a boxed plus and minus, which read as
/// "add" beside a tab, so GTK gets the plain magnifier.
function zoomIcon(factor: number): string {
  if (Platform.backend !== "appkit") return "system-search-symbolic";
  return factor < 1 ? "zoom-out-symbolic" : "zoom-in-symbolic";
}

/// Open state for the popover. A click opens it until it is dismissed; a
/// `notice` bump in the same scope (a chord, a menu step) opens it for
/// ZOOM_NOTICE_MS unless the user already opened it, and calls `onNotice`.
/// `scope` names the tab and the layout: another tab or the other layout
/// closes it. It also closes once the page is back at 100%.
export function createZoomPopover(
  scope: () => string,
  factor: () => number,
  notice: () => number,
  onNotice?: () => void,
): {
  open: () => boolean;
  pinned: () => boolean;
  toggle: () => void;
  close: () => void;
} {
  const [mode, setMode] = createSignal<"closed" | "notice" | "pinned">("closed");
  const atDefault = () => isDefaultZoom(factor());
  let seen = untrack(() => ({ scope: scope(), notice: notice() }));
  createEffect(
    () => ({ scope: scope(), notice: notice() }),
    (now) => {
      const last = seen;
      seen = now;
      // Another tab's count is not a new change, and the popover belongs to the
      // page and the anchor that were showing.
      if (last.scope !== now.scope) {
        setMode("closed");
        return;
      }
      if (last.notice === now.notice) return;
      onNotice?.();
      setMode((m) => (m === "pinned" ? m : "notice"));
      const timer = setTimeout(() => setMode((m) => (m === "notice" ? "closed" : m)), ZOOM_NOTICE_MS);
      return () => clearTimeout(timer);
    },
  );
  createEffect(atDefault, (yes) => {
    if (yes) setMode("closed");
  });
  return {
    open: () => mode() !== "closed" && !atDefault(),
    pinned: () => mode() === "pinned",
    toggle: () => void setMode((m) => (m === "pinned" ? "closed" : "pinned")),
    close: () => void setMode("closed"),
  };
}

interface ZoomPanelProps {
  factor: number;
  /// Prefix for testIDs, so every window's popover can be told apart.
  prefix: string;
  onStep: (direction: 1 | -1) => void;
  onReset: () => void;
}

function ZoomPanel(props: ZoomPanelProps) {
  return (
    <box testID={`${props.prefix}zoom-panel`} orientation="horizontal" spacing={Spacing.xs} style={{ padding: Spacing.xs }}>
      <button
        testID={`${props.prefix}zoom-out`}
        iconName="list-remove-symbolic"
        tooltip="Zoom Out"
        enabled={props.factor > ZOOM_MIN + 0.001}
        cssClasses={["flat"]}
        onClick={() => props.onStep(-1)}
      />
      <label
        testID={`${props.prefix}zoom-value`}
        text={zoomPercent(props.factor)}
        cssClasses={["numeric"]}
        style={{ minWidth: VALUE_WIDTH, valign: "center" }}
      />
      <button
        testID={`${props.prefix}zoom-in`}
        iconName="list-add-symbolic"
        tooltip="Zoom In"
        enabled={props.factor < ZOOM_MAX - 0.001}
        cssClasses={["flat"]}
        onClick={() => props.onStep(1)}
      />
      <button
        testID={`${props.prefix}zoom-reset`}
        label="Reset"
        enabled={!isDefaultZoom(props.factor)}
        cssClasses={["flat"]}
        onClick={() => props.onReset()}
      />
    </box>
  );
}

export interface ZoomFootControlProps extends ZoomPanelProps {
  open: boolean;
  /// Which side of the glyph the popover opens on: up from the sidebar's
  /// foot, down from the compact row.
  position: "top" | "bottom";
  onToggle: () => void;
  onClosed: () => void;
}

/// Nothing while the page is at 100% and the popover is closed.
export function ZoomFootControl(props: ZoomFootControlProps) {
  return (
    <Show when={props.open || !isDefaultZoom(props.factor)}>
      {/* Boxed: a popover anchors on its tree parent. */}
      <box testID={`${props.prefix}zoom-anchor`} orientation="horizontal" style={{ valign: "center" }}>
        <button
          testID={`${props.prefix}zoom-indicator`}
          iconName={zoomIcon(props.factor)}
          tooltip={`Zoom: ${zoomPercent(props.factor)}`}
          cssClasses={["flat"]}
          size={props.position === "bottom" ? "small" : undefined}
          style={{ valign: "center" }}
          onClick={() => props.onToggle()}
        />
        <popover testID={`${props.prefix}zoom-popover`} open={props.open} position={props.position} onClosed={() => props.onClosed()}>
          <ZoomPanel factor={props.factor} prefix={props.prefix} onStep={props.onStep} onReset={props.onReset} />
        </popover>
      </box>
    </Show>
  );
}
