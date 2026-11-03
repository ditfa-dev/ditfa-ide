# Contributing

Thanks for helping. Bug reports with steps to reproduce, and small focused pull requests, are the most useful.

## Setup

Node 22 and pnpm 10.

```bash
pnpm install
pnpm run check
```

Press <kbd>F5</kbd> to run the extension in an Extension Development Host. `pnpm run watch` rebuilds on change.

## Code

- TypeScript, strict. Packages import each other as `@ditfa-ide/<name>`, never by relative path across packages.
- `packages/*` stay free of `vscode` imports, so they are unit-testable; editor glue lives in `apps/vscode`.
- `packages/protocol/src/generated` is generated; change the engine and run `pnpm run sync-protocol` instead of editing it.
- User-facing text is plain, short English.
- Add or update tests next to the code you change. `pnpm test` must pass, and `pnpm run build` must stay within the bundle budgets in `apps/vscode/scripts/check-bundle-size.mjs`.

## Pull requests

- One change per pull request, with a short description of the why.
- Add a line under the next version in `apps/vscode/CHANGELOG.md` for anything a user would notice.
- By contributing you agree that your contribution is licensed under the Apache License 2.0.

## Releases

Maintainers bump `apps/vscode/package.json`, add the changelog entry, and push a `v<version>` tag. CI tests, packages, creates the GitHub release, and publishes to the VS Code Marketplace and Open VSX.
