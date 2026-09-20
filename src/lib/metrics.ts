/// The find bar's width, carried by the bar AND by the anchor it hangs off in
/// both windows. A popover centres itself on its anchor and then slides to
/// stay on the monitor, so an anchor the width of the bar is what lands the
/// bar's right edge on the page's right edge instead of over the window's
/// border. It also keeps the bar from resizing as the match count changes.
export const FIND_BAR_WIDTH = 420;
