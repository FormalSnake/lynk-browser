import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  CHROME_VERSION,
  INSTALL_SCORE_THRESHOLD,
  WEBSTORE_MATCH,
  chromeUserAgent,
  installControlSignals,
  isInstallControl,
  isWebstoreUrl,
  parseWebstoreInstall,
  scoreInstallControl,
  webstoreHookSource,
  webstoreInstallMessage,
  webstoreListingId,
  type ControlNode,
} from "./webstore.ts";

const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
const FIXTURE = resolve(import.meta.dir, "..", "..", "fixtures", "webstore-listing", "index.html");

// Void elements never produce an end tag, so they are attached without being
// pushed. HTMLRewriter throws outright on `onEndTag` for one.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/// The hook reads a real `Element` in the page and a `FixtureElement` here.
/// `tsc` fails on this line the moment those two stop being the same shape,
/// which is what keeps the test honest about what it is exercising.
const ELEMENT_IS_A_CONTROL_NODE: Element extends ControlNode ? true : false = true;

/// Enough of a DOM to run the real matcher over real markup. It implements
/// `ControlNode`, which a browser's `Element` also satisfies, so the test and
/// the injected hook exercise the same code rather than two spellings of it.
class FixtureElement implements ControlNode {
  readonly nodes: (string | FixtureElement)[] = [];
  parentElement: FixtureElement | null = null;

  constructor(
    readonly localName: string,
    private readonly attrs: Map<string, string>,
  ) {}

  get textContent(): string {
    return this.nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }
}

async function parseHtml(html: string): Promise<FixtureElement> {
  const document = new FixtureElement("#document", new Map());
  const stack: FixtureElement[] = [document];
  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const parent = stack[stack.length - 1]!;
      const node = new FixtureElement(el.tagName.toLowerCase(), new Map([...el.attributes]));
      node.parentElement = parent === document ? null : parent;
      parent.nodes.push(node);
      if (VOID.has(node.localName)) return;
      stack.push(node);
      el.onEndTag(() => {
        stack.pop();
      });
    },
    text(chunk) {
      stack[stack.length - 1]!.nodes.push(chunk.text);
    },
  });
  await rewriter.transform(new Response(html)).text();
  return document;
}

function descendants(node: FixtureElement): FixtureElement[] {
  return node.nodes.flatMap((child) => (typeof child === "string" ? [] : [child, ...descendants(child)]));
}

function labelOf(element: FixtureElement): string {
  return element.getAttribute("aria-label") ?? element.textContent.replace(/\s+/g, " ").trim();
}

// The store is unreachable from a headless offline box, so the fixture is
// served locally at a listing-shaped path. Nothing in this file touches the
// network.
let origin = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const html = await Bun.file(FIXTURE).text();
      const headers = { "content-type": "text/html; charset=utf-8" };
      // The same listing with its install control gone, which is what the hook
      // sees on every store page that is not a detail page.
      if (new URL(request.url).pathname.endsWith("/reviews")) {
        return new HTMLRewriter()
          .on('button[aria-label="Add to Chrome"]', {
            element(el) {
              el.remove();
            },
          })
          .transform(new Response(html, { headers }));
      }
      return new Response(html, { headers });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function fixturePage(path: string): Promise<FixtureElement> {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(200);
  return parseHtml(await response.text());
}

const LISTING_PATH = `/detail/dark-reader/${DARK_READER}`;

