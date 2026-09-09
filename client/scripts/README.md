# Frontend Module Notes

This project still runs as plain HTML/CSS/JavaScript with no build step.

New feature code should move into `scripts/*.js` modules instead of growing
`app.js`. Each module should expose a small factory on `window.MindChatModules`.
`app.js` owns shared application state and passes only the required functions
into each module through a context object.

Current modules:

- `chat.js`: chat overlay rendering, branch navigation, and chat composer.
- `importer.js`: external chat log parsing and import-card normalization.
- `security.js`: safe Markdown rendering and HTML allowlist sanitization.
- `storage.js`: resilient localStorage writes, session-scoped API key config,
  and IndexedDB key-value helpers for staged durable-storage migration.

Smoke tests:

- `tests/index.html`: browser test index.
- `tests/importer-smoke.html`: browser smoke tests for chat import parsing.
- `tests/p1-smoke.html`: browser smoke tests for the security and storage modules.

When adding a module:

1. Keep the module self-contained.
2. Do not read top-level `app.js` variables directly from the module.
3. Add required state/actions to the context bridge in `app.js`.
4. Load the module before `app.js` in `index.html`.
5. Bump the script query version in `index.html`.
