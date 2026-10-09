// A sized window.open, which Chrome gives a small window of its own: the
// page, and above it the title and the site it is on, so a sign-in pop-up
// always says whose it is. The view takes over the browser the engine made
// inside window.open, so the opener's handle on it stays live: it can post
// back to the opener and close itself.
import { createSignal } from "solid-js";
import { hostOf } from "./lib/url.ts";

/// window.open's own fallbacks when the features name no size.
export const POPUP_DEFAULT_WIDTH = 500;
export const POPUP_DEFAULT_HEIGHT = 600;
/// Chrome's floor for a pop-up's page, so a 1x1 trick still opens a window
/// that shows whose it is.
export const POPUP_MIN_WIDTH = 240;
export const POPUP_MIN_HEIGHT = 120;
/// The header bar above the page: the features size the page, not the window.
const HEADER_HEIGHT = 46;

export interface PopupWindowState {
  key: string;
  /// The engine's id for the browser waiting to be mounted.
  popup: string;
  url: string;
  width: number;
  height: number;
  /// Where a window this pop-up opens goes: a private opener's stay private.
  onNewWindow: (e: { text: string }) => void;
}

export function PopupWindow(props: { state: PopupWindowState; onClose: () => void }) {
  const [url, setUrl] = createSignal(props.state.url);
  const [title, setTitle] = createSignal("");
  const host = () => hostOf(url()) || url();
  return (
    <window
      title={title() || host()}
      testID={props.state.key}
      defaultWidth={props.state.width}
      defaultHeight={props.state.height + HEADER_HEIGHT}
      // Transient for the window that opened it: kept above it and floated at
      // its own size by a tiling compositor, as Chrome's pop-up windows are,
      // rather than tiled into half the screen.
      presentation="sheet"
      onClosed={() => props.onClose()}
    >
      <toolbarview testID={`${props.state.key}-toolbar`}>
        <headerbar testID={`${props.state.key}-header`} title={title() || host()} subtitle={title() ? host() : ""} />
        <webview
          testID={`${props.state.key}-page`}
          popup={props.state.popup}
          adoptPopups
          style={{ hexpand: true, vexpand: true }}
          onNavigate={(e) => setUrl(e.text)}
          onTitleChanged={(e) => setTitle(e.text)}
          onNewWindow={(e) => props.state.onNewWindow(e)}
          onWindowClosed={() => props.onClose()}
        />
      </toolbarview>
    </window>
  );
}
