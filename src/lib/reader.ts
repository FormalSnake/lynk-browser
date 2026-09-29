// Reading mode: the page's article, alone, in Search's type and colours.
//
// Readability (Firefox's reader view) picks the article. It runs on a clone of
// the page, so the page underneath is never touched: the reader is laid over it
// in a shadow root, and leaving puts nothing back because nothing was taken
// away. The address, the scroll position and anything playing are exactly
// where they were. Chromium's own reading mode is a side panel of Chrome's
// window that this embedding does not have.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Appearance } from "@nativedesktop/react";

const require = createRequire(import.meta.url);

/// Readability's source, wrapped so its top-level declarations stay inside the
/// injected function. `module` is shadowed so it does not try to export
/// itself. Its `isProbablyReaderable` is not used: it looks for <p> and turns
/// away pages that set their prose between <br>s (Paul Graham's essays).
let library: string | null = null;
function readability(): string {
  library ??= readFileSync(require.resolve("@mozilla/readability/Readability.js"), "utf8");
  return library;
}

/// What the page answered: the reader is up, it went away, or there was no
/// article to show.
export type ReaderState = "on" | "off" | "none";

/// The element the reader hangs from. A property of the window rather than an
/// id, so a page with an element of that id cannot be mistaken for it.
const KEY = "__ndReader";

// Design.swift's pairs, light then dark. Muted is neutral-500 rather than
// Search's lighter grey: the site line is 12 px and needs 4.5:1 on white.
const STYLE = `
:host { all: initial; }
.scroll {
  --ground: #ffffff; --ink: #171717; --muted: #737373; --faint: #d4d4d4;
  --hairline: #e8e8e8; --well: #f6f6f6; --outline: rgb(0 0 0 / 0.1);
  color-scheme: light;
  scrollbar-width: thin; scrollbar-color: var(--faint) transparent;
  position: fixed; inset: 0; overflow: auto; overscroll-behavior: contain;
  background: var(--ground); color: var(--ink);
  -webkit-font-smoothing: antialiased;
  outline: none;
}
:host([data-scheme="dark"]) .scroll {
  --ground: #1c1c1c; --ink: #ededed; --muted: #949494; --faint: #525252;
  --hairline: #333333; --well: #262626; --outline: rgb(255 255 255 / 0.1);
  color-scheme: dark;
}
@media (prefers-reduced-motion: no-preference) {
  .scroll { animation: arrive 140ms ease-out; }
  @keyframes arrive { from { opacity: 0; } }
}
main {
  max-width: 38em; margin: 0 auto; padding: 72px 24px 160px;
  font: 400 18px/1.72 ui-serif, "New York", Georgia, "Noto Serif", "DejaVu Serif", serif;
  overflow-wrap: break-word;
}
h1, h2, h3, h4, h5, h6, .from, figcaption {
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Adwaita Sans", Cantarell, sans-serif;
}
h1.title { font-size: 30px; font-weight: 600; line-height: 1.24; letter-spacing: -0.01em; margin: 0 0 8px; text-wrap: balance; }
.from { font-size: 12px; line-height: 1; color: var(--muted); margin: 0 0 40px; text-transform: uppercase; letter-spacing: 0.06em; }
article h1, h2 { font-size: 22px; font-weight: 600; line-height: 1.3; margin: 2em 0 0.6em; text-wrap: balance; }
h3 { font-size: 20px; font-weight: 600; line-height: 1.3; margin: 2em 0 0.6em; text-wrap: balance; }
h4, h5, h6 { font-size: 18px; font-weight: 600; line-height: 1.4; margin: 1.6em 0 0.4em; }
p { margin: 0 0 1.35em; }
ul, ol { margin: 0 0 1.35em; padding-inline-start: 1.4em; }
li { margin: 0 0 0.4em; }
dl { margin: 0 0 1.35em; }
dd { margin: 0.2em 0 1em; padding-inline-start: 1.4em; }
a { color: inherit; text-decoration-color: var(--faint); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { text-decoration-color: currentColor; }
:is(h1, h2, h3, h4, h5, h6) a { text-decoration: none; }
a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 2px; }
img, video, iframe, picture { max-width: 100%; height: auto; }
img, video { display: block; border-radius: 6px; margin: 1.6em 0; outline: 1px solid var(--outline); outline-offset: -1px; }
iframe { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: 6px; margin: 1.6em 0; }
figure { margin: 1.8em 0; }
figure img { margin: 0; }
figcaption { font-size: 13px; line-height: 1.5; color: var(--muted); margin-top: 0.6em; }
blockquote { margin: 1.6em 0; padding-inline-start: 1.2em; border-inline-start: 2px solid var(--hairline); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--hairline); margin: 2.4em 0; }
pre, code, kbd, samp { font-family: ui-monospace, "SF Mono", "JetBrains Mono", "DejaVu Sans Mono", monospace; font-size: 14px; }
code { background: var(--well); border-radius: 4px; padding: 0.1em 0.3em; }
pre { background: var(--well); padding: 14px; border-radius: 8px; overflow: auto; line-height: 1.5; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 0 0 1.35em; font-size: 16px; display: block; overflow-x: auto; }
th, td { border-bottom: 1px solid var(--hairline); padding: 6px 10px; text-align: start; vertical-align: top; }
sup, sub { line-height: 0; }
`;

