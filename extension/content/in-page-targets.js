(() => {
  if (globalThis.__mochiAudioInPageTargets) return;

  const IGNORED_SELECTOR = [
    "nav", "header", "footer", "aside", "form", "button", "input", "textarea",
    "select", "option", "pre", ".codehilite", "script", "style", "iframe", "video",
    "audio", "canvas", "[hidden]", "[role=\"navigation\"]", "[role=\"complementary\"]",
    "[data-mochi-audio-ui]",
  ].join(",");
  const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,option,[role=button],[contenteditable=true]";

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function isIgnored(element) {
    if (element?.closest?.(IGNORED_SELECTOR)) return true;
    const hidden = element?.closest?.('[aria-hidden="true"]');
    return Boolean(hidden && !hidden.closest?.(".katex"));
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

  function findPassageTarget(start, minimumLength = 40, codeMode = "skip", region = null) {
    if (!start?.closest || isIgnored(start)) return null;
    const within = (element) => element && (!region || region.contains(element));
    const paragraph = start.closest("p");
    if (within(paragraph) && qualifiesParagraph(paragraph, minimumLength, codeMode)) return paragraph;
    for (const selector of ["li", "blockquote"]) {
      const candidate = start.closest(selector);
      if (within(candidate) && qualifiesSecondaryBlock(candidate, minimumLength, codeMode)) return candidate;
    }
    for (let candidate = start.closest("div,section"); candidate && within(candidate);
      candidate = candidate.parentElement?.closest?.("div,section")) {
      if (qualifiesContainer(candidate, minimumLength, codeMode)) return candidate;
      if (candidate === region) break;
    }
    const semantic = start.closest("article,main");
    return within(semantic) && isProse(semantic, minimumLength, codeMode) ? semantic : null;
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
    const resolved = globalThis.__mochiAudioContentRegion
      ?.resolvePrimaryContentRegion(documentObject, documentObject.location || globalThis.location);
    return resolved && readableText(resolved.element, codeMode).length >= minimumLength ? resolved : null;
  }

  function isPageTrigger(start, region, pointerY) {
    if (!start || !region?.element) return false;
    if (region.titleElement?.contains?.(start) || start.closest?.("h1,h2,h3") === region.titleElement) return true;
    if (!region.element.contains(start)) return false;
    const rect = region.element.getBoundingClientRect?.();
    return Boolean(rect && Number.isFinite(pointerY) && pointerY <= rect.top + Math.min(140, rect.height * 0.25));
  }

  globalThis.__mochiAudioInPageTargets = Object.freeze({
    connectedTargets, directReadableText, findPageTarget, findPassageTarget, isIgnored, isPageTrigger, isVisible,
    normalizeText, overlayPosition, qualifiesContainer, qualifiesParagraph,
    qualifiesSecondaryBlock, readableText,
  });
})();
