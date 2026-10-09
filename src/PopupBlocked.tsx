// Chrome's blocked pop-up indicator. The engine blocks a window the page
// opens without a click, as Chrome does, and this is the way to get one back:
// a glyph beside the zoom one while the page on show has had any blocked, and
// a popover off it listing where they would have gone, with Chrome's "always
// allow" for the site. Up from the sidebar's foot, down from the compact row.
import { Spacing } from "@nativedesktop/react";
import { For, Show, createEffect, createSignal } from "solid-js";

/// Wide enough for a typical address before it ellipsizes.
const PANEL_WIDTH = 300;
/// What an address keeps beside its Open button: a popover lays its rows out
/// at their minimum, and an ellipsized label's is a lone ellipsis.
const URL_MIN_WIDTH = 200;

export interface PopupBlockedControlProps {
  prefix: string;
  position: "top" | "bottom";
  /// The tab and the layout: another tab or the other layout closes it.
  scope: string;
  urls: string[];
  site: string;
  onOpen: (url: string) => void;
  onAllow: () => void;
}

/// Nothing while the page on show has had no pop-up blocked.
export function PopupBlockedControl(props: PopupBlockedControlProps) {
  const [open, setOpen] = createSignal(false);
  createEffect(
    () => props.scope,
    () => void setOpen(false),
  );
  return (
    <Show when={props.urls.length > 0}>
      {/* Boxed: a popover anchors on its tree parent. */}
      <box testID={`${props.prefix}popups-anchor`} orientation="horizontal" style={{ valign: "center" }}>
        <button
          testID={`${props.prefix}popups-blocked`}
          iconName="action-unavailable-symbolic"
          tooltip="Pop-ups Blocked"
          cssClasses={["flat"]}
          size={props.position === "bottom" ? "small" : undefined}
          style={{ valign: "center" }}
          onClick={() => setOpen((o) => !o)}
        />
        <popover testID={`${props.prefix}popups-popover`} open={open()} position={props.position} onClosed={() => setOpen(false)}>
          <box
            testID={`${props.prefix}popups-panel`}
            orientation="vertical"
            spacing={Spacing.xs}
            style={{ padding: Spacing.sm, minWidth: PANEL_WIDTH }}
          >
            <label testID={`${props.prefix}popups-title`} text="Pop-ups Blocked" cssClasses={["heading"]} style={{ halign: "start" }} />
            <For each={props.urls} keyed={(u) => u}>
              {(url) => (
                <box testID={`${props.prefix}popups-row`} orientation="horizontal" spacing={Spacing.sm}>
                  <label
                    testID={`${props.prefix}popups-url`}
                    text={url()}
                    tooltip={url()}
                    ellipsize
                    ellipsizeMode="middle"
                    style={{ halign: "start", hexpand: true, valign: "center", minWidth: URL_MIN_WIDTH }}
                  />
                  <button
                    testID={`${props.prefix}popups-open`}
                    label="Open"
                    tooltip={`Open ${url()}`}
                    cssClasses={["flat"]}
                    onClick={() => {
                      setOpen(false);
                      props.onOpen(url());
                    }}
                  />
                </box>
              )}
            </For>
            <Show when={props.site}>
              <button
                testID={`${props.prefix}popups-allow`}
                label={`Always Allow Pop-ups from ${props.site}`}
                onClick={() => {
                  setOpen(false);
                  props.onAllow();
                }}
              />
            </Show>
          </box>
        </popover>
      </box>
    </Show>
  );
}
