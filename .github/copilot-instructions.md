# Copilot Instructions for StructuraLensAction

## Build, lint, and test commands

- Install dependencies: `npm ci`
- Lint: `npm run lint`
- Build distributable action bundle: `npm run build`
- Format check: `npm run format`

This repository currently has no `npm test` script or test runner configuration, so there is no supported single-test command yet.

## High-level architecture

- This is a JavaScript GitHub Action with metadata in `action.yml` and runtime logic in `src/index.js`.
- Published execution uses `dist/index.js` (`runs.main`), generated from `src/index.js` via `@vercel/ncc` (`npm run build`).
- The action downloads the external StructuraLens CLI from `andy-c-jones/StructuraLens` at runtime (version input supports explicit versions or `latest`).
- Execution has two main paths:
  - PR diff path (`pull_request`/`pull_request_target` with `run-diff=true`): checkout base/head SHAs, run CLI analyses, generate diff outputs (JSON/HTML/Markdown), optionally post a PR comment, and upload artifacts for large comments or fallback.
  - Non-PR snapshot path: run a single analysis and emit JSON/HTML reports.
- Report/comment behavior is coordinated through `.structuralens` output files and action outputs (`base-report-json`, `head-report-json`, `diff-report-json`, `diff-report-html`).

## Key repository conventions

- Keep `src/index.js` and `dist/index.js` in sync. Any source change that affects runtime behavior must be followed by `npm run build`, and CI/release workflows enforce `dist` freshness.
- Use action inputs through `@actions/core` consistently. Boolean-like inputs are string-checked with `core.getInput(...) !== "false"`.
- Token resolution pattern is: `core.getInput("github-token") || process.env.GITHUB_TOKEN || ""`; use this shared token source for authenticated GitHub API operations.
- PR comment payloads must respect GitHub comment size limits (`SAFE_COMMENT_CHAR_LIMIT`) and use the compact-comment/artifact fallback path when oversized.
- Preserve the ref-restore behavior in `finally` (the action force-checkouts base/head during PR diff analysis and must return to the original ref).
- Use Conventional Commits for commit messages and PR titles (for example, `fix: ...`, `docs: ...`, `feat: ...`).
