# Verified API and architecture notes

Verified: 2026-08-02

Scope: documentation-only verification. No Fish Audio request was made.

## Environment

| Capability | Verified state |
| --- | --- |
| Node.js | `v22.14.0` (meets Node 20+ requirement) |
| npm | `11.6.2` |
| Git | `2.39.5`; repository initialized |
| Chrome | Google Chrome `151.0.7922.72` at `/Applications/Google Chrome.app` |
| Playwright package | `1.62.1` installed as a development dependency |
| Context7 | Available and successfully queried |
| Playwright MCP | Available (browser tools are registered) |

## Official sources

Fish Audio:

- [Text to Speech API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [Pricing and rate limits](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)
- [Models overview](https://docs.fish.audio/developer-guide/models-pricing/models-overview)
- [Quick start](https://docs.fish.audio/developer-guide/getting-started/quickstart)

Chrome Extensions:

- [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/)
- [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Context menus API](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
- [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [`activeTab` permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

## Fish Audio contract

- Base URL: `https://api.fish.audio`.
- Synthesis: `POST /v1/tts`.
- Authentication: required `Authorization: Bearer <token>` header.
- Request encoding: `application/json` or `application/msgpack` only.
- Model selection: required `model` header. The current endpoint lists `s1`, `s2-pro`, `s2.1-pro`, and `s2.1-pro-free`; it currently defaults to and identifies `s2.1-pro-free` as the free developer-tier model.
- Minimum JSON body: non-empty `text`. Use configured `reference_id` for a saved voice model; do not embed or assume a public voice ID. The API also supports inline `references`, for which MessagePack avoids base64 overhead.
- Output selection uses `format`, not `output_format`. Values are `mp3` (default), `wav`, `pcm`, and `opus`. MP3 supports 32/44.1 kHz and 64/128/192 kbps; Opus is 48 kHz and supports auto/24/32/48/64 kbps; WAV/PCM is mono 16-bit at 8/16/24/32/44.1 kHz.
- Other relevant optional fields include `sample_rate`, `mp3_bitrate`, `opus_bitrate`, `normalize`, `latency`, `prosody`, `temperature`, `top_p`, and generation/chunk controls. Version 1 should send only fields it needs.
- A successful non-timestamped request returns the encoded audio body; official examples stream it directly to an output file. The reference does not currently state a precise response `Content-Type`.
- Documented errors include `401` authentication, `402` payment/balance, and `422` validation. Provider errors must be mapped to safe local error categories.

### Pricing and limits

- TTS is billed from input size in millions of UTF-8 bytes.
- `s2.1-pro`, `s2-pro`, and `s1`: USD $15.00 per 1,000,000 UTF-8 bytes.
- `s2.1-pro-free`: USD $0.00 per 1,000,000 UTF-8 bytes.
- Therefore, for a selected model with a documented price: `estimatedCost = utf8Bytes / 1_000_000 * pricePerMillionBytes`. Accumulated values should use integer microdollars.
- Rate limiting is concurrency-based, not fixed QPS/QPM: Starter (under $100 paid) 5 concurrent requests; Elevated ($100+ paid) 15; High Volume ($1,000+ paid) 50; Enterprise custom.
- The endpoint documents internal chunk controls (`chunk_length` 100–300 characters, default 300; `min_chunk_length` 0–100, default 50; `max_new_tokens` default 1024). These are generation controls, not a published maximum request-text size.

### Fish Audio uncertainties

- No maximum request text length or UTF-8 byte ceiling is published on the current TTS endpoint or pricing page. The backend must enforce its own conservative, configurable UTF-8 byte limit and article text must be chunked; the chosen limit must be validated before live integration.
- The free model is documented as available and free per byte, but eligibility, monthly credit/quota, voice/reference restrictions, availability guarantees, and free-tier concurrency are not stated. Do not represent it as unlimited.
- The endpoint reference does not identify the successful response MIME type or usage-metadata headers. Inspect the official schema and a controlled authenticated response before strict response validation and completed-request accounting are implemented.
- Current live documentation supersedes an older indexed excerpt that listed only `s1`/`s2-pro`. Model names, free-tier availability, prices, and limits must be reverified immediately before Fish integration and before release.

### Phase 2 reverification — 2026-08-02

- The official current contract still uses `POST /v1/tts`, `Authorization: Bearer`, `Content-Type: application/json`, and a required `model` header. The minimal configured voice request uses `text`, `reference_id`, and `format`; success is binary audio.
- Current model/pricing documentation lists `s2.1-pro`, `s2-pro`, and `s1` at $15/M UTF-8 bytes and `s2.1-pro-free` at $0/M. `s2.1-pro` is the recommended production model; the free variant has no guarantees.
- Official retry guidance is limited to `429` and `5xx` with exponential backoff. Other `4xx` failures require configuration or request changes and must not be retried.
- A maximum input-text size, guaranteed success MIME type, response usage headers, and free-tier quota remain unpublished. The adapter therefore enforces a configurable local byte limit, derives usage locally, and accepts binary audio with either an audio MIME type or `application/octet-stream`.

## Chrome extension contract

- Use Manifest V3 with `background.service_worker`; extension service workers are event-driven, may be unloaded when dormant, and cannot access the DOM. Durable state must not depend on service-worker globals.
- Use one static offscreen document for audio playback. Declare `offscreen`, create it with reason `AUDIO_PLAYBACK` and a justification, and communicate through `chrome.runtime` (the only extension API exposed there). Chrome closes an `AUDIO_PLAYBACK` offscreen document after 30 seconds without audio. Offscreen documents require Chrome 109+; `runtime.getContexts()` is available in Chrome 116+.
- Declare `contextMenus`; create one item with the `selection` context and handle it through `chrome.contextMenus.onClicked` in the service worker. The click data can provide `selectionText`.
- Declare `scripting` plus `activeTab` for temporary, user-gesture-scoped injection. `activeTab` is granted by extension actions and context-menu clicks. This avoids `<all_urls>`; restricted browser pages must fail safely.
- Declare `storage`. `chrome.storage` is asynchronous and available to service workers. `storage.local` persists until uninstall and has a 10 MB quota in current Chrome. Restrict its access to trusted extension contexts with `setAccessLevel`; store settings, queue metadata, budget, and deduplicated usage—not API keys or retained full-text history.
- Expected permissions are `activeTab`, `scripting`, `storage`, `contextMenus`, and `offscreen`. Add only a narrow loopback backend host permission (for example, the configured `http://127.0.0.1:<port>/*` origin) if Chrome requires it for extension fetches; never request `<all_urls>` for version 1.

## Architecture plan

1. **Extension UI and page adapters:** a plain popup requests explicit selection, hover, or article actions. Small injected scripts extract only the requested text. Hovering itself performs no synthesis or accounting.
2. **MV3 coordinator:** the service worker validates centralized message envelopes and request IDs, owns orchestration, restores durable state from `chrome.storage.local`, creates the context menu, and ensures a single offscreen document exists.
3. **Persistent playback:** the offscreen document owns the audio element and playback/queue runtime. It reports state through runtime messages so closing the popup does not stop playback.
4. **Local security boundary:** an Express server binds to loopback, loads `FISH_API_KEY` from environment only, accepts allowlisted extension-origin requests, validates request IDs/text/UTF-8 byte size, avoids logging full text, calls Fish with native `fetch`, and returns sanitized errors plus usage metadata. The extension never receives or stores the provider key.
5. **Usage and budget:** estimate before generation using the currently selected model's verified per-byte price; count a completed request once by request ID using backend metadata as primary evidence. Replaying cached/current audio creates no new usage.
6. **Testing:** use Node's test runner for validation, byte/pricing math, reducers, and backend mock behavior. Install Playwright later only for essential extension workflows against fixture pages and a mock backend; never call Fish from automated tests.

Target Chrome 116+ initially so offscreen-document discovery can use `runtime.getContexts()` without a legacy fallback. Reconsider only if broader browser support becomes a requirement.

## Implemented contract

The current implementation follows the verified contracts above: a mock-by-default Express adapter, explicit real-provider configuration, MV3 service-worker coordination, one offscreen audio document, loopback-only extension hosts, local usage/budget accounting, bounded chunk generation, and no retained study text in history. These notes document external facts; operational instructions live in the README and focused architecture, security, and troubleshooting documents.

## Reverification gates

Before implementing the real provider adapter, reverify the Fish endpoint schema, model header values, response body/MIME behavior, text ceiling, usage metadata, free-tier conditions, pricing, concurrency, and error shapes. Before release, recheck Chrome minimum versions, offscreen lifecycle behavior, and whether the exact loopback fetch pattern requires a manifest host permission.
