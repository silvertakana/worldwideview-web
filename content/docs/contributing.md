---
title: Contributing
description: How to contribute to WorldWideView — code, docs, and plugins.
order: 11
---

# Contributing

WorldWideView is open source. Contributions are welcome across the main app, the plugin SDK, the Marketplace, and the documentation.

---

## Ways to contribute

| Type | Where |
|------|-------|
| Bug reports | [GitHub Issues](https://github.com/worldwideview) |
| Feature requests | GitHub Issues (label: `enhancement`) |
| Code patches | Pull requests on GitHub |
| Documentation | Pull requests on the `worldwideview-web` repo |
| Community plugins | Publish to the Marketplace |
| Answering questions | [Discord](https://worldwideview.dev/discord) |

---

## Development setup

### Prerequisites

- Windows 10/11 64-bit (the app is Windows-only; the web repos run on any platform)
- Node.js 22+
- pnpm 9+
- Git

### Clone and install

```bash
git clone https://github.com/worldwideview/worldwideview-web
cd worldwideview-web
pnpm install
```

### Run the dev server

```bash
pnpm dev
```

Opens at `http://localhost:3000`.

### Run tests

```bash
pnpm test
```

### Build

```bash
pnpm build
```

---

## Submitting a pull request

1. **Fork** the repository and create a branch from `main`
2. Make your changes — keep each PR focused on a single concern
3. Run `pnpm test` and ensure all tests pass
4. Run `pnpm build` to confirm no build errors
5. Open a PR against `main` with a clear description of what changed and why
6. A maintainer will review within a few days

For significant changes (new features, API changes, architectural decisions), open an issue first to discuss before writing code. This avoids duplicated effort.

---

## Code style

The codebase uses ESLint and Prettier, configured in `.eslintrc` and `.prettierrc`. A pre-commit hook runs both automatically.

Key conventions:
- TypeScript everywhere — no `any` without a comment explaining why
- No default exports except for Next.js page/layout files
- React components in `PascalCase.tsx`; utilities in `camelCase.ts`
- CSS Modules for all component styles — no global CSS except `globals.css`

---

## Contributing documentation

Documentation lives in `content/docs/` as Markdown files with YAML frontmatter. To add or edit a page:

1. Create or edit the `.md` file in `content/docs/`
2. Set `order:` in the frontmatter to control sidebar position
3. Run `pnpm dev` and visit `http://localhost:3000/docs` to preview
4. Submit a PR

Frontmatter fields:

```yaml
---
title: Page Title
description: One-line description for SEO and the index page
order: 5
---
```

---

## Publishing a community plugin

Community plugins live on the Marketplace rather than in the main repository. To publish:

1. Build your plugin following the [Plugin Quickstart](/plugin-quickstart)
2. Create a Marketplace account at [marketplace.worldwideview.dev](https://marketplace.worldwideview.dev)
3. Run `pnpm publish:wwv` from your plugin directory
4. Fill in your Marketplace listing (description, screenshots, changelog)
5. Submit for review — the review process takes 1–3 business days

See the [Manifest Reference](/manifest-reference) for all available fields and the [Permissions](/permissions) page to understand what reviewers check.

---

## Code of conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/). Be respectful and constructive. Harassment of any kind is not tolerated.

Report conduct issues to the maintainers via Discord DM or by emailing the address listed in the GitHub repository.
