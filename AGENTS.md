# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains all TypeScript source for the Obsidian plugin.
- `src/commands/` holds editor actions (`continue-writing`, `summarize-note`, `improve-rewrite`, `fast-answer`).
- Core integration logic lives in `src/main.ts`.
- Provider clients live in `src/claude-client.ts`, `src/openai-client.ts`, `src/openrouter-client.ts`, and `src/ollama-client.ts`.
- Shared OpenAI-compatible streaming/translation logic lives in `src/openai-compatible.ts`.
- Settings UI and persisted plugin settings live in `src/settings.ts`.
- Vault tool definitions and execution live in `src/vault-tools.ts`.
- UI code lives in `src/chat-view.ts` and `src/preview-modal.ts`.
- Build/config files are at repo root: `esbuild.config.mjs`, `eslint.config.mjs`, `tsconfig.json`, `manifest.json`, `versions.json`, and `styles.css`.
- Compiled plugin output is `main.js` (root). Documentation is in `README.md`. Screenshot assets are under `.github/assets/`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run esbuild in watch mode with inline sourcemaps for development.
- `npm run build`: produce the production bundle (`main.js`) with minification enabled.
- `npm run lint`: run ESLint on `src/`.

Example workflow:
`npm run lint && npm run build`

## Coding Style & Naming Conventions
- Language: TypeScript (`src/**/*.ts`) with strict null checks and `noImplicitAny`.
- Indentation and formatting follow existing code style: tabs and double quotes.
- Prefer explicit types and `type` imports (`@typescript-eslint/consistent-type-imports` is enforced).
- Avoid `console` usage and `any` (`no-console` and `no-explicit-any` are errors).
- Name command modules with kebab-case files (for example, `fast-answer.ts`), classes/interfaces in PascalCase, and functions/variables in camelCase.

## Testing Guidelines
- No automated test suite is currently configured.
- Minimum quality gate: `npm run lint` and `npm run build` must pass before submitting.
- Validate behavior manually in Obsidian by loading the plugin from `.obsidian/plugins/vault-pensieve/`.
- Manual checks should cover provider settings flows for Anthropic, OpenAI, OpenRouter, and Ollama as applicable.
- Verify chat sidebar behavior, model switching, saved chat history, vault tool execution notices, writing command preview flows, and the `fast-answer` editor shortcut.

## Commit & Pull Request Guidelines
- Prefer Conventional Commit style used in history (for example, `feat: ...`, `fix: ...`, `refactor: ...`, `chore: ...`).
- Keep commits focused and scoped to one change.
- PRs should include:
  - concise summary of what changed and why,
  - validation steps run (lint/build/manual checks),
  - screenshots or GIFs for UI changes (`chat-view`, settings, modal updates),
  - linked issue/reference when applicable.

## Security & Configuration Tips
- Never commit API keys or vault-private note content.
- Keep provider secrets in Obsidian plugin settings (`data.json`), not source files.
- Do not hardcode API credentials, custom system prompts containing private data, or local environment-specific Ollama URLs into the repository.
