(() => {
  if (globalThis.__fishStudyReaderHoverTarget) {
    return;
  }

  const IGNORED_SELECTOR = [
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
    "[data-fish-study-reader-ui]",
  ].join(",");

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function isIgnored(element) {
    return Boolean(element?.closest?.(IGNORED_SELECTOR));
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(element);
    if (style?.display === "none" || style?.visibility === "hidden") {
      return false;
    }
    const rectangles = element.getClientRects?.();
    return !rectangles || rectangles.length > 0;
  }

  function getVisibleText(element) {
    const documentObject = element?.ownerDocument;
    if (!documentObject?.createTreeWalker) {
      return normalizeText(element?.textContent);
    }

    const text = [];
    const walker = documentObject.createTreeWalker(
      element,
      globalThis.NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && !isIgnored(parent) && isVisible(parent)) {
        text.push(walker.currentNode.nodeValue);
      }
    }
    return normalizeText(text.join(" "));
  }

  function isEligible(element, minimumLength) {
    return Boolean(
      element?.matches?.("p,article") &&
        !isIgnored(element) &&
        isVisible(element) &&
        getVisibleText(element).length >= minimumLength,
    );
  }

  function findHoverTarget(start, minimumLength = 40) {
    if (!start?.closest || isIgnored(start)) {
      return null;
    }
    const paragraph = start.closest("p");
    if (isEligible(paragraph, minimumLength)) {
      return paragraph;
    }
    const article = start.closest("article");
    return isEligible(article, minimumLength) ? article : null;
  }

  globalThis.__fishStudyReaderHoverTarget = Object.freeze({
    findHoverTarget,
    getVisibleText,
    isEligible,
    isIgnored,
    isVisible,
    normalizeText,
  });
})();
