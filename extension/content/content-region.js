(() => {
  if (globalThis.__mochiAudioContentRegion) return;

  const LEETCODE_HOSTS = new Set(["leetcode.com", "www.leetcode.com"]);
  const EXCLUDED = "nav,header,footer,aside,form,[role=navigation],[role=complementary],[data-mochi-audio-ui]";

  const normalize = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const extractor = () => globalThis.__mochiAudioArticleExtractor;

  function isLeetCodeHostname(hostname) {
    return LEETCODE_HOSTS.has(String(hostname || "").toLowerCase());
  }

  function metrics(element) {
    if (!element || element.closest?.(EXCLUDED) || !extractor()?.isVisible(element)) return null;
    const text = normalize(extractor().extractFromRoot(element, { codeMode: "skip" }));
    const paragraphCount = element.querySelectorAll?.("p,li,blockquote")?.length || 0;
    const headingCount = element.querySelectorAll?.("h1,h2,h3,h4")?.length || 0;
    const listCount = element.querySelectorAll?.("ul,ol")?.length || 0;
    const controlCount = element.querySelectorAll?.("button,input,textarea,select,[role=button]")?.length || 0;
    const linkText = [...element.querySelectorAll?.("a") || []]
      .map((link) => normalize(link.textContent)).join(" ");
    return {
      textLength: text.length,
      paragraphCount,
      headingCount,
      listCount,
      controlCount,
      linkDensity: text.length ? linkText.length / text.length : 1,
    };
  }

  function suitable(element, { minimumLength = 80, minimumParagraphs = 1 } = {}) {
    const value = metrics(element);
    return Boolean(value && value.textLength >= minimumLength &&
      value.paragraphCount >= minimumParagraphs && value.linkDensity <= 0.45 &&
      value.controlCount <= Math.max(3, value.paragraphCount * 2));
  }

  function titleFor(documentObject, element, siteId) {
    const titleElement = siteId === "leetcode"
      ? documentObject.querySelector(".article-inner .content-title") || documentObject.querySelector(".content-title")
      : element?.querySelector?.("h1,h2,h3");
    return {
      title: normalize(titleElement?.textContent) || normalize(documentObject.title) || "Readable page",
      titleElement: titleElement || element?.querySelector?.("h1,h2,h3") || null,
    };
  }

  function isTopFrame(viewObject = globalThis) {
    try { return viewObject.top === viewObject.self; } catch { return false; }
  }

  function result(documentObject, element, strategy, confidence, siteId = null, viewObject = globalThis) {
    const title = titleFor(documentObject, element, siteId);
    return { element, strategy, confidence, siteId, isTopFrame: isTopFrame(viewObject), ...title };
  }

  function leetCodeRegion(documentObject, locationObject, viewObject = globalThis) {
    if (!isLeetCodeHostname(locationObject?.hostname)) return null;
    for (const selector of [".article-inner .block-markdown", ".article-inner", ".block-markdown"]) {
      const candidate = documentObject.querySelector(selector);
      if (suitable(candidate, { minimumLength: 80, minimumParagraphs: 2 })) {
        return result(documentObject, candidate, "site-adapter", 0.95, "leetcode", viewObject);
      }
    }
    return null;
  }

  function fallbackRegion(documentObject) {
    const candidates = [...documentObject.querySelectorAll("section,div")]
      .filter((candidate) => suitable(candidate, { minimumLength: 120, minimumParagraphs: 2 }))
      .map((element) => ({ element, value: metrics(element) }))
      .filter(({ value }) => value.linkDensity <= 0.3)
      .sort((a, b) => {
        const score = (item) => item.value.paragraphCount * 300 + item.value.headingCount * 80 +
          item.value.listCount * 40 + Math.min(item.value.textLength, 4_000) - item.value.controlCount * 150;
        const difference = score(b) - score(a);
        if (Math.abs(difference) > 200) return difference;
        return a.element.querySelectorAll("*").length - b.element.querySelectorAll("*").length;
      });
    return candidates[0]?.element || (suitable(documentObject.body, {
      minimumLength: 120, minimumParagraphs: 2,
    }) ? documentObject.body : null);
  }

  function resolvePrimaryContentRegion(documentObject = document, locationObject = location, viewObject = globalThis) {
    const articles = [...documentObject.querySelectorAll("article")]
      .filter((element) => suitable(element))
      .sort((a, b) => metrics(b).textLength - metrics(a).textLength);
    if (articles[0]) return result(documentObject, articles[0], "semantic-article", 1, null, viewObject);
    const mains = [...documentObject.querySelectorAll("main")]
      .filter((element) => suitable(element))
      .sort((a, b) => metrics(b).textLength - metrics(a).textLength);
    if (mains[0]) return result(documentObject, mains[0], "semantic-main", 0.98, null, viewObject);
    const adapted = leetCodeRegion(documentObject, locationObject, viewObject);
    if (adapted) return adapted;
    const fallback = fallbackRegion(documentObject);
    return fallback ? result(documentObject, fallback, "prose-fallback", 0.65, null, viewObject) : null;
  }

  globalThis.__mochiAudioContentRegion = Object.freeze({
    isLeetCodeHostname, isTopFrame, leetCodeRegion, metrics, resolvePrimaryContentRegion, suitable,
  });
})();
