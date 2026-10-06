import { Platform, Spacing } from "@nativedesktop/solid";
import { Show } from "solid-js";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { downloadStatus, fileIcon, shortName, type DownloadItem } from "./lib/downloads.ts";

/// What a download row can ask the app to do. The engine calls go through
/// whichever Chromium view the app has; the list only names the download.
export interface DownloadActions {
  pause(d: DownloadItem): void;
  resume(d: DownloadItem): void;
  cancel(d: DownloadItem): void;
  retry(d: DownloadItem): void;
  open(d: DownloadItem): void;
  reveal(d: DownloadItem): void;
  remove(d: DownloadItem): void;
  keep(d: DownloadItem): void;
  discard(d: DownloadItem): void;
  clear(): void;
  openFolder(): void;
  /// Every download, in the Downloads panel: where chrome://downloads goes.
  showAll(): void;
}

const REVEAL = Platform.os === "macos" ? "Show in Finder" : "Show in Files";

/// One download. Leading: its progress while it runs, its kind once it is a
/// file. Middle: the name, and one line of status. Trailing: the one or two
/// things that make sense in its state.
export function DownloadRow(props: {
  d: DownloadItem;
  actions: DownloadActions;
  prefix: string;
  /// The popover's row: a narrower leading column and a smaller glyph.
  compact?: boolean;
}) {
  const d = (): DownloadItem => props.d;
  const exists = (): boolean => (d().state === "complete" ? existsSync(d().path) : false);
  const running = (): boolean => d().state === "inProgress" || d().state === "paused";
  const failed = (): boolean => d().state === "interrupted" || d().state === "cancelled";
  const id = (): string => `${props.prefix}downloads-${d().id}`;
  // Dragging the icon or the name out drops the file itself: a file://
  // payload doubles as the file on both backends.
  const payload = (): string | undefined => (exists() ? pathToFileURL(d().path).href : undefined);

  return (
    <box testID={id()} orientation="horizontal" spacing={Spacing.sm} style={{ hexpand: true, valign: "center" }}>
      {/* A fixed column, so names line up whatever the leading element is. */}
      <box orientation="vertical" style={{ minWidth: props.compact ? 36 : 40, halign: "start", valign: "center" }}>
        <Show
          when={running() && d().total > 0}
          fallback={
            <Show
              when={running()}
              fallback={
                <Show
                  when={exists()}
                  fallback={
                    <image
                      testID={`${id()}-icon`}
                      iconName={d().state === "dangerous" || failed() ? "dialog-warning-symbolic" : fileIcon(d().name)}
                      pixelSize={22}
                      cssClasses={d().state === "dangerous" ? ["warning"] : ["dimmed"]}
                      style={{ halign: "center", valign: "center" }}
                    />
                  }
                >
                  {/* A finished file opens from its icon, the way a file on the
                      desktop does, and drags out from there too. */}
                  <button
                    testID={`${id()}-icon`}
                    iconName={fileIcon(d().name)}
                    tooltip={`Open ${d().name}`}
                    cssClasses={["flat"]}
                    style={{ halign: "center", valign: "center" }}
                    onClick={() => props.actions.open(d())}
                    draggable={exists()}
                    dragPayload={payload()}
                  />
                </Show>
              }
            >
              <spinner testID={`${id()}-progress`} spinning={d().state === "inProgress"} style={{ halign: "center", valign: "center" }} />
            </Show>
          }
        >
          <progresscircle
            testID={`${id()}-progress`}
            fraction={Math.min(1, d().received / d().total)}
            lineWidth={3}
            style={{ minWidth: 28, minHeight: 28, halign: "center", valign: "center" }}
          />
        </Show>
      </box>

      <box orientation="vertical" spacing={2} style={{ hexpand: true, valign: "center" }}>
        {/* Fill, not start: an ellipsizing label asks for one character and
            shows exactly that unless it is given the column. Cut in the
            middle, so a long name keeps its extension. */}
        <label
          testID={`${props.prefix}downloads-item-${d().id}`}
          text={props.compact ? shortName(d().name) : d().name}
          ellipsize
          ellipsizeMode="middle"
          tooltip={d().name}
          cssClasses={failed() || (d().state === "complete" && !exists()) ? ["dimmed"] : []}
          style={{ halign: "fill" }}
          draggable={exists()}
          dragPayload={payload()}
        />
        <label
          testID={`${props.prefix}downloads-status-${d().id}`}
          text={downloadStatus(d(), exists())}
          ellipsize
          variant="caption"
          cssClasses={d().state === "dangerous" ? ["warning", "numeric"] : ["dimmed", "numeric"]}
          style={{ halign: "fill" }}
        />
        {/* Under the warning rather than beside it, so the warning is never the
            part that gets cut short. Discarding is the safe answer, so it is the
            prominent one. */}
        <Show when={d().state === "dangerous"}>
          <box orientation="horizontal" spacing={Spacing.xs} style={{ halign: "start", margin: { top: Spacing.xs } }}>
            <button
              testID={`${id()}-keep`}
              label="Keep"
              size="small"
              tooltip={`Keep ${d().name} even though it can harm your computer`}
              onClick={() => props.actions.keep(d())}
            />
            <button testID={`${id()}-discard`} label="Discard" size="small" prominent onClick={() => props.actions.discard(d())} />
          </box>
        </Show>
      </box>

      <box orientation="horizontal" spacing={Spacing.xs} style={{ valign: "center" }}>
        <Show when={d().state === "inProgress"}>
          <button
            testID={`${id()}-pause`}
            iconName="media-playback-pause-symbolic"
            tooltip="Pause"
            cssClasses={["flat"]}
            onClick={() => props.actions.pause(d())}
          />
        </Show>
        <Show when={d().state === "paused"}>
          <button
            testID={`${id()}-resume`}
            iconName="media-playback-start-symbolic"
            tooltip="Resume"
            cssClasses={["flat"]}
            onClick={() => props.actions.resume(d())}
          />
        </Show>
        <Show when={running() || d().state === "pending"}>
          <button
            testID={`${id()}-cancel`}
            iconName="window-close-symbolic"
            tooltip="Cancel"
            cssClasses={["flat"]}
            onClick={() => props.actions.cancel(d())}
          />
        </Show>
        <Show when={failed()}>
          <button
            testID={`${id()}-retry`}
            iconName="view-refresh-symbolic"
            tooltip="Try Again"
            cssClasses={["flat"]}
            onClick={() => props.actions.retry(d())}
          />
        </Show>
        <Show when={exists()}>
          <button
            testID={`${props.prefix}downloads-reveal-${d().id}`}
            iconName="folder-symbolic"
            tooltip={REVEAL}
            cssClasses={["flat"]}
            onClick={() => props.actions.reveal(d())}
          />
        </Show>
        <Show when={failed() || (d().state === "complete" && !exists())}>
          <button
            testID={`${id()}-remove`}
            iconName="window-close-symbolic"
            tooltip="Remove from List"
            cssClasses={["flat"]}
            onClick={() => props.actions.remove(d())}
          />
        </Show>
      </box>
    </box>
  );
}
