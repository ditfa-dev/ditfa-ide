# Changelog

All notable changes to the Ditfa Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] — 2026-11-05

### Added

- **Terminal access for Ditfa.** Ditfa in the web app, the desktop app and Ditfa Code's own agent can list your editor's terminals, read what ran in them (commands, exit codes, output) and, if you allow it, run commands in a terminal you can see. Turn it on in Settings → MCP & tools → Terminal access: **Ask before running commands** shows each command, why it is wanted and who asks before anything runs; **Read and run without asking** skips the question. Off by default, uses your Ditfa sign-in, and never runs commands in Restricted Mode.
- Output Ditfa reads has escape codes removed and obvious secrets (API keys, tokens, passwords, private keys) hidden before it leaves the editor.
- A status bar entry shows whether terminal access is connected.

## [0.6.0] — 2026-11-05

### Added

- **A real round table.** The models sit around a round table you can see: each has its own color, the leader wears a crown, and while the table works every seat shows whether it is thinking, done or failed. What each model says reads like a conversation, the peer ranking is a bar chart, and the leader's answer stands out at the end.
- **Seat models from Settings → Round table.** Click any model to seat it and a seat to free it; models are grouped by provider, and the table you set is where the next round table starts.
- **Models from every provider at the round table and in Settings**: Ditfa, each API key you added (OpenAI included), local servers, and providers from your Ditfa config.
- **The model menu switches providers itself.** Tabs for Ditfa, OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Ollama and LM Studio show which ones are ready; a provider that is not set up shows its key form, sign-in or start command right there.
- **A new composer**, like Ditfa on the web: a soft rounded box; a menu for files, commands, references, the open file, round table and settings; the model with ⌃⌄; and voice mode in the send button's place while the box is empty.
- **Attach files from the system file dialog** and the open file or selection from the composer menu.
- **Voice mode at the top of the panel.** The whole panel becomes a conversation, like Ditfa's own voice mode: a white orb that follows your voice, listens, thinks and speaks, shows what you said and what Ditfa answered, with mute and end buttons. Talk or tap the orb to interrupt.
- **Offline dictation, free and private.** The microphone in the message box turns speech into text on this computer with Whisper (whisper.cpp): no account, no API, no internet once set up. Text appears phrase by phrase while you talk. One click sets it up on macOS (Homebrew), with a Fast (82 MB) or Accurate (574 MB, every major language) model checked against its published checksum; on Windows and Linux it uses `whisper-cli` from your PATH. The open file and project names prime the model so code words come out right. `ditfa.voice.dictationEngine` chooses offline, cloud, or offline first.
- **A broken microphone recorder is found and named.** An ffmpeg or sox that is installed but no longer starts (after a Homebrew upgrade, say) is skipped with the reason, and offline dictation setup installs sox in its place.
- **Voice with your own OpenAI key.** Dictation and voice mode run on the Ditfa plan's voice, or, without a Ditfa sign-in, on an OpenAI key you added (transcription and speech).

### Changed

- API keys and the sign-in code are typed into the panel itself, in the setup screen, the model menu and Settings; no input box opens at the top of the editor anymore. Keys still go only to the system keychain.
- Ollama and LM Studio count as ready only while they answer: a message is no longer sent to a local server that is not running, and the panel shows how to start it instead.

### Fixed

- OpenAI keys work at the round table and show as saved in Settings.
- Settings listed no models without a Ditfa sign-in.

## [0.5.1] — 2026-11-05

### Changed

- The extension uses the Ditfa app icon in the VS Code Marketplace, Open VSX, and the editor.

## [0.5.0] — 2026-11-03

