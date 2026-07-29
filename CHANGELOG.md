# Changelog

All notable changes to the Muster VS Code extension are documented in this file.

## 0.1.0

### Added

- Initial public packaging baseline for the Muster multi-CLI coordinator extension.
- Marketplace-ready package metadata: 128×128 icon, `AI` + `Chat` categories, and this changelog.
- Pruned VSIX production closure around `@modelcontextprotocol/sdk` only (webview packages stay in `devDependencies` and ship via the Vite-bundled webview).
- Packaging gates: dependency-shape contract, allowlist/sdk-closure checks, and Extension Host activation proof via `npm run test:packaging`.
