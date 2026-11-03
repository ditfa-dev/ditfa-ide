<p align="center">
  <img src="apps/vscode/media/icon.png" width="96" alt="Ditfa">
</p>

<h1 align="center">Ditfa Code</h1>

<p align="center">
  The Ditfa coding agent for VS Code, Cursor, Windsurf, VSCodium, and every editor built on VS Code.
</p>

<p align="center">
  <a href="https://github.com/ditfa-dev/ditfa-ide/actions/workflows/ci.yml"><img src="https://github.com/ditfa-dev/ditfa-ide/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ditfa-dev/ditfa-ide/releases/latest"><img src="https://img.shields.io/github/v/release/ditfa-dev/ditfa-ide?label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
</p>

---

Ditfa Code reads, writes, and runs code in your workspace, and shows its work: every edit as a diff you can keep or undo hunk by hunk, every command with its output, every message a checkpoint you can go back to.

- **Sign in with Ditfa** once for models, Ditfa's tools (web search, images, and more), and usage, or bring your own keys, or run local models.
- **Chat, Plan, or Agent**, each with its own access level, enforced by the engine's sandbox.
- **Round table**: several models on one task, reviewing each other anonymously or splitting the work as a team.
- **Tab autocomplete** and **Fix with Ditfa** in place, from the lightbulb.
- **Voice**: dictation, and a voice mode that talks back in your language.
- **Message queue**, notifications when work is done, and a settings panel for all of it.

User documentation lives in the [extension README](apps/vscode/README.md); what changed in each version is in the [changelog](apps/vscode/CHANGELOG.md).

## Install

- **VS Code Marketplace / Open VSX**: search for *Ditfa Code*.
- **From a release**: download `ditfa-code-<version>.vsix` from [Releases](https://github.com/ditfa-dev/ditfa-ide/releases), check it against the `.sha256` next to it, and run

  ```bash
  code --install-extension ditfa-code-0.5.0.vsix
  ```

  In Cursor, Windsurf, or VSCodium use **Extensions: Install from VSIX**.

## Repository

| Path | Package | What it is |
| --- | --- | --- |
| `apps/vscode` | `ditfa-code` | The extension: host, commands, panels |
| `packages/protocol` | `@ditfa-ide/protocol` | Engine wire types, generated from the Ditfa CLI |
| `packages/contract` | `@ditfa-ide/contract` | Messages between the extension host and its panels |
| `packages/core` | `@ditfa-ide/core` | Diffs, checkpoints, completion, sessions, voice detection |
| `packages/cloud` | `@ditfa-ide/cloud` | Ditfa account, models, voice, streaming chat |
| `packages/roundtable` | `@ditfa-ide/roundtable` | The round-table engine |
| `packages/webview` | `@ditfa-ide/webview` | Chat panel and settings panel UI |

The design is in [ARCHITECTURE.md](ARCHITECTURE.md). The agent itself, its sandbox, and provider adapters are in [ditfa-dev/ditfa-cli](https://github.com/ditfa-dev/ditfa-cli).

## Development

Node 22 and pnpm 10.

```bash
pnpm install
pnpm run check      # typecheck + tests
pnpm run build      # production bundle in apps/vscode/dist
pnpm run package    # ditfa-code-<version>.vsix
```

Open the repository in VS Code and press <kbd>F5</kbd> to start an Extension Development Host. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

The code is Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The Ditfa name and marks are not covered by that license; see [TRADEMARKS.md](TRADEMARKS.md).
