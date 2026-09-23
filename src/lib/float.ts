// Floating video: the page's video in Chromium's own picture-in-picture
// window, which stays above every window on screen, other apps' included.
//
// requestPictureInPicture only answers a click on the page. The shortcut is
// the user's click here, so the script runs with a user gesture
// (executeJavaScript's `userGesture`); without one Chromium refuses with
// NotAllowedError.

/// What the page answered: a video is floating, the floating one came back,
/// there was no video to lift, or Chromium refused with this message.
export type FloatState = "on" | "off" | "none" | `error:${string}`;

/// Runs in the page. A second press brings the floating video back.
///
/// The video chosen is the one playing, the largest on screen when several
/// are, else the largest that has a picture at all. Same-origin frames are
/// searched too; a player in another site's frame is out of reach of the
/// page's own script, which is Chromium's rule and not one to work around.
export const FLOAT_SCRIPT = `(async () => {
  const docs = [document];
  for (const f of document.querySelectorAll("iframe")) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
  }
  for (const d of docs) {
    if (d.pictureInPictureElement) { await d.exitPictureInPicture(); return "off"; }
  }
  const videos = docs.flatMap((d) => [...d.querySelectorAll("video")]).filter((v) => v.readyState >= 1);
  const area = (v) => { const r = v.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
  const playing = videos.filter((v) => !v.paused && !v.ended);
  const pool = playing.length ? playing : videos.filter((v) => v.videoWidth > 0);
  if (!pool.length) return "none";
  const video = pool.sort((a, b) => area(b) - area(a))[0];
  // A site's player can opt out of the button it draws; the shortcut is the
  // user asking in so many words.
  video.disablePictureInPicture = false;
  try {
    await video.requestPictureInPicture();
    return "on";
  } catch (e) {
    return "error:" + (e && e.message ? e.message : String(e));
  }
})()`;

export function floatState(answer: string): FloatState {
  if (answer === "on" || answer === "off" || answer === "none") return answer;
  if (answer.startsWith("error:")) return answer as FloatState;
  return `error:${answer}`;
}
