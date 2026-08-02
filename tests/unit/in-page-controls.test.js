import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ignoredTags = new Set([
  "nav", "header", "footer", "aside", "form", "button", "input", "textarea",
  "select", "option", "pre", "code", "script", "style",
]);
const documentObject = {
  defaultView: { getComputedStyle: (element) => ({
    display: element.hidden ? "none" : "block", visibility: "visible", opacity: "1",
  }) },
};

function element(tag, text = "", children = [], options = {}) {
  const node = {
    tag, ownText: text, children, parent: null, hidden: Boolean(options.hidden),
    ownerDocument: documentObject,
    get tagName() { return tag.toUpperCase(); },
    get textContent() { return [this.ownText, ...this.children.map((child) => child.textContent)].join(" "); },
    matches(selector) { return selector.split(",").map((part) => part.trim()).includes(this.tag); },
    closest(selector) {
      for (let current = this; current; current = current.parent) {
        if (selector === "p,article,section,div" && ["p", "article", "section", "div"].includes(current.tag)) return current;
        if (selector.includes("nav") && ignoredTags.has(current.tag)) return current;
        if (selector.includes("[hidden]") && current.hidden) return current;
        if (selector.includes("data-mochi-audio-ui") && current.owned) return current;
      }
      return null;
    },
    querySelectorAll(selector) {
      const all = [];
      const visit = (child) => { all.push(child); child.children.forEach(visit); };
      this.children.forEach(visit);
      if (selector === "*") return all;
      if (selector === "a") return all.filter((child) => child.tag === "a");
      if (selector === "p") return all.filter((child) => child.tag === "p");
      if (selector.includes("button") || selector.includes("contenteditable")) {
        return all.filter((child) => ["a", "button", "input", "textarea", "select", "option"].includes(child.tag));
      }
      const tags = selector.split(",").map((part) => part.trim());
      return all.filter((child) => tags.includes(child.tag));
    },
    contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
    getAttribute(name) { return name === "aria-hidden" && this.hidden ? "true" : null; },
    getClientRects() { return this.hidden ? [] : [{}]; },
  };
  children.forEach((child) => { child.parent = node; });
  return node;
}

const targetsSource = await readFile(new URL("../../extension/content/in-page-targets.js", import.meta.url), "utf8");
const targetContext = vm.createContext({ NodeFilter: { SHOW_TEXT: 4 } });
vm.runInContext(targetsSource, targetContext);
const targets = targetContext.__mochiAudioInPageTargets;

test("paragraphs win over wrapper divs without duplicate controls", () => {
  const paragraph = element("p", "Focused paragraph prose long enough to become a useful reading passage.");
  const wrapper = element("div", "", [paragraph]);
  const article = element("article", "", [wrapper]);
  assert.deepEqual([...targets.selectPassageTargets(article, 30)], [paragraph]);
});

test("leaf text-heavy divs qualify while ignored and link-heavy regions do not", () => {
  const leaf = element("div", "A leaf container contains meaningful standalone prose for the reader.");
  assert.equal(targets.qualifiesContainer(leaf, 30), true);

  const ignored = element("p", "Navigation prose is long but must remain ignored.");
  element("nav", "", [ignored]);
  assert.equal(targets.qualifiesParagraph(ignored, 20), false);

  const link = element("a", "Nearly all of this paragraph is one large navigation link.");
  const linked = element("p", "tiny", [link]);
  assert.equal(targets.qualifiesParagraph(linked, 20), false);
});

test("one suitable article is selected for whole-page reading", () => {
  const short = element("article", "brief");
  const long = element("article", "A complete article has enough meaningful prose to support page reading.");
  const fakeDocument = {
    querySelectorAll: (selector) => selector === "article" ? [short, long] : [],
    querySelector: () => null,
    body: null,
  };
  assert.equal(targets.findPageTarget(fakeDocument, 30), long);
});

const playerSource = await readFile(new URL("../../extension/content/in-page-player-state.js", import.meta.url), "utf8");
const playerContext = vm.createContext({});
vm.runInContext(playerSource, playerContext);
const player = playerContext.__mochiAudioInPagePlayerState;

test("player maps current-chunk progress without inventing unknown duration", () => {
  const loading = player.map({
    playback: { status: "paused", currentTime: 4, duration: 0 },
    queue: { currentIndex: 1, entries: [{}, {}, {}] },
  });
  assert.equal(loading.determinate, false);
  assert.equal(loading.durationLabel, "Loading");
  assert.equal(loading.queueLabel, "Chunk 2 of 3");

  const known = player.map({
    playback: { status: "playing", currentTime: 65.8, duration: 120 },
    queue: { currentIndex: 0, entries: [{}] },
  });
  assert.equal(known.currentTime, 65.8);
  assert.equal(known.elapsedLabel, "1:05");
  assert.equal(known.durationLabel, "2:00");
});
