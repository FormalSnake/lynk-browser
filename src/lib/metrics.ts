/// The find bar's width, carried by the bar AND by the anchor it hangs off in
/// both windows. A popover centres itself on its anchor and then slides to
/// stay on the monitor, so an anchor the width of the bar is what lands the
/// bar's right edge on the page's right edge instead of over the window's
/// border. It also keeps the bar from resizing as the match count changes.
export const FIND_BAR_WIDTH = 420;

/// Room for "Sidebar" and "Compact" at their natural width in both segments
/// of the layout switch (each about 86 px in Adwaita), plus some for a
/// larger system font.
export const LAYOUT_SEGMENT_WIDTH = 200;
