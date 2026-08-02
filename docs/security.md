# Security and privacy

- Keep `FISH_AUDIO_API_KEY` only in `server/.env` or the backend process environment. No extension page offers or stores a key field.
- The backend binds to `127.0.0.1` by default and restricts real-mode browser origins through `ALLOWED_EXTENSION_ID`.
- Extension host permissions cover loopback HTTP only. Configured backend URLs are normalized to `127.0.0.1` or `localhost`.
- Backend and extension boundaries validate request IDs, non-empty input, UTF-8 byte ceilings, response types, and numeric settings independently.
- Provider responses are mapped to safe error messages. Secrets, response bodies, stack traces, and full input text are not shown or logged.
- Full study text is temporary: it may exist in the current preview, queue, backend request, or provider request. Usage history stores only request metadata.
- Cost values are local estimates, not invoices. Free mode never silently permits a backend configured with a paid price.
- JSON exports contain settings and usage metadata. Review them before sharing.

Do not expose the local backend to a public interface, commit `.env`, paste keys into browser storage, or use production credentials in automated tests.
