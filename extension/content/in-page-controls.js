(() => {
  const prior = globalThis.__mochiAudioInPageControls;
  if (prior) return;

  const TYPES = {
    enable: "IN_PAGE_CONTROLS_ENABLE",
    disable: "IN_PAGE_CONTROLS_DISABLE",
    statusRequest: "IN_PAGE_CONTROLS_STATUS_REQUEST",
    statusChanged: "IN_PAGE_CONTROLS_STATUS_CHANGED",
    passageRead: "IN_PAGE_PASSAGE_READ",
    articleRead: "IN_PAGE_ARTICLE_READ",
    playerRequest: "IN_PAGE_PLAYER_STATE_REQUEST",
    playerChanged: "IN_PAGE_PLAYER_STATE_CHANGED",
  };
  const state = {
    enabled: false,
    minimumLength: 40,
    codeMode: "skip",
    overlay: null,
    pageRoot: null,
    pageButton: null,
    playerHost: null,
    observer: null,
    buttons: new Map(),
    scanTimer: 0,
    positionFrame: 0,
    navigationTimer: 0,
    lastUrl: "",
    pendingRoots: new Set(),
    playerState: null,
    hiddenRequestId: null,
    activeButton: null,
  };

  const send = (message) => chrome.runtime.sendMessage(message);
  const targets = () => globalThis.__mochiAudioInPageTargets;
  const extractor = () => globalThis.__mochiAudioArticleExtractor;
  const formatTime = (seconds) => globalThis.__mochiAudioInPagePlayerState.formatTime(seconds);

  function makeButton(label, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.title = label;
    return button;
  }

  function createOverlay() {
    document.querySelectorAll('#mochi-audio-in-page-overlay,[data-mochi-audio-ui="in-page-overlay"]').forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.id = "mochi-audio-in-page-overlay";
    overlay.dataset.mochiAudioUi = "in-page-overlay";
    overlay.dataset.pageUrl = location.href;
    overlay.addEventListener("click", onOverlayClick);
    document.documentElement.append(overlay);
    state.overlay = overlay;
  }

  function addPassage(element) {
    if (state.buttons.has(element) || !element.isConnected) return;
    const button = makeButton("Read this passage", "mochi-audio-passage-button");
    button.textContent = "▶";
    button.dataset.action = "passage";
    button.dataset.state = "idle";
    state.overlay.append(button);
    state.buttons.set(element, button);
    element.dataset.mochiAudioInPageTarget = "true";
  }

  function removePassage(element) {
    state.buttons.get(element)?.remove();
    state.buttons.delete(element);
    delete element.dataset.mochiAudioInPageTarget;
  }

  function reconcile(root = document) {
    const selected = new Set(targets().selectPassageTargets(root, state.minimumLength, state.codeMode));
    for (const [element] of state.buttons) {
      const inScope = root === document || root === element || root.contains?.(element);
      if (!element.isConnected || (inScope && !selected.has(element))) removePassage(element);
    }
    selected.forEach(addPassage);
    reconcilePageButton();
    schedulePosition();
  }

  function reconcilePageButton() {
    const root = targets().findPageTarget(document, state.minimumLength, state.codeMode);
    if (root === state.pageRoot && state.pageButton?.isConnected) return;
    state.pageButton?.remove();
    state.pageButton = null;
    state.pageRoot = root;
    if (!root) return;
    const button = makeButton("Read this page", "mochi-audio-page-button");
    const logo = document.createElement("img");
    logo.src = chrome.runtime.getURL("assets/mochi.png");
    logo.alt = "";
    button.append(logo, document.createTextNode("Read this page"));
    button.dataset.action = "page";
    state.overlay.append(button);
    state.pageButton = button;
  }

  function positionButton(button, element, offset = 6) {
    const rect = element?.getBoundingClientRect?.();
    button.hidden = false;
    const position = targets().overlayPosition(
      rect,
      button.offsetWidth || 32,
      button.offsetHeight || 32,
      innerWidth,
      innerHeight,
      offset,
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
    if (state.pageButton) positionButton(state.pageButton, state.pageRoot, 10);
    for (const [element, button] of state.buttons) {
      positionButton(button, element);
      if (button.hidden || !state.pageButton || state.pageButton.hidden ||
          !state.pageRoot?.contains?.(element)) continue;
      const passageRect = button.getBoundingClientRect();
      const pageRect = state.pageButton.getBoundingClientRect();
      const overlaps = passageRect.left < pageRect.right && passageRect.right > pageRect.left &&
        passageRect.top < pageRect.bottom && passageRect.bottom > pageRect.top;
      if (overlaps) {
        button.style.top = `${Math.min(innerHeight - passageRect.height - 8, pageRect.bottom + 6)}px`;
      }
    }
  }

  function schedulePosition() {
    if (!state.positionFrame) state.positionFrame = requestAnimationFrame(positionAll);
  }

  function scheduleScan(root) {
    if (root?.closest?.("[data-mochi-audio-ui]")) return;
    const candidate = root?.nodeType === Node.ELEMENT_NODE
      ? root.closest?.("p,article,section,div,main") || root
      : root?.parentElement;
    if (candidate) state.pendingRoots.add(candidate);
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = 0;
      const roots = [...state.pendingRoots];
      state.pendingRoots.clear();
      roots.forEach((scanRoot) => scanRoot.isConnected && reconcile(scanRoot));
      for (const [element] of state.buttons) if (!element.isConnected) removePassage(element);
    }, 100);
  }

  function setPassageState(button, next, title) {
    button.dataset.state = next;
    button.disabled = next === "loading";
    button.setAttribute("aria-busy", String(next === "loading"));
    button.textContent = next === "loading" ? "…" : next === "active" ? "❚❚" : next === "error" ? "!" : "▶";
    button.title = title || "Read this passage";
  }

  async function readPassage(button) {
    const element = [...state.buttons].find(([, control]) => control === button)?.[0];
    if (!element || button.dataset.state === "loading") return;
    const text = extractor().extractFromRoot(element, { codeMode: state.codeMode });
    if (!text) return setPassageState(button, "error", "No readable prose found");
    state.buttons.forEach((control) => setPassageState(control, "idle"));
    setPassageState(button, "loading", "Generating passage audio");
    const requestId = crypto.randomUUID();
    const response = await send({
      type: TYPES.passageRead,
      payload: {
        text,
        requestId,
        source: "passage",
        elementType: element.tagName.toLowerCase(),
        pageUrl: location.href,
      },
    }).catch((error) => ({ ok: false, error: error.message }));
    state.activeButton = response?.ok ? button : null;
    button.dataset.requestId = requestId;
    setPassageState(button, response?.ok ? "active" : "error",
      response?.ok ? "Current passage" : response?.error || "Passage could not be read");
  }

  async function showPageConfirmation() {
    state.overlay.querySelector(".mochi-audio-confirmation")?.remove();
    const text = extractor().extractFromRoot(state.pageRoot, { codeMode: state.codeMode });
    if (!text) return;
    const dialog = document.createElement("section");
    dialog.className = "mochi-audio-confirmation";
    dialog.dataset.mochiAudioUi = "confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "mochi-audio-confirm-heading");
    dialog.innerHTML = `
      <h2 id="mochi-audio-confirm-heading">Read this page</h2>
      <label>Extracted text preview<textarea data-preview></textarea></label>
      <p data-estimate role="status">Calculating estimate…</p>
      <button type="button" data-action="confirm-page">Confirm</button>
      <button type="button" data-action="cancel-page">Cancel</button>`;
    dialog.querySelector("textarea").value = text;
    state.overlay.append(dialog);
    dialog.querySelector('[data-action="cancel-page"]').focus();
    const response = await send({
      type: "ARTICLE_PREVIEW_ESTIMATE_REQUEST",
      payload: { text },
    }).catch((error) => ({ ok: false, error: error.message }));
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
    button.textContent = "Generating…";
    const response = await send({
      type: TYPES.articleRead,
      payload: {
        text,
        requestId: crypto.randomUUID(),
        source: "article",
        elementType: state.pageRoot?.tagName?.toLowerCase() || "main",
        pageUrl: location.href,
      },
    }).catch((error) => ({ ok: false, error: error.message }));
    if (response?.ok) dialog.remove();
    else {
      button.disabled = false;
      button.textContent = "Confirm";
      dialog.querySelector("[data-estimate]").textContent = response?.error || "Page could not be read.";
    }
  }

  function onOverlayClick(event) {
    const button = event.target.closest?.("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "passage") readPassage(button);
    if (button.dataset.action === "page") showPageConfirmation();
    if (button.dataset.action === "confirm-page") confirmPage(button);
    if (button.dataset.action === "cancel-page") button.closest(".mochi-audio-confirmation")?.remove();
  }

  function createPlayer() {
    if (state.playerHost?.isConnected) return state.playerHost;
    const host = document.createElement("div");
    host.dataset.mochiAudioUi = "in-page-player";
    host.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147482000;";
    const shadow = host.attachShadow({ mode: "open" });
    const logoUrl = chrome.runtime.getURL("assets/mochi.png");
    shadow.innerHTML = `
      <style>
        :host{all:initial}.bar{box-sizing:border-box;display:flex;align-items:center;gap:7px;width:min(760px,calc(100vw - 24px));padding:9px 12px;border:1px solid #9a7c3e;border-radius:16px;background:#fff8e7;color:#444a50;box-shadow:0 8px 30px #444a5033;font:13px/1.2 ui-rounded,system-ui,sans-serif}.logo{width:32px;height:32px;filter:drop-shadow(0 3px 5px #444a5024)}
        button,select,input{font:inherit}button{min-width:34px;min-height:34px;border:1px solid #9a7c3e;border-radius:8px;background:#fffdf7;color:#3f6f34;cursor:pointer}button:hover{background:#fff1f5}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #9b3154;outline-offset:2px}.progress{flex:1;min-width:90px;accent-color:#3f6f34}.time,.queue{white-space:nowrap}.status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
        @media(max-width:620px){.optional{display:none}.bar{flex-wrap:wrap}.progress{min-width:45vw}} @media(prefers-reduced-motion:reduce){*{transition:none!important}}
      </style>
      <div class="bar" role="region" aria-label="Mochi Audio playback controls">
        <img class="logo optional" src="${logoUrl}" alt="">
        <button data-command="QUEUE_PREVIOUS" aria-label="Previous chunk">⏮</button>
        <button data-command="PLAYBACK_PLAY" aria-label="Play">▶</button>
        <button data-command="PLAYBACK_PAUSE" aria-label="Pause">❚❚</button>
        <button data-command="PLAYBACK_RESUME" aria-label="Resume">↻</button>
        <button data-command="PLAYBACK_STOP" aria-label="Stop">■</button>
        <button data-command="QUEUE_NEXT" aria-label="Next chunk">⏭</button>
        <input class="progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Current chunk playback position">
        <span class="time"><span data-elapsed>0:00</span> / <span data-duration>0:00</span></span>
        <span class="queue optional" data-queue>Chunk 1 of 1</span>
        <label class="optional">Speed <select aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
        <button data-close aria-label="Close playback bar">×</button>
        <span class="status" aria-live="polite" data-status></span>
      </div>`;
    shadow.addEventListener("click", onPlayerClick);
    shadow.querySelector("select").addEventListener("change", (event) => send({
      type: "PLAYBACK_RATE_SET", payload: { rate: Number(event.target.value) },
    }));
    shadow.querySelector("input").addEventListener("change", (event) => {
      const current = state.playerState?.playback?.currentTime || 0;
      send({ type: "PLAYBACK_SEEK", payload: { deltaSeconds: Number(event.target.value) - current } });
    });
    document.documentElement.append(host);
    state.playerHost = host;
    return host;
  }

  function onPlayerClick(event) {
    const close = event.target.closest?.("[data-close]");
    if (close) {
      state.hiddenRequestId = state.playerState?.playback?.requestId || null;
      state.playerHost?.remove();
      state.playerHost = null;
      return;
    }
    const command = event.target.closest?.("[data-command]")?.dataset.command;
    if (!command) return;
    send({ type: command }).catch(() => {});
  }

  function renderPlayer(shared) {
    state.playerState = shared;
    const view = globalThis.__mochiAudioInPagePlayerState.map(shared);
    const { playback } = view;
    if (state.activeButton &&
        (playback.status === "idle" || playback.status === "ended" ||
         playback.requestId !== state.activeButton.dataset.requestId)) {
      setPassageState(state.activeButton, "idle");
      state.activeButton = null;
    }
    if (!view.visible) {
      state.playerHost?.remove();
      state.playerHost = null;
      return;
    }
    if (state.hiddenRequestId && state.hiddenRequestId === playback.requestId) return;
    if (state.hiddenRequestId !== playback.requestId) state.hiddenRequestId = null;
    const host = createPlayer();
    const shadow = host.shadowRoot;
    const progress = shadow.querySelector("input");
    progress.max = String(view.duration);
    progress.value = String(view.currentTime);
    progress.disabled = !view.determinate;
    shadow.querySelector("[data-elapsed]").textContent = view.elapsedLabel;
    shadow.querySelector("[data-duration]").textContent = view.durationLabel;
    shadow.querySelector("select").value = String(playback.playbackRate || 1);
    shadow.querySelector("[data-queue]").textContent = view.queueLabel;
    shadow.querySelector("[data-status]").textContent = `${playback.status}. Current-chunk progress.`;
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.target !== "content") return false;
    if (message.type === TYPES.enable) {
      enable(message.payload || {});
      sendResponse({ enabled: true });
      return false;
    }
    if (message.type === TYPES.disable) {
      disable();
      sendResponse({ enabled: false });
      return false;
    }
    if (message.type === TYPES.statusRequest) {
      sendResponse({ enabled: state.enabled });
      return false;
    }
    if (message.type === TYPES.playerChanged) {
      renderPlayer(message.payload);
      return false;
    }
    return false;
  }

  function enable(options = {}) {
    if (state.enabled) disable(false);
    state.enabled = true;
    state.minimumLength = Number.isFinite(options.minimumLength) ? Math.max(20, options.minimumLength) : 40;
    state.codeMode = options.skipCode === false ? "literal" : "skip";
    createOverlay();
    reconcile(document);
    state.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        scheduleScan(mutation.target);
        mutation.addedNodes.forEach(scheduleScan);
      });
    });
    state.observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class"],
    });
    document.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
    document.addEventListener("load", schedulePosition, { capture: true });
    addEventListener("resize", schedulePosition, { passive: true });
    document.fonts?.addEventListener?.("loadingdone", schedulePosition);
    document.fonts?.ready?.then(() => state.enabled && schedulePosition());
    addEventListener("popstate", onNavigation);
    addEventListener("hashchange", onNavigation);
    state.lastUrl = location.href;
    state.navigationTimer = setInterval(onNavigation, 500);
    send({ type: TYPES.statusChanged, payload: { enabled: true, pageUrl: location.href } }).catch(() => {});
    send({ type: TYPES.playerRequest }).then((response) => response?.ok && renderPlayer(response.state)).catch(() => {});
  }

  function onNavigation() {
    if (!state.enabled || state.lastUrl === location.href) return;
    state.lastUrl = location.href;
    if (state.overlay) state.overlay.dataset.pageUrl = location.href;
    reconcile(document);
  }

  function disable(notify = true) {
    state.enabled = false;
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.scanTimer);
    clearInterval(state.navigationTimer);
    state.navigationTimer = 0;
    if (state.positionFrame) cancelAnimationFrame(state.positionFrame);
    document.removeEventListener("scroll", schedulePosition, { capture: true });
    document.removeEventListener("load", schedulePosition, { capture: true });
    removeEventListener("resize", schedulePosition);
    document.fonts?.removeEventListener?.("loadingdone", schedulePosition);
    removeEventListener("popstate", onNavigation);
    removeEventListener("hashchange", onNavigation);
    state.overlay?.remove();
    state.playerHost?.remove();
    state.overlay = state.playerHost = state.pageButton = state.pageRoot = null;
    for (const element of state.buttons.keys()) delete element.dataset.mochiAudioInPageTarget;
    state.buttons.clear();
    state.activeButton = null;
    state.pendingRoots.clear();
    if (notify) send({ type: TYPES.statusChanged, payload: { enabled: false, pageUrl: location.href } }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  globalThis.__mochiAudioInPageControls = Object.freeze({ disable, enable, get enabled() { return state.enabled; } });
})();
