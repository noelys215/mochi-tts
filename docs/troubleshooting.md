# Troubleshooting

## Backend unavailable

Run `npm start`, confirm the options page uses a loopback URL such as `http://127.0.0.1:3000`, and check `/api/health`. If the port changes, save the matching URL in extension options.

## Extension cannot read a page

Chrome internal pages, the Web Store, PDFs, and other restricted pages may reject script injection. Use a normal HTTP(S) page and retry after focusing it. Select non-empty text for selection reading.

## Real provider fails

Confirm real mode has `FISH_AUDIO_API_KEY`, `FISH_AUDIO_REFERENCE_ID`, a verified `FISH_AUDIO_MODEL`, current `FISH_AUDIO_PRICE_PER_MILLION_BYTES`, and the installed extension ID in `ALLOWED_EXTENSION_ID`. Authentication, payment, invalid reference, rate-limit, and timeout failures are intentionally sanitized in the UI.

## Generation is blocked

Open **All options**. A paid backend requires explicit paid or custom pricing mode. Check the monthly limit, hard stop, warning threshold, and one-time override. Ensure the chunk limit does not exceed the backend limit.

## Hover or article text is missing

Hover targets must meet the configured minimum length. Article extraction excludes navigation, sidebars, forms, hidden content, and code by default. Change code handling in the preview or disable **Skip code by default** in options.

## Playback or queue state is stale

Stop and clear the queue, then start a new read. An extension reload discards runtime queue audio but keeps settings and usage metadata. Reopen the popup to reconnect to the offscreen player.

## Tests

Run `npm run test:unit` for logic/backend failures and `npm run test:browser` for Chrome workflows. Tests require the installed Playwright Chromium channel and use only the mock provider.
