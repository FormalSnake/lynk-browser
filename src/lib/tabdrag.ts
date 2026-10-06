/// What a dragged tab carries. The payload is plain text on the wire (it also
/// lands as text anywhere else on the desktop), so it names the profile the
/// tab's page lives in: a live page can only move to a window on the same one.
export interface TabDrag {
  profile: "default" | "private";
  tabId: string;
  url: string;
}

const MARK = "lynk-tab";

export function tabPayload(drag: TabDrag): string {
  return [MARK, drag.profile, drag.tabId, drag.url].join("\n");
}

/// Null for anything that is not one of this app's tabs, such as text dragged
/// in from another application.
export function parseTabPayload(text: string): TabDrag | null {
  const [mark, profile, tabId, ...rest] = text.split("\n");
  if (mark !== MARK || !tabId || (profile !== "default" && profile !== "private")) return null;
  return { profile, tabId, url: rest.join("\n") };
}
