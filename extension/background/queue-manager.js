import { chunkText } from "../shared/chunking.js";

export function createQueueManager({ generate, play, stop, onStateChange = () => {} }) {
  let entries = [];
  let currentIndex = -1;
  const pending = new Map();
  let epoch = 0;

  function state() {
    return {
      currentIndex,
      entries: entries.map(({ text: _text, audioUrl: _audio, ...entry }) => entry),
    };
  }

  async function ensureReady(index, expectedEpoch = epoch) {
    const entry = entries[index];
    if (!entry || entry.audioUrl || entry.status === "cancelled") return entry;
    if (pending.has(index)) return pending.get(index);
    const controller = new AbortController();
    entry.status = "generating";
    onStateChange(state());
    const promise = generate(entry, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || expectedEpoch !== epoch || entries[index] !== entry) {
          throw new DOMException("Generation was cancelled.", "AbortError");
        }
        entry.audioUrl = result.audioUrl;
        entry.usage = result.usage;
        entry.status = "ready";
        onStateChange(state());
        return entry;
      })
      .catch((error) => {
        entry.status = controller.signal.aborted ? "cancelled" : "failed";
        entry.error = error.message;
        onStateChange(state());
        throw error;
      })
      .finally(() => {
        pending.delete(index);
        pending.delete(`controller-${index}`);
      });
    pending.set(index, promise);
    pending.set(`controller-${index}`, controller);
    return promise;
  }

  async function playIndex(index, expectedEpoch = epoch) {
    const entry = await ensureReady(index, expectedEpoch);
    if (expectedEpoch !== epoch || entries[index] !== entry) {
      throw new DOMException("Generation was cancelled.", "AbortError");
    }
    if (!entry?.audioUrl) throw new Error(entry?.error || "Queue item is unavailable.");
    if (entries[currentIndex]?.status === "playing") entries[currentIndex].status = "completed";
    currentIndex = index;
    entry.status = "playing";
    await play(entry);
    onStateChange(state());
    if (index + 1 < entries.length && !entries[index + 1].audioUrl) {
      ensureReady(index + 1).catch(() => {});
    }
    return entry;
  }

  async function clear() {
    epoch += 1;
    for (const [key, controller] of pending) {
      if (String(key).startsWith("controller-")) controller.abort();
    }
    pending.clear();
    await stop();
    entries = [];
    currentIndex = -1;
    onStateChange(state());
    return state();
  }

  return {
    async load({ text, maxBytes, requestId, source }) {
      await clear();
      const loadEpoch = epoch;
      entries = chunkText(text, maxBytes).map((chunk, index) => ({
        id: crypto.randomUUID(),
        requestId: index === 0 ? requestId : crypto.randomUUID(),
        text: chunk,
        source,
        status: "pending",
      }));
      onStateChange(state());
      const entry = await playIndex(0, loadEpoch);
      return { usage: entry.usage, state: state() };
    },
    next() {
      if (currentIndex + 1 >= entries.length) throw new Error("Already at the end of the queue.");
      return playIndex(currentIndex + 1).then(() => state());
    },
    previous() {
      if (currentIndex <= 0) throw new Error("Already at the start of the queue.");
      return playIndex(currentIndex - 1).then(() => state());
    },
    async stop() {
      await stop();
      if (entries[currentIndex]?.status === "playing") entries[currentIndex].status = "ready";
      onStateChange(state());
      return state();
    },
    clear,
    state,
  };
}
