import { describe, expect, test } from "bun:test";
import { Messages, applySubstitutions, localeChain, resolveMessageRefs } from "./i18n.ts";

describe("applySubstitutions", () => {
  test("fills positional arguments", () => {
    expect(applySubstitutions({ message: "Hello $1, you have $2" }, ["Ada", "3"])).toBe("Hello Ada, you have 3");
  });

  test("a single string is treated as one argument", () => {
    expect(applySubstitutions({ message: "Hi $1" }, "Ada")).toBe("Hi Ada");
  });

  test("missing arguments become empty, not the literal token", () => {
    expect(applySubstitutions({ message: "a$1b$2c" }, ["x"])).toBe("axbc");
  });

  test("$$ is a literal dollar sign", () => {
    expect(applySubstitutions({ message: "costs $$5" }, [])).toBe("costs $5");
    expect(applySubstitutions({ message: "$$1" }, ["nope"])).toBe("$1");
  });

  test("named placeholders resolve through their content", () => {
    const entry = {
      message: "Welcome back, $USER$!",
      placeholders: { user: { content: "$1", example: "Ada" } },
    };
    expect(applySubstitutions(entry, ["Ada"])).toBe("Welcome back, Ada!");
  });

  test("an unknown named placeholder is left alone", () => {
    expect(applySubstitutions({ message: "hi $WHO$" }, [])).toBe("hi $WHO$");
  });

  test("a placeholder with literal content needs no argument", () => {
    const entry = { message: "See $LINK$", placeholders: { LINK: { content: "example.test" } } };
    expect(applySubstitutions(entry, [])).toBe("See example.test");
  });
});

describe("resolveMessageRefs", () => {
  test("replaces every __MSG_key__ it can resolve", () => {
    const out = resolveMessageRefs("__MSG_name__ — __MSG_tagline__", (k) => (k === "name" ? "Dark Reader" : null));
    expect(out).toBe("Dark Reader — __MSG_tagline__");
  });
});

describe("localeChain", () => {
  test("walks from the specific locale to the extension default", () => {
    expect(localeChain("pt_BR", "en")).toEqual(["pt_BR", "pt", "en"]);
    expect(localeChain("en-GB", "en")).toEqual(["en_GB", "en"]);
    expect(localeChain("en", "en")).toEqual(["en"]);
  });
});

describe("Messages", () => {
  const messages = new Messages([{ greeting: { message: "Hallo $1" } }, { greeting: { message: "Hello $1" }, only_en: { message: "Fallback" } }]);

  test("the first catalog with the key wins", () => {
    expect(messages.get("greeting", ["Ada"])).toBe("Hallo Ada");
  });

  test("falls through to a later catalog", () => {
    expect(messages.get("only_en")).toBe("Fallback");
  });

  test("an unknown key is the empty string, as Chrome returns", () => {
    expect(messages.get("missing")).toBe("");
    expect(messages.has("missing")).toBe(false);
  });
});
