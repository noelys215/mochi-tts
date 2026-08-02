(() => {
  if (globalThis.__mochiAudioArticleExtractor) return;

  const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li";
  const EXCLUDED_SELECTOR = [
    "nav", "header", "footer", "aside", "form", "button", "input",
    "textarea", "select", "script", "style", "iframe", "video", "audio", "canvas",
    "[hidden]", "[aria-hidden=\"true\"]",
    "[role=\"navigation\"]", "[role=\"complementary\"]",
    ".sidebar", ".navigation", ".content-title-base a", "[data-mochi-audio-ui]",
  ].join(",");

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
    const rectangles = element.getClientRects?.();
    return !rectangles || rectangles.length > 0;
  }

  function isExcluded(element) {
    return Boolean(element?.closest?.(EXCLUDED_SELECTOR));
  }

  function visibleText(root, { includeCode = false } = {}) {
    const documentObject = root?.ownerDocument;
    if (!documentObject?.createTreeWalker) return normalizeText(root?.textContent);
    const values = [];
    const processedMath = new Set();
    const walker = documentObject.createTreeWalker(root, globalThis.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent) continue;
      const math = parent.closest?.(".katex") || parent.closest?.("math");
      if (math) {
        if (processedMath.has(math)) continue;
        processedMath.add(math);
        if (isExcluded(math) || !isVisible(math)) continue;
        const annotation = math.querySelector?.('annotation[encoding="application/x-tex"]');
        const preferred = normalizeText(annotation?.textContent) ||
          normalizeText(math.getAttribute?.("aria-label")) || normalizeText(math.textContent);
        if (preferred) values.push(preferred);
        continue;
      }
      if (isExcluded(parent) || !isVisible(parent)) continue;
      if (!includeCode && parent.closest?.("pre,.codehilite")) continue;
      values.push(walker.currentNode.nodeValue);
    }
    return normalizeText(values.join(" "));
  }

  function codeComments(value) {
    const comments = [];
    for (const match of value.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?:^|\n)\s*#[^\n]*/g)) {
      const comment = normalizeText(match[0].replace(/^\s*\/\*|\*\/\s*$|^\s*\/\/|^\s*#/g, ""));
      if (comment) comments.push(comment);
    }
    return comments.join(" ");
  }

  function extractCode(root, codeMode) {
    if (codeMode === "skip") return [];
    return [...root.querySelectorAll?.("pre,.codehilite") || []]
      .filter((element) => !element.closest?.(".codehilite pre") && !isExcluded(element) && isVisible(element))
      .map((element) => codeMode === "comments"
        ? codeComments(element.textContent || "")
        : `Code: ${normalizeText(element.textContent)}`)
      .filter(Boolean);
  }

  function extractFromRoot(root, options = {}) {
    if (!root || isExcluded(root) || !isVisible(root)) return "";
    const codeMode = ["skip", "comments", "literal"].includes(options.codeMode)
      ? options.codeMode
      : "skip";
    const candidates = [
      ...(root.matches?.(BLOCK_SELECTOR) ? [root] : []),
      ...root.querySelectorAll?.(BLOCK_SELECTOR) || [],
    ];
    const prose = candidates
      .filter((element) => !isExcluded(element) && isVisible(element))
      .filter((element) => element.closest?.("p,li") === element || !element.closest?.("p,li"))
      .map((element) => visibleText(element))
      .filter(Boolean);
    const blocks = [...prose, ...extractCode(root, codeMode)];
    return blocks.length ? blocks.join("\n\n") : visibleText(root);
  }

  function findRoot(documentObject = document) {
    const resolved = globalThis.__mochiAudioContentRegion
      ?.resolvePrimaryContentRegion(documentObject, documentObject.location || globalThis.location);
    if (resolved?.element) return resolved.element;
    const articles = [...documentObject.querySelectorAll("article")]
      .filter((element) => !isExcluded(element) && isVisible(element));
    if (articles.length) {
      return articles.sort((a, b) => visibleText(b).length - visibleText(a).length)[0];
    }
    return documentObject.querySelector("main") || documentObject.body;
  }

  function extractArticle(options = {}) {
    const root = findRoot(options.documentObject || document);
    return { text: extractFromRoot(root, options), rootTag: root?.tagName?.toLowerCase() || null };
  }

  globalThis.__mochiAudioArticleExtractor = Object.freeze({
    codeComments, extractArticle, extractFromRoot, findRoot, isExcluded,
    isVisible, normalizeText, visibleText,
  });
})();
