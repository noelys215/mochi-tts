(() => {
  if (globalThis.__mochiAudioInPageTargets) return;

  const IGNORED_SELECTOR = [
    "nav", "header", "footer", "aside", "form", "button", "input", "textarea",
    "select", "option", "pre", "code", "script", "style", "[hidden]",
    "[aria-hidden=\"true\"]", "[role=\"navigation\"]", "[role=\"complementary\"]",
    "[data-mochi-audio-ui]",
  ].join(",");
  const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,option,[role=button],[contenteditable=true]";

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function isIgnored(element) {
    return Boolean(element?.closest?.(IGNORED_SELECTOR));
  }

  function isVisible(element) {
    if (!element || isIgnored(element)) return false;
    const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") return false;
    const rectangles = element.getClientRects?.();
    return !rectangles || rectangles.length > 0;
  }

  function readableText(element, codeMode = "skip") {
    const extractor = globalThis.__mochiAudioArticleExtractor;
    return normalizeText(extractor
      ? extractor.extractFromRoot(element, { codeMode })
      : element?.textContent);
  }

  function directReadableText(element) {
    const documentObject = element?.ownerDocument;
    if (!documentObject?.createTreeWalker) return normalizeText(element?.textContent);
    const values = [];
    const walker = documentObject.createTreeWalker(element, globalThis.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || isIgnored(parent) || !isVisible(parent)) continue;
      const block = parent.closest?.("p,li,blockquote,article,main,section,div");
      if (block && block !== element) continue;
      values.push(walker.currentNode.nodeValue);
    }
    return normalizeText(values.join(" "));
  }

  function linkRatio(element, text) {
    const linkText = [...element.querySelectorAll?.("a") || []]
      .map((link) => readableText(link)).join(" ");
    return text.length ? linkText.length / text.length : 0;
  }

  function isProse(element, minimumLength, codeMode = "skip") {
    if (!isVisible(element)) return false;
    const text = readableText(element, codeMode);
    if (text.length < minimumLength || linkRatio(element, text) > 0.55) return false;
    const controls = element.querySelectorAll?.(INTERACTIVE_SELECTOR).length || 0;
    return controls <= Math.max(2, Math.floor(text.length / 180));
  }

  function qualifiesParagraph(element, minimumLength, codeMode = "skip") {
    return Boolean(element?.matches?.("p") && isProse(element, minimumLength, codeMode));
  }

  function qualifiesSecondaryBlock(element, minimumLength, codeMode = "skip") {
    return Boolean(element?.matches?.("li,blockquote") && isProse(element, minimumLength, codeMode));
  }

  function qualifiesContainer(element, minimumLength, codeMode = "skip") {
    if (!element?.matches?.("section,div") || !isProse(element, minimumLength, codeMode)) return false;
    if ([...element.querySelectorAll("p")].some((child) => qualifiesParagraph(child, minimumLength, codeMode))) {
      return false;
    }
    return directReadableText(element).length >= minimumLength;
  }

  function selectPassageTargets(root, minimumLength = 40, codeMode = "skip") {
    const scope = root?.querySelectorAll ? root : root?.documentElement;
    if (!scope) return [];
    const candidates = [
      ...(scope.matches?.("p,li,blockquote,section,div") ? [scope] : []),
      ...scope.querySelectorAll("p,li,blockquote,section,div"),
    ];
    const selected = candidates.filter((element) => qualifiesParagraph(element, minimumLength, codeMode));
    for (const element of candidates.filter((candidate) =>
      qualifiesSecondaryBlock(candidate, minimumLength, codeMode))) {
      if (!selected.some((chosen) => element.contains(chosen))) selected.push(element);
    }
    const containers = candidates
      .filter((element) => qualifiesContainer(element, minimumLength, codeMode))
      .sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length);
    for (const element of containers) {
      if (selected.some((chosen) => element.contains(chosen))) continue;
      if (containers.some((child) => child !== element && element.contains(child) && qualifiesContainer(child, minimumLength, codeMode))) continue;
      selected.push(element);
    }
    return [...new Set(selected)];
  }

  function overlayPosition(rect, controlWidth, controlHeight, viewportWidth, viewportHeight, offset = 6) {
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > viewportHeight) {
      return null;
    }
    return {
      left: Math.max(8, Math.min(viewportWidth - controlWidth - 8, rect.right - controlWidth)),
      top: Math.max(8, Math.min(viewportHeight - controlHeight - 8, rect.top + offset)),
    };
  }

  function connectedTargets(values) {
    return [...values].filter((element) => element?.isConnected);
  }

  function findPageTarget(documentObject = document, minimumLength = 40, codeMode = "skip") {
    const extractor = globalThis.__mochiAudioArticleExtractor;
    const suitable = (element) => element && isVisible(element) &&
      readableText(element, codeMode).length >= minimumLength;
    const articles = [...documentObject.querySelectorAll("article")]
      .filter(suitable)
      .sort((a, b) => readableText(b, codeMode).length - readableText(a, codeMode).length);
    if (articles[0]) return articles[0];
    const main = documentObject.querySelector("main");
    if (suitable(main)) return main;
    const fallback = extractor?.findRoot(documentObject);
    return suitable(fallback) ? fallback : null;
  }

  globalThis.__mochiAudioInPageTargets = Object.freeze({
    connectedTargets, directReadableText, findPageTarget, isIgnored, isVisible,
    normalizeText, overlayPosition, qualifiesContainer, qualifiesParagraph,
    qualifiesSecondaryBlock, readableText, selectPassageTargets,
  });
})();