describe("webstoreListingId", () => {
  test("reads the id out of every listing shape the store hands out", () => {
    const store = "https://chromewebstore.google.com";
    expect(webstoreListingId(`${store}/detail/dark-reader/${DARK_READER}`)).toBe(DARK_READER);
    expect(webstoreListingId(`${store}/detail/${DARK_READER}`)).toBe(DARK_READER);
    expect(webstoreListingId(`${store}/detail/dark-reader/${DARK_READER}?hl=en&authuser=0`)).toBe(DARK_READER);
    expect(webstoreListingId(`${store}/detail/dark-reader/${DARK_READER}/reviews`)).toBe(DARK_READER);
    expect(webstoreListingId(`${store}/detail/dark-reader/${DARK_READER}/related?hl=fr#top`)).toBe(DARK_READER);
  });

  test("a store page that is not a listing has no id", () => {
    expect(webstoreListingId("https://chromewebstore.google.com/")).toBeNull();
    expect(webstoreListingId("https://chromewebstore.google.com/category/extensions")).toBeNull();
    expect(webstoreListingId("https://chromewebstore.google.com/detail/dark-reader")).toBeNull();
  });

  test("only the store's own origin counts, since the id is what gets downloaded", () => {
    expect(webstoreListingId(`https://evil.test/detail/dark-reader/${DARK_READER}`)).toBeNull();
    expect(webstoreListingId(`https://chromewebstore.google.com.evil.test/detail/${DARK_READER}`)).toBeNull();
    expect(webstoreListingId("not a url at all")).toBeNull();
  });

  test("an id outside the a-p alphabet is not an id", () => {
    expect(webstoreListingId("https://chromewebstore.google.com/detail/slug/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });
});

describe("the hook against the fixture listing", () => {
  test("a browser Element is the shape the matcher reads", () => {
    expect(ELEMENT_IS_A_CONTROL_NODE).toBe(true);
  });

  test("matches exactly one control, and it is the install button", async () => {
    const page = await fixturePage(LISTING_PATH);
    const matched = descendants(page).filter((el) => isInstallControl(el));
    expect(matched).toHaveLength(1);
    expect(labelOf(matched[0]!)).toBe("Add to Chrome");
  });

  test("leaves every neighbouring control alone", async () => {
    const page = await fixturePage(LISTING_PATH);
    for (const label of ["Search", "Share", "Remove from Chrome"]) {
      const element = descendants(page).find((el) => labelOf(el) === label);
      expect(element).toBeDefined();
      expect(isInstallControl(element!)).toBe(false);
    }
  });

  test("the right words in the wrong place are not enough on their own", async () => {
    const page = await fixturePage(LISTING_PATH);
    // The footer's button reads "Add to Chrome" and nothing else agrees: no
    // store hook, no listing container.
    const buttons = descendants(page).filter((el) => el.localName === "button" && labelOf(el) === "Add to Chrome");
    expect(buttons).toHaveLength(2);
    const stray = buttons.find((el) => !installControlSignals(el).inListing)!;
    const signals = installControlSignals(stray);
    expect(signals.label).toBe("add to chrome");
    expect(signals.storeHook).toBe(false);
    expect(scoreInstallControl(signals)).toBeLessThan(INSTALL_SCORE_THRESHOLD);
  });

  test("a page with no install control gives the hook nothing to do", async () => {
    const page = await fixturePage(`${LISTING_PATH}/reviews`);
    expect(descendants(page).filter((el) => isInstallControl(el))).toHaveLength(0);
  });
});

describe("scoreInstallControl", () => {
  const install = {
    activatable: true,
    label: "add to chrome",
    storeHook: true,
    inListing: true,
    disabled: false,
  };

  test("the label alone does not carry a match", () => {
    expect(scoreInstallControl({ ...install, storeHook: false, inListing: false })).toBeLessThan(
      INSTALL_SCORE_THRESHOLD,
    );
  });

  test("either corroborating signal is enough alongside the label", () => {
    expect(scoreInstallControl({ ...install, storeHook: false })).toBeGreaterThanOrEqual(INSTALL_SCORE_THRESHOLD);
    expect(scoreInstallControl({ ...install, inListing: false })).toBeGreaterThanOrEqual(INSTALL_SCORE_THRESHOLD);
  });

  test("corroborating signals alone carry nothing", () => {
    expect(scoreInstallControl({ ...install, label: "share" })).toBeLessThan(INSTALL_SCORE_THRESHOLD);
  });

  test("text that is not activatable is never a control", () => {
    expect(scoreInstallControl({ ...install, activatable: false })).toBe(0);
  });

  test("the store's disabled state is refused rather than clicked through", () => {
    expect(scoreInstallControl({ ...install, disabled: true })).toBe(0);
  });
});

describe("the install message", () => {
  test("round-trips the shape the broker parses", () => {
    const message = webstoreInstallMessage(DARK_READER, "Dark Reader - Chrome Web Store");
    expect(message).toEqual({ k: "webstoreInstall", id: DARK_READER, name: "Dark Reader - Chrome Web Store" });
    expect(parseWebstoreInstall(message)).toEqual(message);
  });

  test("a name is optional and arrives empty rather than absent", () => {
    expect(parseWebstoreInstall({ k: "webstoreInstall", id: DARK_READER })?.name).toBe("");
  });

  test("anything the broker cannot act on is refused", () => {
    expect(parseWebstoreInstall(null)).toBeNull();
    expect(parseWebstoreInstall("webstoreInstall")).toBeNull();
    expect(parseWebstoreInstall({ k: "hello", id: DARK_READER })).toBeNull();
    expect(parseWebstoreInstall({ k: "webstoreInstall", id: "../../etc/passwd" })).toBeNull();
    expect(parseWebstoreInstall({ k: "webstoreInstall", id: DARK_READER.toUpperCase() })).toBeNull();
  });
});

describe("the injected source", () => {
  test("parses, and still carries the functions it embeds by source text", () => {
    const source = webstoreHookSource();
    for (const name of ["webstoreListingId", "installControlSignals", "scoreInstallControl", "webstoreInstallMessage"]) {
      expect(source).toContain(`function ${name}(`);
    }
    expect(() => new Function(source)).not.toThrow();
  });
});

describe("origin scoping", () => {
  test("the allow list and the user-agent override cover the same one origin", () => {
    expect(WEBSTORE_MATCH).toBe("https://chromewebstore.google.com/*");
    expect(isWebstoreUrl(`https://chromewebstore.google.com${LISTING_PATH}`)).toBe(true);
    expect(isWebstoreUrl("https://chromewebstore.google.com/")).toBe(true);
    expect(isWebstoreUrl("https://google.com/")).toBe(false);
    expect(isWebstoreUrl("https://chromewebstore.google.com.evil.test/")).toBe(false);
    expect(isWebstoreUrl("")).toBe(false);
  });

  test("the user agent claims the same Chrome build the CRX endpoint is asked for", () => {
    expect(chromeUserAgent("linux")).toContain(`Chrome/${CHROME_VERSION}.0.0.0`);
    expect(chromeUserAgent("linux")).toContain("X11; Linux x86_64");
    expect(chromeUserAgent("darwin")).toContain("Macintosh; Intel Mac OS X");
  });
});