/// Runs in the page. Everything it needs arrives as literals in the source,
/// because the host hands back a string and nothing else.
function pageScript(action: "toggle" | "off" | "scheme", scheme: Appearance): string {
  if (action === "scheme") {
    return `(() => { const r = window[${JSON.stringify(KEY)}]; if (!r) return "off"; r.host.dataset.scheme = ${JSON.stringify(scheme)}; return "on"; })()`;
  }
  const leave = `
    const r = window[${JSON.stringify(KEY)}];
    if (r) {
      window.removeEventListener("keydown", r.onKey, true);
      r.host.remove();
      document.documentElement.style.overflow = r.overflow;
      delete window[${JSON.stringify(KEY)}];
      return "off";
    }`;
  if (action === "off") return `(() => { ${leave} return "off"; })()`;
  return `(() => {
    ${leave}
    let module;
    ${readability()}
    ;
    // Every picture is resolved on the live page first: currentSrc is what the
    // page actually chose after srcset and <picture>, and a clone of the
    // markup alone brings back lazy placeholders instead.
    const late = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-full-src", "data-hi-res-src", "data-image"];
    const live = [...document.images].map((img) => {
      let src = img.currentSrc || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:") || (img.complete && img.naturalWidth <= 2)) {
        src = "";
        for (const a of late) { const v = img.getAttribute(a); if (v) { src = v; break; } }
      }
      return src;
    });
    const liveAll = [...document.querySelectorAll("*")];
    const copy = document.cloneNode(true);
    // A clone leaves shadow roots behind, and some pages keep their words in
    // one (MDN draws its code blocks that way). An element with nothing of its
    // own to show brings its open shadow root's contents instead.
    const copyAll = [...copy.querySelectorAll("*")];
    liveAll.forEach((el, i) => {
      const into = copyAll[i];
      if (!el.shadowRoot || !into || into.textContent.trim()) return;
      into.replaceChildren(...[...el.shadowRoot.childNodes].map((n) => copy.importNode(n, true)));
    });
    // Words kept for screen readers only ("skip past newsletter promotion")
    // are a pixel square off to the side on the page; in the reader they would
    // be a line of prose.
    liveAll.forEach((el, i) => {
      if (!(el instanceof HTMLElement) || el.offsetWidth > 1 || el.offsetHeight > 1) return;
      if (getComputedStyle(el).position !== "absolute" || !el.textContent.trim()) return;
      copyAll[i]?.remove();
    });
    [...copy.images].forEach((img, i) => {
      if (live[i]) {
        img.setAttribute("src", live[i]);
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
      } else if (img.getAttribute("data-srcset")) {
        img.setAttribute("srcset", img.getAttribute("data-srcset"));
      }
      img.removeAttribute("loading");
    });
    const article = new Readability(copy, { serializer: (el) => el, charThreshold: 400 }).parse();
    if (!article || !article.content || (article.length || 0) < 400) return "none";

    const host = document.createElement("div");
    host.dataset.scheme = ${JSON.stringify(scheme)};
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(STYLE)});
    root.adoptedStyleSheets = [sheet];

    const scroll = document.createElement("div");
    scroll.className = "scroll";
    scroll.tabIndex = -1;
    const main = document.createElement("main");
    if (article.lang) main.lang = article.lang;
    if (article.dir) main.dir = article.dir;
    const title = document.createElement("h1");
    title.className = "title";
    // The page's own headline when Readability's title is it plus the site's
    // name ("... - Web APIs | MDN").
    const headline = (document.querySelector("h1")?.innerText || "").trim();
    title.textContent = headline && (article.title || "").startsWith(headline) ? headline : article.title || document.title;
    const from = document.createElement("p");
    from.className = "from";
    from.textContent = location.host.replace(/^www\\./, "");
    // A table Readability judged to be layout (old sites set a whole essay in
    // one) is its cells' contents, not a grid with padding around the prose.
    for (const t of [...article.content.querySelectorAll("table")]) {
      if (t._readabilityDataTable) continue;
      const cells = [...t.querySelectorAll("td, th")].filter((c) => c.closest("table") === t);
      t.replaceWith(...cells.flatMap((c) => [...c.childNodes]));
    }
    // Readability turns some layout tables into divs and leaves their rows and
    // cells behind; outside a table those are wrappers, and a cell's padding
    // would push the prose off the title's edge.
    for (const el of [...article.content.querySelectorAll("tbody, thead, tfoot, tr, td, th")].reverse()) {
      if (!el.parentElement || !el.parentElement.closest("table")) el.replaceWith(...el.childNodes);
    }
    // A page's own custom elements would upgrade again inside the reader and
    // run the page's code there (MDN's code blocks empty themselves and grow a
    // Copy button): each one becomes the plain element it stands for.
    for (const el of [...article.content.querySelectorAll("*")].reverse()) {
      if (!el.localName.includes("-")) continue;
      const plain = copy.createElement("div");
      plain.append(...el.childNodes);
      el.replaceWith(plain);
    }
    // A reader shows everything: a disclosure is its contents, its summary a
    // line of its own.
    for (const d of [...article.content.querySelectorAll("details")].reverse()) {
      const summary = d.querySelector(":scope > summary");
      if (summary) {
        const line = copy.createElement("p");
        line.append(...summary.childNodes);
        summary.replaceWith(line);
        if (!line.textContent.trim()) line.remove();
      }
      d.replaceWith(...d.childNodes);
    }
    const body = document.createElement("article");
    body.append(...[...article.content.childNodes].map((n) => document.importNode(n, true)));
    // Nothing of the page's own code comes along: no handler attributes, no
    // scripts Readability let through, no picture with nothing behind it.
    for (const el of body.querySelectorAll("*")) {
      for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    }
    for (const el of body.querySelectorAll("script, style, link, noscript, form, button, input, select, textarea")) el.remove();
    for (const img of body.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:")) img.remove();
      else img.loading = "eager";
    }
    // A heading, or a picture of one, that repeats the title is the title twice.
    const said = title.textContent.trim().toLowerCase();
    const first = body.querySelector("h1, h2");
    if (first && first.textContent.trim().toLowerCase() === said) first.remove();
    for (const img of body.querySelectorAll("img[alt]")) {
      if (img.alt.trim().toLowerCase() === said) img.remove();
    }
    main.append(title, from, body);
    scroll.append(main);
    root.append(scroll);

    // The page keeps playing underneath otherwise, with nothing on screen to
    // stop it from.
    for (const m of document.querySelectorAll("video, audio")) if (!m.paused) m.pause();
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    document.documentElement.append(host);
    // Escape leaves, before the page's own key handlers can act on a page
    // that is not on screen. The app hears of it through LEFT_EVENT.
    const onKey = (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.removeEventListener("keydown", onKey, true);
      host.remove();
      document.documentElement.style.overflow = overflow;
      delete window[${JSON.stringify(KEY)}];
      document.dispatchEvent(new CustomEvent(${JSON.stringify(LEFT_EVENT)}));
    };
    window.addEventListener("keydown", onKey, true);
    Object.defineProperty(window, ${JSON.stringify(KEY)}, { value: { host, overflow, onKey }, configurable: true });
    scroll.focus({ preventScroll: true });
    return "on";
  })()`;
}

