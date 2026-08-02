import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function candidate({ tag = "div", text = "", paragraphs = 2, headings = 1, links = "", controls = 0, children = 8 } = {}) {
  const node = {
    tagName: tag.toUpperCase(), textContent: text,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "p,li,blockquote") return Array(paragraphs).fill({});
      if (selector === "h1,h2,h3,h4") return Array(headings).fill({});
      if (selector === "ul,ol") return [];
      if (selector.includes("button")) return Array(controls).fill({});
      if (selector === "a") return links ? [{ textContent: links }] : [];
      if (selector === "*") return Array(children).fill({});
      return [];
    },
  };
  return node;
}

function documentFixture(selectors, title = "Fixture lesson") {
  return {
    title,
    body: selectors.body || null,
    querySelector: (selector) => selectors[selector]?.[0] || null,
    querySelectorAll: (selector) => selectors[selector] || [],
  };
}

const source = await readFile(new URL("../../extension/content/content-region.js", import.meta.url), "utf8");
const context = vm.createContext({
  __mochiAudioArticleExtractor: {
    isVisible: () => true,
    extractFromRoot: (element) => element.textContent,
  },
});
vm.runInContext(source, context);
const resolver = context.__mochiAudioContentRegion;

test("semantic article and main regions take priority", () => {
  const article = candidate({ tag: "article", text: "a".repeat(180) });
  const main = candidate({ tag: "main", text: "m".repeat(240) });
  const doc = documentFixture({ article: [article], main: [main] });
  assert.equal(resolver.resolvePrimaryContentRegion(doc, { hostname: "example.com" }).element, article);
  assert.equal(resolver.resolvePrimaryContentRegion(doc, { hostname: "example.com" }).strategy, "semantic-article");

  const mainOnly = documentFixture({ article: [], main: [main] });
  assert.equal(resolver.resolvePrimaryContentRegion(mainOnly, { hostname: "example.com" }).strategy, "semantic-main");
});

test("LeetCode adapter prefers block markdown only on approved hosts", () => {
  const markdown = candidate({ text: "lesson ".repeat(40), paragraphs: 3 });
  const selectors = {
    article: [], main: [],
    ".article-inner .block-markdown": [markdown],
    ".article-inner": [], ".block-markdown": [markdown], "section,div": [],
  };
  const doc = documentFixture(selectors);
  const resolved = resolver.resolvePrimaryContentRegion(doc, { hostname: "leetcode.com" });
  assert.equal(resolved.element, markdown);
  assert.equal(resolved.strategy, "site-adapter");
  assert.equal(resolved.siteId, "leetcode");
  assert.equal(resolver.resolvePrimaryContentRegion(doc, { hostname: "fakeleetcode.com" }), null);
  assert.equal(resolver.isLeetCodeHostname("leetcode.example.com"), false);
});

test("generic fallback chooses a validated prose region and excludes navigation shells", () => {
  const prose = candidate({ text: "explanation ".repeat(30), paragraphs: 4, links: "" });
  const navigation = candidate({ text: "links ".repeat(40), paragraphs: 4, links: "links ".repeat(35) });
  const doc = documentFixture({ article: [], main: [], "section,div": [navigation, prose] });
  const resolved = resolver.resolvePrimaryContentRegion(doc, { hostname: "example.com" });
  assert.equal(resolved.element, prose);
  assert.equal(resolved.strategy, "prose-fallback");
});
