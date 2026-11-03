# Architecture

```
┌──────────────────────── editor (VS Code, Cursor, …) ────────────────────────┐
│                                                                              │
│  apps/vscode  (extension host, Node)                                         │
│  ├─ controller          threads, turns, queue, modes, checkpoints            │
│  ├─ account             Ditfa sign-in, SecretStorage, keys ─────────┐        │
│  ├─ completion/quickFix Tab suggestions, Fix with Ditfa             │        │
│  ├─ roundtable          RoundTableService → @ditfa-ide/roundtable   │        │
│  ├─ voice               microphone, dictation, voice mode           │        │
│  └─ ui                  chat view, settings panel  ◄── postMessage ─┼──┐     │
│          │                                                          │  │     │
│          │ JSON-RPC over stdio                                      │  │     │
│          ▼                                                          │  │     │
│  ditfa app-server  (Rust engine, ditfa-dev/ditfa-cli)               │  │     │
│          │ sandbox, tools, MCP                                      │  │     │
└──────────┼──────────────────────────────────────────────────────────┼──┼─────┘
           ▼                                                          ▼  │
   model providers (OpenAI-compatible, Anthropic, local)      Ditfa API  │
                                                     /api/ide/*, /api/v1,│
                                                     MCP tools, voice    │
                                                                         │
   packages/webview  (chat panel + settings panel, no framework) ◄───────┘
```

## Packages

Each package is TypeScript, published inside the repository as `@ditfa-ide/<name>`, and resolved through `tsconfig.base.json` paths; esbuild bundles them into the extension.

- **protocol**: the engine's JSON-RPC types, generated from `ditfa-rs/app-server-protocol` by `scripts/sync-protocol.mjs`. Never edited by hand.
- **contract**: every message between the extension host and its panels (`HostMessages`, `WebviewMessages`, settings snapshots). Both sides type-check against it, so a renamed field fails the build, not the user.
- **core**: logic with no editor dependency: diff parsing and word-level rows, hunk revert, checkpoints, completion prompts, quick-fix windows and parsing, the message queue, modes, transcript storage, speech detection. A `Logger` interface replaces the output channel.
- **cloud**: the Ditfa API client: PKCE sign-in and code exchange, profile and usage, model catalog, voice (transcribe, synthesize, socket), and a streaming chat client for OpenAI-compatible and Anthropic endpoints. Uses `fetch` only, with timeouts, no redirects, and typed errors (`planRequired`, `unauthorized`).
- **roundtable**: the round-table engine. Pure TypeScript; models are reached through an injected `ModelRunner`, so it runs the same against Ditfa, a user's keys, local models, or test fakes.
- **webview**: the chat panel and the settings panel. Plain DOM and CSS, under 80 KB, rendered from `contract` state.

## Sign-in

1. The extension makes a PKCE verifier (kept in memory) and opens `chat.ditfa.com/ide/sign-in?challenge&state&scheme`.
2. The signed-in page asks `POST /api/ide/auth/code` for a one-time code bound to the user and the challenge, then opens `<scheme>://ditfa.ditfa-code/auth-callback?code&state`, or shows the code to paste.
3. The extension checks `state` and posts code + verifier to `POST /api/ide/auth/exchange`. It gets a session, an engine key for model calls, and an MCP key for Ditfa's tools, named after the editor and OS so they can be told apart and revoked.
4. The engine gets the keys as environment variables; each thread joins the `ditfa` MCP server through `thread/start` config.

Plan checks happen on the server when a key is used, so an upgrade or a cancelled plan takes effect without signing in again.

## Turns, modes, and the queue

A message carries its mode (chat, plan, agent) and access level (read only … full access). The controller turns them into the engine's approval policy and sandbox for that turn only. Messages sent while a turn runs go into the queue, or steer the running turn; the queue pauses when a turn fails or is stopped. Every turn is a checkpoint: **Back to here** reverts file changes recorded since and rewinds the thread.

## Round table

`review`: propose in parallel → anonymous critique rounds (labels shuffled from a seed, early stop when nobody changes) → ranking of others only, combined with Borda → synthesis by the leader. `team`: the leader's plan is validated (at most eight parts, unknown dependencies dropped, cycles broken) → each part goes to the best-scoring model with a load penalty → dependency order → review by a different model → integration. Text from other models is fenced with a per-table nonce. A shared semaphore, per-call timeouts, an abort signal, and a token and cost budget bound every run.

## Voice

Dictation records 16 kHz PCM, sends WAV to Ditfa for transcription, and inserts the text. Voice mode adds a speech detector for turn taking and barge-in, sends the request to the agent or a quick assistant, chunks the reply into sentences, and plays synthesized audio as it arrives.