/// Fired on the document when Escape took the reader away.
const LEFT_EVENT = "ndreader:left";

/// The isolated world and script-message name the app hears Escape through.
/// A world of its own keeps `window.webkit.messageHandlers` out of the page's
/// world, where sites read it as a sign of Safari.
export const READER_WORLD = "ndreader";
export const READER_CHANNEL = "ndReader";

/// Runs in READER_WORLD while the reader is up: DOM events cross worlds, the
/// message handler does not.
export const READER_BRIDGE_SCRIPT = `(() => {
  if (window.__ndReaderBridge) return "ok";
  window.__ndReaderBridge = true;
  document.addEventListener(${JSON.stringify(LEFT_EVENT)}, () => window.webkit.messageHandlers.${READER_CHANNEL}.postMessage("left"));
  return "ok";
})()`;

/// Reading mode on the page, or off it again when it is already up.
export function toggleReaderScript(scheme: Appearance): string {
  return pageScript("toggle", scheme);
}

/// Takes the reader away if it is up. Used when the page changes address
/// without loading a new document, where the reader would otherwise outlive
/// the article it was made from.
export function leaveReaderScript(): string {
  return pageScript("off", "light");
}

/// Follows the app into light or dark while the reader is up.
export function readerSchemeScript(scheme: Appearance): string {
  return pageScript("scheme", scheme);
}

export function readerState(answer: string): ReaderState {
  return answer === "on" || answer === "none" ? answer : "off";
}
