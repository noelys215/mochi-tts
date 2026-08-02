(() => {
  if (globalThis.__mochiAudioPassageHoverControls) return;
  document.documentElement.dataset.mochiAudioController = "ready";

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
    hiddenGenerationRequestId: null,
    activeRequestId: null,
    activePassageElement: null,
    optimisticRequestId: null,
    pageRequestId: null,
    announcedPlayerStatus: null,
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
      isTopFrame: state.region.isTopFrame,
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
      :host{all:initial}.player{box-sizing:border-box;display:grid;gap:7px;width:min(620px,calc(100vw - 24px));max-width:100%;padding:8px 12px;border:1px solid #9a7c3e;border-radius:14px;background:#fff8e7;color:#444a50;box-shadow:0 7px 24px #444a5030;font:13px/1.2 ui-rounded,system-ui,sans-serif}.row{min-width:0}.playback-row{display:grid;grid-template-columns:34px 38px minmax(44px,auto) 38px 58px 36px;align-items:center;justify-content:center;gap:7px}.message-row{display:grid;grid-template-columns:34px 18px minmax(0,1fr) auto 36px;align-items:center;gap:8px}.logo{width:32px;height:32px}.message{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}.progress-row{display:grid;grid-template-columns:3.5rem minmax(0,1fr) 3.5rem;align-items:center;gap:8px}.time{min-width:3.5rem;white-space:nowrap;font-variant-numeric:tabular-nums}.remaining{text-align:right}.progress{width:100%;min-width:0;accent-color:#3f6f34}.speed{width:58px;height:36px;padding:0 4px;border:1px solid #b9a678;border-radius:9px;background:#fffdf7;color:#3f6f34}button,select,input{box-sizing:border-box;font:inherit}button{width:38px;height:36px;border:1px solid #b9a678;border-radius:9px;background:#fffdf7;color:#3f6f34;cursor:pointer;padding:0}button.primary{width:auto;min-width:48px;padding:0 8px;border-color:#3f6f34;background:#3f6f34;color:white;font-weight:700}button.cancel,button.retry{width:auto;min-width:58px;padding:0 9px;border-color:#9b3154;background:#9b3154;color:white;font-weight:700}button.close{border-color:transparent;background:transparent;color:#686f75}button:disabled{cursor:not-allowed;opacity:.4}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #9b3154;outline-offset:2px}.spinner{display:inline-grid;width:18px;height:18px;place-items:center;animation:spin .8s linear infinite}.loading-track,.error-track{height:4px;overflow:hidden;border-radius:999px;background:#ddcfaa}.loading-segment{width:38%;height:100%;border-radius:inherit;background:#3f6f34;animation:travel 1.15s ease-in-out infinite}.error-track{background:linear-gradient(90deg,#9b3154 0 42%,#f2ccd8 42%)}.secondary{min-width:0;text-align:center;color:#686f75;font-size:11px}.live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@keyframes spin{to{transform:rotate(360deg)}}@keyframes travel{0%{transform:translateX(-110%)}100%{transform:translateX(265%)}}@media(max-width:420px){.player{width:calc(100vw - 16px);padding:8px;gap:6px}.playback-row{grid-template-columns:32px 36px 42px 36px 52px 34px;gap:4px}.logo{width:30px;height:30px}button{width:36px;height:34px}button.primary{min-width:42px;padding:0}.primary-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.speed{width:52px;height:34px}.message-row{grid-template-columns:30px 18px minmax(0,1fr) auto 34px;gap:5px}.progress-row{grid-template-columns:3.2rem minmax(0,1fr) 3.2rem;gap:5px}.time{min-width:3.2rem}}@media(prefers-reduced-motion:reduce){*{transition:none!important}.spinner,.loading-segment{animation:none}.loading-segment{transform:translateX(70%);background:repeating-linear-gradient(135deg,#3f6f34 0 5px,#86a77e 5px 10px)}}</style>
      <div class="player" role="region" aria-label="Mochi Audio player" aria-busy="false" data-mode="ready">
        <div class="row playback-row" data-playback-row hidden>
          <img class="logo" src="${logoUrl}" alt="">
          <button data-seek="-5" aria-label="Rewind 5 seconds">↺ 5</button>
          <button class="primary" data-primary data-command="PLAYBACK_PLAY" aria-label="Play audio"><span aria-hidden="true">▶</span><span class="primary-label">Play</span></button>
          <button data-seek="5" aria-label="Forward 5 seconds">5 ↻</button>
          <select class="speed" aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select>
          <button class="close" data-close aria-label="Close player">×</button>
        </div>
        <div class="row message-row" data-message-row hidden>
          <img class="logo" src="${logoUrl}" alt=""><span class="spinner" data-spinner aria-hidden="true">◌</span><span class="message" data-player-status></span><button class="retry" data-action="retry-generation" hidden>Retry</button><button class="cancel" data-action="cancel-generation" hidden>Cancel</button><button class="close" data-close aria-label="Close player">×</button>
        </div>
        <div class="row progress-row" data-progress-row hidden><span class="time" data-elapsed></span><input class="progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Audio progress"><span class="time remaining" data-remaining></span></div>
        <div class="loading-track" data-loading role="progressbar" aria-label="Preparing audio" hidden><div class="loading-segment"></div></div>
        <div class="error-track" data-error-bar hidden></div><div class="secondary" data-secondary hidden>Loading next part…</div>
        <span class="live" aria-live="polite" aria-atomic="true" data-live></span>
      </div>`;
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
    if (event.target.closest?.('[data-action="retry-generation"]')) {
      if (state.activeTarget?.isConnected) readPassage();
      else {
        state.playerHost?.remove();
        state.playerHost = null;
      }
      return;
    }
    if (event.target.closest?.('[data-action="cancel-generation"]')) {
      send({ type: TYPES.generationCancel, payload: { requestId: state.playerState?.generation?.requestId } }).catch(() => {});
      return;
    }
    if (event.target.closest?.("[data-close]")) {
      state.hiddenRequestId = state.playerState?.playback?.requestId ||
        state.playerState?.generation?.requestId || null;
      state.hiddenGenerationRequestId = state.playerState?.generation?.requestId || null;
      state.playerHost?.remove();
      state.playerHost = null;
      return;
    }
    const seek = Number(event.target.closest?.("[data-seek]")?.dataset.seek);
    if (Number.isFinite(seek)) {
      const playback = state.playerState?.playback || {};
      const targetTime = globalThis.__mochiAudioInPagePlayerState.seekTarget(
        playback.currentTime, playback.duration, seek,
      );
      send({ type: "PLAYBACK_SEEK", payload: { deltaSeconds: targetTime - (playback.currentTime || 0) } }).catch(() => {});
      return;
    }
    const command = event.target.closest?.("[data-command]")?.dataset.command;
    if (command) send({ type: command }).catch(() => {});
  }

  function renderPlayer(shared) {
    state.playerState = shared;
    const view = globalThis.__mochiAudioInPagePlayerState.map(shared);
    const { playback } = view;
    const generating = view.mode === "generating";
    const generationBlocked = generating || shared?.generation?.status === "awaiting-confirmation" ||
      shared?.generation?.otherTabGenerating;
    setPageState(generationBlocked ? "disabled" : "idle");
    if (generating) setPassageState("loading", "Generating passage audio");
    else if (generationBlocked) setPassageState("disabled");
    const standaloneStatus = shared?.generation?.ownsGeneration &&
      ["generating", "failed", "cancelled"].includes(view.mode);
    if (!view.visible || (!shared?.session?.ownsPlayback && !standaloneStatus)) {
      state.playerHost?.remove();
      state.playerHost = null;
      state.announcedPlayerStatus = null;
      state.activeRequestId = null;
      state.activePassageElement = null;
      if (!generationBlocked) setPassageState("idle");
      return;
    }
    if (state.hiddenRequestId && state.hiddenRequestId === playback.requestId) return;
    if (state.hiddenRequestId !== playback.requestId) state.hiddenRequestId = null;
    if (state.hiddenGenerationRequestId &&
        state.hiddenGenerationRequestId === shared?.generation?.requestId) return;
    if (state.hiddenGenerationRequestId !== shared?.generation?.requestId) {
      state.hiddenGenerationRequestId = null;
    }
    const shadow = createPlayer().shadowRoot;
    const player = shadow.querySelector(".player");
    player.dataset.mode = view.mode;
    player.setAttribute("aria-busy", String(view.mode === "generating"));
    shadow.querySelector("[data-message-row]").hidden = view.showPlayback;
    shadow.querySelector("[data-playback-row]").hidden = !view.showPlayback;
    shadow.querySelector("[data-player-status]").textContent = view.statusText;
    if (state.announcedPlayerStatus !== view.statusText) {
      shadow.querySelector("[data-live]").textContent = `${view.statusText}.`;
      state.announcedPlayerStatus = view.statusText;
    }
    shadow.querySelector("[data-spinner]").style.visibility = view.showSpinner ? "visible" : "hidden";
    shadow.querySelector('[data-action="retry-generation"]').hidden = !view.showRetry;
    shadow.querySelector('[data-action="cancel-generation"]').hidden = !view.showCancel;
    const primary = shadow.querySelector("[data-primary]");
    primary.dataset.command = view.primary.command;
    primary.setAttribute("aria-label", view.primary.label);
    primary.querySelector('[aria-hidden="true"]').textContent = view.primary.icon;
    primary.querySelector(".primary-label").textContent = view.primary.text;
    shadow.querySelector('[data-seek="-5"]').disabled = view.rewindDisabled;
    shadow.querySelector('[data-seek="5"]').disabled = view.forwardDisabled;
    const progress = shadow.querySelector("input");
    progress.max = String(view.duration);
    progress.value = String(view.currentTime);
    shadow.querySelector("[data-progress-row]").hidden = !view.showProgress;
    shadow.querySelector("[data-elapsed]").textContent = view.elapsedLabel;
    shadow.querySelector("[data-remaining]").textContent = view.remainingLabel || "";
    shadow.querySelector("[data-loading]").hidden = !view.showIndeterminate;
    shadow.querySelector("[data-error-bar]").hidden = !view.showErrorBar;
    shadow.querySelector("[data-secondary]").hidden = !view.showSecondaryLoading;
    shadow.querySelector("select").value = String(playback.playbackRate || 1);
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.target !== "content") return false;
    if (message.type === TYPES.enable) {
      enable(message.payload || {});
      sendResponse({ ok: true, enabled: true, region: regionMetadata() });
      return false;
    }
    if (message.type === TYPES.disable) {
      disable(false);
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
    if (event.key === "Escape") {
      send({ type: TYPES.disable }).catch(() => disable());
    }
  }

  function onPageHide() {
    send({ type: "FRAME_LIFECYCLE_ENDED", payload: { pageUrl: location.href } }).catch(() => {});
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
    addEventListener("pagehide", onPageHide, { once: true });
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
    removeEventListener("pagehide", onPageHide);
    removeEventListener("resize", schedulePosition);
    document.fonts?.removeEventListener?.("loadingdone", schedulePosition);
    hideHoverUi();
    state.overlay?.remove();
    state.overlay = state.passageButton = state.pageButton = state.playerHost = null;
    state.region = state.regionId = state.playerState = state.activeRequestId = state.activePassageElement = null;
    state.hiddenRequestId = state.hiddenGenerationRequestId = state.announcedPlayerStatus = null;
    if (notify) send({ type: TYPES.statusChanged, payload: { enabled: false, pageUrl: location.href } }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  globalThis.__mochiAudioPassageHoverControls = Object.freeze({
    disable, enable,
    describe: () => ({ enabled: state.enabled, region: regionMetadata(), isTopFrame: window.top === window }),
    get enabled() { return state.enabled; },
  });
})();