Ditfa Code now lives in its own repository, [ditfa-dev/ditfa-ide](https://github.com/ditfa-dev/ditfa-ide), split into packages under `@ditfa-ide/*`.

### Added

- **Round table.** Put several models on one task. *Review* mode: every model answers on its own, critiques the others anonymously (labels, not names), ranks them, and the leader writes the result with the disagreements kept. *Team* mode: the leader splits the work and each part goes to the model best suited for it, reviewed by a different model. The leader is the strongest participant by default. Each model gets its own live lane; a token and cost budget stops the table cleanly. Save the outcome to `.ditfa/round-tables/`, copy it, or hand it to the agent to implement.
- **Voice.** A dictation button that only types what you say, and a separate voice mode that talks back in your language, with hands-free turn taking and barge-in. Voice requests go to the agent (with a spoken summary) or to a quick assistant; voice, language, and microphone source are settings.
- **Settings panel** (**Ditfa: Open Settings Panel**): account and plan, usage meters, models per feature, modes and permissions, Tab autocomplete, voice, round table, MCP servers and skills, all searchable.
- **Message queue.** Messages sent while Ditfa works wait above the input and go out one by one; reorder, edit, remove, or send one now. <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> steers the running turn instead. A failed or stopped turn pauses the queue.
- **Fix with Ditfa** now fixes the code in place: a quick, focused edit around the problem, shown in the refactor preview first. **Fix with Ditfa Agent…** hands the problem to the agent instead.
- Per-message actions: copy, edit and resend, retry, and **Back to here**, which restores the files and the conversation to that message.
- Plans can be downloaded, saved into the project, or implemented with one click.
- Notification and an optional chime when a task finishes or needs your approval.
- Models show what they accept (images, files, reasoning effort) and only the controls they support; models your plan does not include are marked, with the plan that does.

### Changed

- Modes are two separate choices: **Chat / Plan / Agent** (what Ditfa does) and **Read only / Ask first / Auto / Full access** (what it may touch).
- Tab autocomplete is on by default and stays silent until a provider is set.
- Diffs show line numbers and word-level highlights; small changes open expanded.
- The loading mark is the Ditfa sparkle.

## [0.4.0] — 2026-10-24

### Added

- **Sign in with Ditfa** in the browser, for VS Code, Cursor, Windsurf, VSCodium, and other editors built on VS Code. The handoff is a PKCE-bound one-time code; editors that cannot receive the link take the code pasted. One sign-in sets up Ditfa models, Ditfa's own tools (web search, images, and more) over MCP, and usage.
- Account chip in the panel with plan and usage, and upgrade links where a feature needs a higher plan.
- **Ditfa: Sign Out** turns off the keys this editor was given.

### Fixed

- Sign-in no longer opens a page that does not exist, and no token is ever put in a URL.

## [0.3.0] — 2026-10-13

### Added

- **Tab autocomplete.** Inline suggestions accepted with <kbd>Tab</kbd>, from any provider Ditfa supports or a local model. Local code models use fill-in-the-middle; everything else uses chat completions. Off until you set it up and turn it on; never uses files that look like secrets; pauses after repeated failures.
- **Choose hunks before an edit lands.** Every hunk of a multi-hunk edit has a checkbox in the approval card; unticked hunks are taken back out as soon as the patch is applied.
- **Undo any hunk, or a whole file, after an edit.** Hunks are located by content, so it still works after other edits moved the lines. The agent is told what you took back.
- Status-bar item for Tab autocomplete, and **Ditfa: Set Up Tab Autocomplete…**.

### Changed

- Restoring a checkpoint, the diff editor, and the turn review all account for hunks you already undid.

## [0.2.0] — 2026-09-29

A rebuild of the panel and the layer under it.

### Added

- One-click engine install with SHA-256 verification, and diagnostics.
- Setup with no CLI and no account: Ditfa sign-in, API keys in the system keychain, or local models.
- Checkpoints: restore any message to revert file changes and rewind, without Git.
- Plan, Ask first, Auto, and Full access modes, applied per message and enforced by the sandbox.
- Model menu in the panel, listing what the provider really offers.
- Conversation search, rename, and delete in the panel.
- `/` commands and skills, inline edit, Fix with Ditfa, Fix Terminal Output, pasted images.
- Inline diff preview in the approval card.
- Context meter, per-turn tokens and model, an optional token limit, and a loop guard.
- Conversations restored on reload, including commands and diffs.
- Automatic engine restart with the conversation resumed.
- New look built on the Ditfa mark and its motion.

### Fixed

- **Attached files never reached the model.** `mention` inputs are for plugins and are dropped by the core.
- **Sign-in used the wrong flow** for Ditfa accounts; it now runs `ditfa login`.
- **Every user message appeared twice.**
- **Click handlers stacked up** on each state update, so collapse toggles cancelled themselves, and the draft was wiped.
- **Context percentage used lifetime tokens**, reaching 100% far too early.
- **New and deleted files showed wrong stats and an empty diff**: they carry content, not a diff.
- **Provider model lists showed OpenAI models** for every provider.
- **A retried request added a card per attempt**, and a fatal error appeared twice.
- **An approval stayed on screen** after the turn was interrupted.
- **A server killed by a signal looked alive**, and MCP elicitation requests failed.
- **A hung or failing engine gave no reason.** Starting now times out and shows stderr.
- Writing to a dead server could crash the extension host (EPIPE).
- Picking a model failed with no folder open and dirtied `.vscode/settings.json` otherwise.
- `Cmd+Shift+D` no longer overrides Run and Debug.
- A window with no folder ran the agent against `/`.

### Changed

- The engine starts with the panel, not with the editor, and a missing engine no longer opens a modal on startup.
- Streaming updates are batched, and command output is capped.

## [0.1.1] — 2026-09-15

### Fixed

- **Wrong wire field names.** The extension still used the pre-rebrand login and
  home-directory field names, which the server had already renamed. Sign-in
  via browser and the startup log line were both affected.
- **Release pipeline never ran.** The workflow's path filters and working
  directories assumed `ditfa-code/` was a subdirectory; it is the repository root.
- **Repository metadata** pointed at `Foshati/arlenta` instead of
  `ditfa-dev/ditfa-cli`.
- **Install instructions** referenced `@ditfa/cli`, which is not a published
  package. The CLI is published as `ditfa`.

### Changed

- Protocol types regenerated after the error-info and response-handoff enums were
  renamed in Rust, so the generated schema filenames now match the types they
  export and `sync-protocol` no longer has to repair them.

### Verified

- End-to-end against a compiled `ditfa` binary: handshake, `thread/start`,
  `model/list`, `account/read`, `permissionProfile/list`, `config/read`, and
  server notifications.

## [0.1.0] — 2026-09-13

First release.

### Added

- Chat sidebar backed by `ditfa app-server` over JSON-RPC/stdio, with streaming
  agent messages, reasoning summaries, and live plan tracking.
- Command execution cards with streamed output, exit status, and duration.
- File change cards that open in VS Code's native diff editor, reconstructing the
  pre- or post-patch document from the unified diff.
- Inline approvals for command execution, file changes, permission escalation, and
  agent questions.
- Provider and model pickers sourced from `config.toml` and `model/list`, with
  free-text entry for catalogs the server cannot enumerate.
- Ditfa account support: browser sign-in, device-code sign-in, API key, sign-out,
  and a plan/rate-limit/usage report.
- Approval-mode picker covering read-only, workspace-write, and full-access
  sandboxes, with explicit confirmation before disabling the sandbox.
- Thread history: resume any previous thread scoped to the current workspace.
- `@`-mention file attachment backed by the server's fuzzy file search.
- Editor integration: add selection to chat, explain selection, review uncommitted
  changes, open ditfa in a terminal.
- Status-bar item showing connection, active model, and subscription usage.
- Binary resolution across setting, bundled binary, `PATH`, and workspace Cargo
  builds, with actionable guidance when none is found.
