(() => {
  if (globalThis.__fishStudyReaderHoverReader) {
    return;
  }

  const api = globalThis.__fishStudyReaderHoverTarget;
  const UI_ATTRIBUTE = "data-fish-study-reader-ui";
  const HIGHLIGHT_CLASS = "__fish-study-reader-hover-target";
  const HIDE_DELAY_MS = 140;
  const state = {
    enabled: false,
    minimumLength: 40,
    currentTarget: null,
    button: null,
    style: null,
    hideTimer: null,
    articleArmed: false,
  };

  function clearHideTimer() {
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
  }

  function removeHighlight() {
    state.currentTarget?.classList.remove(HIGHLIGHT_CLASS);
    state.currentTarget = null;
    state.articleArmed = false;
  }

  function hideUi() {
    clearHideTimer();
    removeHighlight();
    if (state.button) {
      state.button.hidden = true;
    }
  }

  function scheduleHide() {
    clearHideTimer();
    state.hideTimer = setTimeout(hideUi, HIDE_DELAY_MS);
  }

  function positionButton() {
    if (!state.currentTarget?.isConnected || !state.button || state.button.hidden) {
      return;
    }
    const rectangle = state.currentTarget.getBoundingClientRect();
    const gap = 8;
    const width = state.button.offsetWidth;
    const height = state.button.offsetHeight;
    const left = Math.min(
      Math.max(gap, rectangle.left),
      Math.max(gap, window.innerWidth - width - gap),
    );
    const below = rectangle.bottom + gap;
    const top = below + height <= window.innerHeight
      ? below
      : Math.max(gap, rectangle.top - height - gap);
    state.button.style.left = `${Math.round(left)}px`;
    state.button.style.top = `${Math.round(top)}px`;
  }

  function showTarget(target) {
    clearHideTimer();
    if (target !== state.currentTarget) {
      removeHighlight();
      state.currentTarget = target;
      target.classList.add(HIGHLIGHT_CLASS);
    }
    state.button.hidden = false;
    state.button.textContent = target.matches("article") ? "Preview article" : "Read passage";
    state.button.disabled = false;
    positionButton();
  }

  function handlePointerOver(event) {
    if (state.button?.contains(event.target)) {
      clearHideTimer();
      return;
    }
    const target = api.findHoverTarget(event.target, state.minimumLength);
    if (target) {
      showTarget(target);
    } else {
      scheduleHide();
    }
  }

  function handlePointerOut(event) {
    if (
      state.currentTarget?.contains(event.relatedTarget) ||
      state.button?.contains(event.relatedTarget)
    ) {
      return;
    }
    scheduleHide();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      disable();
    }
  }

  async function readCurrentPassage(event) {
    event.preventDefault();
    event.stopPropagation();
    clearHideTimer();
    const isArticle = state.currentTarget?.matches("article");
    if (isArticle && !state.articleArmed) {
      state.articleArmed = true;
      state.button.textContent = "Confirm article";
      return;
    }
    const text = api.getVisibleText(state.currentTarget);
    if (!text) {
      hideUi();
      return;
    }
    state.button.disabled = true;
    state.button.textContent = "Reading…";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "HOVER_PASSAGE_READ",
        payload: {
          text,
          requestId: crypto.randomUUID(),
          source: isArticle ? "article" : "hover",
        },
      });
      state.button.textContent = response?.ok ? "Playing" : "Try again";
    } catch {
      state.button.textContent = "Try again";
    } finally {
      state.button.disabled = false;
    }
  }

  function createUi() {
    if (state.button) {
      return;
    }
    state.style = document.createElement("style");
    state.style.setAttribute(UI_ATTRIBUTE, "style");
    state.style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 2px solid rgba(22, 120, 108, 0.55) !important;
        outline-offset: 3px !important;
      }
      [${UI_ATTRIBUTE}="button"] {
        all: initial !important;
        position: fixed !important;
        z-index: 2147483647 !important;
        border: 0 !important;
        border-radius: 999px !important;
        padding: 8px 12px !important;
        background: #173b37 !important;
        color: white !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22) !important;
        cursor: pointer !important;
        font: 600 13px/1.2 system-ui, sans-serif !important;
      }
      [${UI_ATTRIBUTE}="button"]:disabled { opacity: 0.7 !important; }
      [${UI_ATTRIBUTE}="button"][hidden] { display: none !important; }
    `;
    document.documentElement.append(state.style);

    state.button = document.createElement("button");
    state.button.type = "button";
    state.button.hidden = true;
    state.button.setAttribute(UI_ATTRIBUTE, "button");
    state.button.textContent = "Read passage";
    state.button.addEventListener("pointerenter", clearHideTimer);
    state.button.addEventListener("pointerleave", handlePointerOut);
    state.button.addEventListener("click", readCurrentPassage);
    document.documentElement.append(state.button);
  }

  function enable(minimumLength = 40) {
    if (state.enabled) {
      return;
    }
    state.enabled = true;
    state.minimumLength = Number.isInteger(minimumLength) && minimumLength > 0
      ? minimumLength
      : 40;
    createUi();
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", positionButton, true);
    window.addEventListener("resize", positionButton);
  }

  function disable() {
    if (!state.enabled) {
      return;
    }
    state.enabled = false;
    document.removeEventListener("pointerover", handlePointerOver, true);
    document.removeEventListener("pointerout", handlePointerOut, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("scroll", positionButton, true);
    window.removeEventListener("resize", positionButton);
    hideUi();
    state.button?.remove();
    state.style?.remove();
    state.button = null;
    state.style = null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "content") {
      return false;
    }
    if (message.type === "HOVER_MODE_ENABLE") {
      enable(message.payload?.minimumLength);
      sendResponse({ ok: true, enabled: true });
      return false;
    }
    if (message.type === "HOVER_MODE_DISABLE") {
      disable();
      sendResponse({ ok: true, enabled: false });
      return false;
    }
    if (message.type === "HOVER_MODE_STATUS_REQUEST") {
      sendResponse({ ok: true, enabled: state.enabled });
      return false;
    }
    return false;
  });

  globalThis.__fishStudyReaderHoverReader = Object.freeze({ disable, enable });
})();
