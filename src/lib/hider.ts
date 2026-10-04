/// ⇧⌘H, "hide anything, for good", after the Search browser's Curtain: point
/// at an element, click, and it is gone on that site from then on. The pick
/// becomes a `site##selector` user rule (lib/adblock.ts), which the blocker
/// applies at document start, so a hidden element is never seen arriving.
///
/// The picker lives in an isolated world of every tab's main frame, asleep
/// until `__nbHide.on()`. Esc or ⇧⌘H again puts it away.

export const HIDER_WORLD = "nb-hide";
export const HIDER_CHANNEL = "nbVeil";

export interface Pick {
  selector: string;
  label: string;
  note: string;
}

export type HiderMessage = { pick: Pick } | { off: true } | { trouble: string };

export const HIDER_SOURCE = `(function () {
  if (window.__nbHide) return;
  var post = function (m) {
    try { window.webkit.messageHandlers.${HIDER_CHANNEL}.postMessage(m); } catch (e) {}
  };
  var frame = null, tag = null, target = null, live = false;

  function chrome() {
    if (frame) return frame;
    frame = document.createElement('div');
    frame.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;' +
      'border:2px solid rgba(23,23,23,.9);background:rgba(23,23,23,.07);' +
      'border-radius:4px;transition:all .07s ease-out;display:none';
    tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;font:500 11px system-ui,sans-serif;color:#fff;' +
      'background:#171717;padding:2px 7px;border-radius:5px;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis';
    frame.appendChild(tag);
    document.documentElement.appendChild(frame);
    return frame;
  }

  function place(el) {
    var box = chrome(), r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    tag.textContent = name(el);
    // Above the element when there is room, inside its top edge when there is
    // not, so a name at the top of the window is never cut off.
    tag.style.top = r.top >= 26 ? '-21px' : '3px';
    tag.style.left = Math.max(2, -r.left + 4) + 'px';
    tag.style.maxWidth = Math.max(80, window.innerWidth - Math.max(0, r.left) - 16) + 'px';
  }

  var known = {
    nav: 'Navigation', header: 'Header', footer: 'Footer', aside: 'Sidebar',
    form: 'Form', dialog: 'Dialog', video: 'Video', img: 'Image',
    button: 'Button', iframe: 'Embed', figure: 'Figure', table: 'Table'
  };

  function name(el) {
    var said = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (said && said.trim()) return clip(said.trim(), 40);
    var tagName = el.tagName.toLowerCase();
    if (known[tagName]) return known[tagName];
    var role = el.getAttribute && el.getAttribute('role');
    if (role) return role.charAt(0).toUpperCase() + role.slice(1);
    var text = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    return text ? clip(text, 40) : tagName;
  }

  // Size and corner: two sidebars read alike, they rarely share a shape and a place.
  function shape(el) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var side = cx < innerWidth / 3 ? 'left' : (cx > innerWidth * 2 / 3 ? 'right' : 'centre');
    var band = cy < innerHeight / 3 ? 'top' : (cy > innerHeight * 2 / 3 ? 'bottom' : 'middle');
    return Math.round(r.width) + '×' + Math.round(r.height) + ' · ' + band + ' ' + side;
  }

  function clip(text, n) { return text.length > n ? text.slice(0, n) + '…' : text; }

  // A class worth hanging a rule on: a word, not a build artefact.
  function steady(c) {
    return /^[a-zA-Z][\\w-]{2,29}$/.test(c) && !/\\d{3,}/.test(c) &&
      !/^(css|sc|jsx|emotion|svelte|styles?)-/.test(c);
  }

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  function selectorFor(el) {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    var hooks = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'role'];
    for (var i = 0; i < hooks.length; i++) {
      var v = el.getAttribute && el.getAttribute(hooks[i]);
      if (v) {
        var s = el.tagName.toLowerCase() + '[' + hooks[i] + '="' + CSS.escape(v) + '"]';
        if (unique(s)) return s;
      }
    }
    var classes = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\\s+/).filter(steady) : [];
    if (classes.length) {
      var byClass = el.tagName.toLowerCase() + '.' + classes.map(CSS.escape).join('.');
      if (unique(byClass)) return byClass;
    }
    var parts = [], node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && unique('#' + CSS.escape(node.id))) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var tagName = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tagName); break; }
      var kin = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
      parts.unshift(kin.length > 1 ? tagName + ':nth-of-type(' + (kin.indexOf(node) + 1) + ')' : tagName);
      node = parent;
    }
    return parts.join(' > ');
  }

  function onMove(e) {
    if (!live) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === frame || el === document.documentElement || el === document.body) return;
    target = el;
    place(el);
  }

  // Pages act on pointerdown or mousedown and are gone before a click lands,
  // so every kind of press is swallowed while picking.
  function swallow(e) {
    if (!live) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onPress(e) {
    if (!live) return;
    swallow(e);
    var el = target || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === frame || el === document.documentElement || el === document.body) return;
    try {
      var pick = { selector: selectorFor(el), label: name(el), note: shape(el) };
      el.style.setProperty('display', 'none', 'important');
      post({ pick: pick });
    } catch (err) {
      post({ trouble: String(err) });
    }
    target = null;
    if (frame) frame.style.display = 'none';
  }

  function onKey(e) {
    if (live && e.key === 'Escape') {
      swallow(e);
      off();
    }
  }

  var presses = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart'];

  function on() {
    if (live) return;
    live = true;
    chrome();
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('keydown', onKey, true);
    presses.forEach(function (kind) {
      document.addEventListener(kind, kind === 'pointerdown' ? onPress : swallow, true);
    });
  }

  function off() {
    if (!live) return;
    live = false;
    target = null;
    if (frame) frame.style.display = 'none';
    document.documentElement.style.cursor = '';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    presses.forEach(function (kind) {
      document.removeEventListener(kind, kind === 'pointerdown' ? onPress : swallow, true);
    });
    post({ off: true });
  }

  window.__nbHide = { on: on, off: off, toggle: function () { live ? off() : on(); } };
})();`;
