# Changelog

## 0.2.1 — 2026-10-17

- Preserve search, selection and scroll position when refreshing command data.
- Parse JSONC keybindings with the official jsonc-parser dependency; display platform overrides, conditional bindings and unbinding declarations more accurately.
- Add file watching, contribution caching, refresh debouncing and cleanup of listeners.
- Validate command execution messages, serialize usage updates and add a diagnostics command.
- Package runtime dependencies and prepare releases in GitHub Actions without an Azure subscription; upload the VSIX through Marketplace.

## 0.2.0

- Previously published command deck baseline.
