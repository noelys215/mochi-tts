# Architecture

Fish Study Reader has four boundaries:

1. Injected content scripts extract an explicit selection, eligible hover passage, or cleaned article. They never receive credentials.
2. The MV3 service worker validates runtime messages, enforces budgets, chunks text, coordinates bounded generation, and stores settings plus successful-request metadata.
3. One offscreen document owns audio playback so closing the popup does not stop audio.
4. The loopback Express backend validates text and request IDs, reads provider credentials from its environment, calls Fish Audio or the mock provider, and returns audio with safe usage headers.

Popup, options, and history pages communicate through centralized runtime message types. `chrome.storage.local` contains settings and deduplicated usage records, never study text or audio. Queue text and generated data URLs are runtime-only. The queue generates the current chunk and at most one upcoming chunk; replaying ready audio does not create usage.

The backend `/api/health` response exposes only safe model, pricing, mode, and byte-limit metadata. `/api/tts` is the only generation endpoint. Automated browser tests use the local mock provider and never call Fish Audio.
