(() => {
  if (globalThis.__mochiAudioPassageHoverControls) return;

  const TYPES = {
    enable: "PASSAGE_HOVER_CONTROLS_ENABLE",
    disable: "PASSAGE_HOVER_CONTROLS_DISABLE",
    statusRequest: "PASSAGE_HOVER_CONTROLS_STATUS_REQUEST",
    statusChanged: "PASSAGE_HOVER_CONTROLS_STATUS_CHANGED",
    passageRead: "PASSAGE_HOVER_READ",
    pageRead: "PAGE_HOVER_READ",
    regionChanged: "PRIMARY_CONTENT_REGION_CHANGED",
    playerRequest: "TAB_PLAYBACK_STATE_REQUEST",
    playerChanged: "TAB_PLAYBACK_STATE_CHANGED",
    generationCancel: "GENERATION_CANCEL",
    generationPrepare: "GENERATION_PREPARE_REQUEST",
    generationAwait: "GENERATION_AWAIT_CONFIRMATION",
  };
  const HIGHLIGHT_CLASS = "mochi-audio-hover-target-active";
  const HIDE_DELAY_MS = 220;
  const state = {
    enabled: false,
    minimumLength: 40,
    codeMode: "skip",
    overlay: null,
    passageButton: null,
    pageButton: null,
    activeTarget: null,
    region: null,
    regionId: null,
    observer: null,
    scanTimer: 0,
    positionFrame: 0,
    hideTimer: 0,
    navigationTimer: 0,
    lastUrl: "",
    playerHost: null,
    playerState: null,
    hiddenRequestId: null,
    activeRequestId: null,
    activePassageElement: null,
    optimisticRequestId: null,
    pageRequestId: null,
  };

  const send = (message) => chrome.runtime.sendMessage(message);
  const targets = () => globalThis.__mochiAudioInPageTargets;
  const extractor = () => globalThis.__mochiAudioArticleExtractor;
  const formatTime = (seconds) => globalThis.__mochiAudioInPagePlayerState.formatTime(seconds);

  function makeButton(label, className, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.action = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.hidden = true;
    return button;
  }

  function createOverlay() {
    document.querySelectorAll('#mochi-audio-in-page-overlay,[data-mochi-audio-ui="in-page-overlay"]')
      .forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.id = "mochi-audio-in-page-overlay";
    overlay.dataset.mochiAudioUi = "in-page-overlay";
    overlay.dataset.pageUrl = location.href;
    overlay.addEventListener("click", onOverlayClick);
    overlay.addEventListener("pointerenter", clearHideTimer, true);
    overlay.addEventListener("pointerleave", onPointerOut, true);
    overlay.addEventListener("focusin", clearHideTimer);
    overlay.addEventListener("focusout", scheduleHide);
    state.passageButton = makeButton("Read this passage", "mochi-audio-passage-button", "passage");
    state.passageButton.textContent = "▶";
    state.passageButton.dataset.state = "idle";
    state.pageButton = makeButton("Read this page", "mochi-audio-page-button", "page");
    const logo = document.createElement("img");
    logo.src = chrome.runtime.getURL("assets/mochi.png");
    logo.alt = "";
    state.pageButton.append(logo, document.createTextNode("Read this page"));
    overlay.append(state.passageButton, state.pageButton);
    document.documentElement.append(overlay);
    state.overlay = overlay;
  }

  function clearHideTimer() {
    clearTimeout(state.hideTimer);
    state.hideTimer = 0;
  }

  function removeHighlight() {
    state.activeTarget?.classList.remove(HIGHLIGHT_CLASS);
  }

  function hideHoverUi() {
    clearHideTimer();
    removeHighlight();
    state.activeTarget = null;
    if (state.passageButton) state.passageButton.hidden = true;
    if (state.pageButton) state.pageButton.hidden = true;
  }

  function scheduleHide() {
    clearHideTimer();
    state.hideTimer = setTimeout(hideHoverUi, HIDE_DELAY_MS);
  }

  function setPassageState(next, title) {
    const button = state.passageButton;
    if (!button) return;
    button.dataset.state = next;
    const busy = next === "loading";
    button.disabled = busy || next === "disabled";
    button.setAttribute("aria-disabled", String(button.disabled));
    button.setAttribute("aria-busy", String(busy));
    button.setAttribute("aria-label", busy ? "Generating passage audio" : "Read this passage");
    button.textContent = busy ? "◌" : next === "active" ? "❚❚" : next === "error" ? "!" : "▶";
    button.title = title || "Read this passage";
  }

  function setPageState(next) {
    const button = state.pageButton;
    if (!button) return;
    const busy = next === "loading";
    button.dataset.state = next;
    button.disabled = busy || next === "disabled";
    button.setAttribute("aria-disabled", String(button.disabled));
    button.setAttribute("aria-busy", String(busy));
    button.querySelector("span")?.remove();
    if (busy) {
      const spinner = document.createElement("span");
      spinner.className = "mochi-audio-spinner";
      spinner.setAttribute("aria-hidden", "true");
      button.prepend(spinner);
    }
    button.lastChild.textContent = busy ? "Preparing page…" : "Read this page";
  }

  function showPassage(target) {
    clearHideTimer();
    state.pageButton.hidden = true;
    if (target !== state.activeTarget) {
      removeHighlight();
      state.activeTarget = target;
      target.classList.add(HIGHLIGHT_CLASS);
      const generation = state.playerState?.generation;
      const blocked = generation && generation.status !== "idle";
      setPassageState(blocked
        ? generation.ownsGeneration && state.activePassageElement === target ? "loading" : "disabled"
        : state.activePassageElement === target ? "active" : "idle");
    }
    state.passageButton.hidden = false;
    schedulePosition();
  }

  function showPageAction() {
    clearHideTimer();
    removeHighlight();
    state.activeTarget = null;
    state.passageButton.hidden = true;
    state.pageButton.hidden = false;
    setPageState(state.playerState?.generation?.status !== "idle" ? "disabled" : "idle");
    schedulePosition();
  }

  function onPointerOver(event) {
    if (state.overlay?.contains(event.target)) {
      clearHideTimer();
      return;
    }
    const passage = targets().findPassageTarget(
      event.target, state.minimumLength, state.codeMode, state.region?.element,
    );
    if (passage) {
      showPassage(passage);
      return;
    }
    if (targets().isPageTrigger(event.target, state.region, event.clientY)) {
      showPageAction();
      return;
    }
    scheduleHide();
  }

  function onPointerOut(event) {
    if (state.activeTarget?.contains(event.relatedTarget) || state.overlay?.contains(event.relatedTarget)) return;
    scheduleHide();
  }

  function positionButton(button, element, offset = 6) {
    if (!button || button.hidden) return;
    const position = targets().overlayPosition(
      element?.getBoundingClientRect?.(), button.offsetWidth || 32, button.offsetHeight || 32,
      innerWidth, innerHeight, offset,
    );
    if (!position) {
      button.hidden = true;
      return;
    }
    button.style.left = `${position.left}px`;
    button.style.top = `${position.top}px`;
  }

  function positionAll() {
    state.positionFrame = 0;
    if (state.activeTarget && !state.activeTarget.isConnected) hideHoverUi();
    positionButton(state.passageButton, state.activeTarget);
    positionButton(state.pageButton, state.region?.element, 10);
  }

  function schedulePosition() {
    if (!state.positionFrame) state.positionFrame = requestAnimationFrame(positionAll);
  }

  function regionMetadata() {
    return state.region ? {
      strategy: state.region.strategy,
      confidence: state.region.confidence,
      siteId: state.region.siteId,
      title: state.region.title,
    } : null;
  }

  function reconcileRegion(force = false) {
    const next = globalThis.__mochiAudioContentRegion.resolvePrimaryContentRegion(document, location);
    if (!force && next?.element === state.region?.element) {
      schedulePosition();
      return;
    }
    hideHoverUi();
    state.region = next;
    state.regionId = next ? crypto.randomUUID() : null;
    send({
      type: TYPES.regionChanged,
      payload: { pageUrl: location.href, regionId: state.regionId, region: regionMetadata() },
    }).catch(() => {});
    schedulePosition();
  }

  function scheduleReconcile() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => reconcileRegion(), 100);
  }

  async function readPassage() {
    const element = state.activeTarget;
    if (!element?.isConnected || state.passageButton.dataset.state === "loading") return;
    const text = extractor().extractFromRoot(element, { codeMode: state.codeMode });
    if (!text) return setPassageState("error", "No readable prose found");
    setPassageState("loading", "Generating passage audio");
    const requestId = crypto.randomUUID();
    state.optimisticRequestId = requestId;
    state.activePassageElement = element;
    const response = await send({
      type: TYPES.passageRead,
      payload: {
        text, requestId, source: "hover-passage", elementType: element.tagName.toLowerCase(),
        pageUrl: location.href, regionId: state.regionId,
      },
    }).catch((error) => ({ ok: false, error: error.message }));
    if (state.optimisticRequestId !== requestId) return;
    state.optimisticRequestId = null;
    state.activeRequestId = response?.ok ? requestId : null;
    state.activePassageElement = response?.ok ? element : null;
    const cancelled = response?.code === "GENERATION_CANCELLED";
    setPassageState(response?.ok ? "active" : cancelled ? "idle" : "error",
      response?.ok ? "Current passage" : cancelled ? "Generation cancelled" : response?.error || "Passage could not be read");
  }

  async function showPageConfirmation() {
    state.overlay.querySelector(".mochi-audio-confirmation")?.remove();
    setPageState("loading");
    const requestId = crypto.randomUUID();
    state.pageRequestId = requestId;
    const prepared = await send({
      type: TYPES.generationPrepare,
      payload: { requestId, sourceType: "page", pageUrl: location.href },
    }).catch((error) => ({ ok: false, error: error.message }));
    if (!prepared?.ok) {
      setPageState("error");
      return;
    }
    const text = extractor().extractFromRoot(state.region?.element, { codeMode: state.codeMode });
    setPageState("disabled");
    if (!text) {
      await send({ type: TYPES.generationCancel, payload: { requestId } }).catch(() => {});
      return;
    }
    const dialog = document.createElement("section");
    dialog.className = "mochi-audio-confirmation";
    dialog.dataset.mochiAudioUi = "confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "mochi-audio-confirm-heading");
    dialog.innerHTML = `<h2 id="mochi-audio-confirm-heading">Read this page</h2>
      <label>Extracted text preview<textarea data-preview></textarea></label>
      <p data-estimate role="status">Calculating estimate…</p>
      <button type="button" data-action="confirm-page">Confirm</button>
      <button type="button" data-action="cancel-page">Cancel</button>`;
    dialog.querySelector("textarea").value = text;
    state.overlay.append(dialog);
    dialog.querySelector('[data-action="cancel-page"]').focus();
    const response = await send({ type: "ARTICLE_PREVIEW_ESTIMATE_REQUEST", payload: { text } })
      .catch((error) => ({ ok: false, error: error.message }));
    await send({
      type: TYPES.generationAwait,
      payload: { requestId, sourceType: "page", pageUrl: location.href },
    }).catch(() => {});
    if (!dialog.isConnected) return;
    dialog.querySelector("[data-estimate]").textContent = response?.ok
      ? `${response.estimate.inputBytes.toLocaleString()} UTF-8 bytes · ${response.estimate.chunks} chunk(s) · $${(response.estimate.estimatedCostMicrousd / 1_000_000).toFixed(6)} · about ${formatTime(response.estimate.durationSeconds)}${response.estimate.reason ? ` · ${response.estimate.reason}` : response.estimate.warning ? " · Budget warning" : ""}`
      : response?.error || "Estimate unavailable.";
  }

  async function confirmPage(button) {
    const dialog = button.closest(".mochi-audio-confirmation");
    const text = dialog?.querySelector("textarea")?.value.trim();
    if (!text) return;
    button.disabled = true;
    button.textContent = "Generating first chunk…";
    const response = await send({
      type: TYPES.pageRead,
      payload: {
        text, requestId: state.pageRequestId, source: "page",
        elementType: state.region?.element?.tagName?.toLowerCase() || "div",
        pageUrl: location.href, regionId: state.regionId,
      },
    }).catch((error) => ({ ok: false, error: error.message }));
    if (response?.ok) { dialog.remove(); state.pageRequestId = null; }
    else {
      button.disabled = false;
      button.textContent = "Confirm";
      dialog.querySelector("[data-estimate]").textContent = response?.error || "Page could not be read.";
    }
  }

  function onOverlayClick(event) {
    const button = event.target.closest?.("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "passage") readPassage();
    if (button.dataset.action === "page") showPageConfirmation();
    if (button.dataset.action === "confirm-page") confirmPage(button);
    if (button.dataset.action === "cancel-page") {
      button.closest(".mochi-audio-confirmation")?.remove();
      if (state.pageRequestId) send({ type: TYPES.generationCancel, payload: { requestId: state.pageRequestId } }).catch(() => {});
      state.pageRequestId = null;
    }
    if (button.dataset.action === "cancel-generation") send({
      type: TYPES.generationCancel,
      payload: { requestId: state.playerState?.generation?.requestId },
    }).catch(() => {});
  }

  function createPlayer() {
    if (state.playerHost?.isConnected) return state.playerHost;
    const host = document.createElement("div");
    host.dataset.mochiAudioUi = "in-page-player";
    host.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147482000;pointer-events:auto";
    const shadow = host.attachShadow({ mode: "open" });
    const logoUrl = chrome.runtime.getURL("assets/mochi.png");
    shadow.innerHTML = `<style>
      :host{all:initial}.bar{box-sizing:border-box;display:flex;align-items:center;gap:7px;width:min(760px,calc(100vw - 24px));padding:9px 12px;border:1px solid #9a7c3e;border-radius:16px;background:#fff8e7;color:#444a50;box-shadow:0 8px 30px #444a5033;font:13px/1.2 ui-rounded,system-ui,sans-serif}.logo{width:32px;height:32px}button,select,input{font:inherit}button{min-width:34px;min-height:34px;border:1px solid #9a7c3e;border-radius:8px;background:#fffdf7;color:#3f6f34;cursor:pointer}button:disabled,input:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #9b3154;outline-offset:2px}.progress{flex:1;min-width:90px;accent-color:#3f6f34}.time,.queue{white-space:nowrap}.generation{display:flex;align-items:center;gap:6px}.spinner{display:inline-block;animation:spin .8s linear infinite}.status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:620px){.optional{display:none}.bar{flex-wrap:wrap}.progress{min-width:45vw}}@media(prefers-reduced-motion:reduce){*{transition:none!important}.spinner{animation:none}}</style>
      <div class="bar" role="region" aria-label="Mochi Audio playback controls"><img class="logo optional" src="${logoUrl}" alt=""><span class="generation" data-generation hidden><span class="spinner" aria-hidden="true">◌</span><span data-generation-text>Generating audio…</span><button data-action="cancel-generation">Cancel</button></span><button data-command="QUEUE_PREVIOUS" aria-label="Previous chunk">⏮</button><button data-command="PLAYBACK_PLAY" aria-label="Play">▶</button><button data-command="PLAYBACK_PAUSE" aria-label="Pause">❚❚</button><button data-command="PLAYBACK_RESUME" aria-label="Resume">↻</button><button data-command="PLAYBACK_STOP" aria-label="Stop">■</button><button data-command="QUEUE_NEXT" aria-label="Next chunk">⏭</button><input class="progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Current chunk playback position"><span class="time"><span data-elapsed>0:00</span> / <span data-duration>0:00</span></span><span class="queue optional" data-queue>Chunk 1 of 1</span><label class="optional">Speed <select aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button data-close aria-label="Close playback bar">×</button><span class="status" aria-live="polite" data-status></span></div>`;
    shadow.addEventListener("click", onPlayerClick);
    shadow.querySelector("select").addEventListener("change", (event) => send({
      type: "PLAYBACK_RATE_SET", payload: { rate: Number(event.target.value) },
    }));
    shadow.querySelector("input").addEventListener("change", (event) => send({
      type: "PLAYBACK_SEEK",
      payload: { deltaSeconds: Number(event.target.value) - (state.playerState?.playback?.currentTime || 0) },
    }));
    state.overlay.append(host);
    state.playerHost = host;
    return host;
  }

  function onPlayerClick(event) {
    if (event.target.closest?.('[data-action="cancel-generation"]')) {
      send({ type: TYPES.generationCancel, payload: { requestId: state.playerState?.generation?.requestId } }).catch(() => {});
      return;
    }
    if (event.target.closest?.("[data-close]")) {
      state.hiddenRequestId = state.playerState?.playback?.requestId || null;
      state.playerHost?.remove();
      state.playerHost = null;
      return;
    }
    const command = event.target.closest?.("[data-command]")?.dataset.command;
    if (command) send({ type: command }).catch(() => {});
  }

  function renderPlayer(shared) {
    state.playerState = shared;
    const view = globalThis.__mochiAudioInPagePlayerState.map(shared);
    const { playback } = view;
    const generating = shared?.generation?.ownsGeneration && ["validating", "generating", "buffering"].includes(shared.generation.status);
    const generationBlocked = generating || shared?.generation?.status === "awaiting-confirmation" ||
      shared?.generation?.otherTabGenerating;
    setPageState(generationBlocked ? "disabled" : "idle");
    if (generating) setPassageState("loading", "Generating passage audio");
    else if (generationBlocked) setPassageState("disabled");
    if ((!shared?.session?.ownsPlayback || !view.visible) && !generating) {
      state.playerHost?.remove();
      state.playerHost = null;
      state.activeRequestId = null;
      state.activePassageElement = null;
      if (!generationBlocked) setPassageState("idle");
      return;
    }
    if (state.hiddenRequestId && state.hiddenRequestId === playback.requestId) return;
    if (state.hiddenRequestId !== playback.requestId) state.hiddenRequestId = null;
    const shadow = createPlayer().shadowRoot;
    const generationView = shadow.querySelector("[data-generation]");
    generationView.hidden = !generating;
    shadow.querySelector("[data-generation-text]").textContent = shared.generation?.status === "buffering" ? "Buffering…" : "Generating audio…";
    shadow.querySelectorAll("[data-command='QUEUE_PREVIOUS'],[data-command='QUEUE_NEXT'],[data-command='PLAYBACK_PLAY'],[data-command='PLAYBACK_RESUME']")
      .forEach((button) => { button.disabled = generating; });
    const progress = shadow.querySelector("input");
    progress.max = String(view.duration);
    progress.value = String(view.currentTime);
    progress.disabled = !view.determinate;
    shadow.querySelector("[data-elapsed]").textContent = view.elapsedLabel;
    shadow.querySelector("[data-duration]").textContent = view.durationLabel;
    shadow.querySelector("select").value = String(playback.playbackRate || 1);
    shadow.querySelector("[data-queue]").textContent = shared.queue?.currentIndex < 0 ? "Preparing first chunk" : view.queueLabel;
    shadow.querySelector("[data-status]").textContent = generating ? "Generating audio." : `${playback.status}. Current-chunk progress.`;
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.target !== "content") return false;
    if (message.type === TYPES.enable) {
      enable(message.payload || {});
      sendResponse({ ok: true, enabled: true });
      return false;
    }
    if (message.type === TYPES.disable) {
      disable();
      sendResponse({ ok: true, enabled: false });
      return false;
    }
    if (message.type === TYPES.statusRequest) {
      sendResponse({ ok: true, enabled: state.enabled, region: regionMetadata() });
      return false;
    }
    if (message.type === TYPES.playerChanged) {
      renderPlayer(message.payload);
      return false;
    }
    return false;
  }

  function onNavigation() {
    if (!state.enabled || state.lastUrl === location.href) return;
    const previous = new URL(state.lastUrl);
    const next = new URL(location.href);
    state.lastUrl = location.href;
    if (state.overlay) state.overlay.dataset.pageUrl = location.href;
    previous.hash = "";
    next.hash = "";
    if (previous.href === next.href) {
      schedulePosition();
      return;
    }
    reconcileRegion(true);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") disable();
  }

  function enable(options = {}) {
    if (state.enabled) disable(false);
    state.enabled = true;
    state.minimumLength = Number.isFinite(options.minimumLength) ? Math.max(20, options.minimumLength) : 40;
    state.codeMode = options.skipCode === false ? "literal" : "skip";
    createOverlay();
    reconcileRegion(true);
    state.observer = new MutationObserver(scheduleReconcile);
    state.observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "open", "style", "class"],
    });
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
    document.addEventListener("load", schedulePosition, { capture: true });
    addEventListener("resize", schedulePosition, { passive: true });
    document.fonts?.addEventListener?.("loadingdone", schedulePosition);
    state.lastUrl = location.href;
    state.navigationTimer = setInterval(onNavigation, 500);
    send({ type: TYPES.statusChanged, payload: { enabled: true, pageUrl: location.href } }).catch(() => {});
    send({ type: TYPES.playerRequest }).then((response) => response?.ok && renderPlayer(response.state)).catch(() => {});
  }

  function disable(notify = true) {
    state.enabled = false;
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.scanTimer);
    clearTimeout(state.hideTimer);
    clearInterval(state.navigationTimer);
    if (state.positionFrame) cancelAnimationFrame(state.positionFrame);
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", schedulePosition, { capture: true });
    document.removeEventListener("load", schedulePosition, { capture: true });
    removeEventListener("resize", schedulePosition);
    document.fonts?.removeEventListener?.("loadingdone", schedulePosition);
    hideHoverUi();
    state.overlay?.remove();
    state.overlay = state.passageButton = state.pageButton = state.playerHost = null;
    state.region = state.regionId = state.playerState = state.activeRequestId = state.activePassageElement = null;
    if (notify) send({ type: TYPES.statusChanged, payload: { enabled: false, pageUrl: location.href } }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  globalThis.__mochiAudioPassageHoverControls = Object.freeze({
    disable, enable, get enabled() { return state.enabled; },
  });
})();
