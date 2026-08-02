# Mochi Audio

A Manifest V3 Chrome extension that sends selected or extracted study text to a local Express text-to-speech backend. It supports selection, hover, and article reading, persistent playback, local cost estimates, spending safeguards, and text-free usage history.

## Requirements and accounts

- Node.js 20 or newer and npm
- Chrome 116 or newer
- No account for mock mode
- A Fish Audio account, API key, and saved voice reference for real mode

## Install and configure

```sh
npm install
cp server/.env.example server/.env
```

The backend reads `HOST`, `PORT`, `FISH_AUDIO_MOCK_MODE`, `FISH_AUDIO_API_KEY`, `FISH_AUDIO_REFERENCE_ID`, `FISH_AUDIO_MODEL`, `FISH_AUDIO_PRICE_PER_MILLION_BYTES`, `FISH_AUDIO_API_BASE_URL`, `FISH_AUDIO_MAX_INPUT_BYTES`, `FISH_AUDIO_OUTPUT_FORMAT`, `FISH_AUDIO_TIMEOUT_MS`, `FISH_AUDIO_MAX_RETRIES`, and `ALLOWED_EXTENSION_ID`.

Mock mode is the credential-free default. For real mode, set `FISH_AUDIO_MOCK_MODE=false`, provide the API key and saved voice reference only in `server/.env`, select a verified model, set its current price per million UTF-8 bytes, and set `ALLOWED_EXTENSION_ID` after loading the extension once. Never put the API key in extension settings.

Start the loopback backend:

```sh
npm start
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the `extension` directory.

## Use

- Selection: select page text and choose **Read selection**, or use the selection context menu.
- Hover: enable **Passage hover controls**, point at eligible prose, then use the floating passage or page action. LeetCode lesson iframes are supported; page reads require confirmation.
- Article: choose **Read article**, edit the extracted preview, optionally normalize DSA notation or change code handling, then confirm.
- In-page controls: choose **Enable on this tab** to add passage actions, **Read this page**, and a synchronized playback bar. Multi-chunk playback reports queue position; seeking is limited to the current chunk.
- Playback: use play, pause, seek, speed, next, previous, stop, and clear controls. Playback continues after the popup closes.
- Estimates: the popup shows current, daily, and monthly local estimates. They are not an invoice. Configure safeguards through **All options**.
- History: open **Full history** to inspect metadata, export JSON, or reset after confirmation. Study text is not stored in history.

## Tests

```sh
npm test
```

For unit tests only, run `npm run test:unit`; browser integration tests use `npm run test:browser`.

## Security and privacy

The provider key remains server-side, the server binds to loopback by default, inputs are independently validated, and upstream errors are sanitized. Full text exists only while previewing, queueing, or generating audio. See [security](docs/security.md), [architecture](docs/architecture.md), and [troubleshooting](docs/troubleshooting.md).

The extension retains narrow LeetCode host access so its content controller can run inside lesson frames. The `webNavigation` permission is used only to reinitialize enabled frame-local controls after iframe navigation or replacement; it does not grant page-content access by itself. No broad `<all_urls>` permission is requested.
