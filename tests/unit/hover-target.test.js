import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../extension/content/hover-target.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const api = context.__fishStudyReaderHoverTarget;

const ignoredTags = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "input",
  "textarea",
  "select",
  "pre",
  "code",
]);

function fakeElement(tag, { text = "", parent = null, hidden = false, owned = false } = {}) {
  const element = {
    tag,
    textContent: text,
    parent,
    hidden,
    owned,
    matches(selector) {
      return selector === "p,article" && (this.tag === "p" || this.tag === "article");
    },
    closest(selector) {
      for (let current = this; current; current = current.parent) {
        if (selector === "p" && current.tag === "p") {
          return current;
        }
        if (selector === "article" && current.tag === "article") {
          return current;
        }
        if (
          selector.includes("data-fish-study-reader-ui") &&
          (ignoredTags.has(current.tag) || current.owned)
        ) {
          return current;
        }
      }
      return null;
    },
    getAttribute(name) {
      return name === "aria-hidden" && hidden ? "true" : null;
    },
    getClientRects() {
      return hidden ? [] : [{}];
    },
  };
  return element;
}

test("nearest eligible paragraph wins over its article", () => {
  const article = fakeElement("article", {
    text: "A long article passage with enough useful study text for reading.",
  });
  const paragraph = fakeElement("p", {
    parent: article,
    text: "A focused paragraph with enough useful study text for reading.",
  });
  const span = fakeElement("span", { parent: paragraph });
  assert.equal(api.findHoverTarget(span, 20), paragraph);
});

test("eligible article is the fallback when no paragraph qualifies", () => {
  const article = fakeElement("article", {
    text: "A long article passage with enough useful study text for reading.",
  });
  const child = fakeElement("div", { parent: article });
  assert.equal(api.findHoverTarget(child, 20), article);
});

test("all blocked and extension-owned regions are ignored", () => {
  for (const tag of ignoredTags) {
    const article = fakeElement("article", {
      text: "A long article passage that otherwise qualifies for hover reading.",
    });
    const blocked = fakeElement(tag, { parent: article });
    const child = fakeElement("span", { parent: blocked });
    assert.equal(api.findHoverTarget(child, 10), null, tag);
  }

  const owned = fakeElement("div", { owned: true });
  const child = fakeElement("span", { parent: owned });
  assert.equal(api.findHoverTarget(child, 1), null);
});

test("hidden, empty, and below-minimum passages are ignored", () => {
  assert.equal(
    api.findHoverTarget(fakeElement("p", { text: "Long but hidden", hidden: true }), 5),
    null,
  );
  assert.equal(api.findHoverTarget(fakeElement("p", { text: "   " }), 1), null);
  assert.equal(api.findHoverTarget(fakeElement("p", { text: "short" }), 10), null);
});
