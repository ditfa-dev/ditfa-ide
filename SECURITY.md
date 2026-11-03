# Security

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/ditfa-dev/ditfa-ide/security/advisories/new) or email security@ditfa.com with what you found, how to reproduce it, and what it lets an attacker do. We reply within three working days and keep you posted until it is fixed. We credit reporters in the release notes unless you ask us not to.

Vulnerabilities in the agent, its sandbox, or provider adapters belong to [ditfa-dev/ditfa-cli](https://github.com/ditfa-dev/ditfa-cli/security).

## Supported versions

Only the latest release gets fixes. The extension updates itself from the marketplace.

## What the extension does to keep you safe

- **Sign-in** is a PKCE-bound one-time code: a code that reaches the wrong app is useless without the verifier, which never leaves the editor process. No token is ever put in a URL. The browser page only navigates to known editor schemes.
- **Secrets** (session, keys) are kept in the editor's `SecretStorage`, backed by the system keychain, and handed to the engine as environment variables, never written to settings or logs. Signing out revokes the keys this editor was given.
- **Panels** run under a strict Content Security Policy with a fresh nonce per load; no remote scripts, no inline handlers. Every message from a panel is validated against the latest state before the host acts on it, and links open only from an allowlist.
- **Sandbox**: read-only and workspace modes are enforced by the engine's sandbox, not by prompts. Full access asks for confirmation.
- **Round table**: text from one model is fenced with a per-table random nonce before another model sees it, and models are told fenced text is data, not instructions.
- **Autocomplete and quick fixes** never read or send files that look like secrets (`.env`, `.npmrc`, keys, `*.pem`).
- **Engine download** is checked against the published SHA-256 before it runs.
- **Releases** are built in CI from a tag, with actions pinned to commit SHAs; every `.vsix` ships with its SHA-256.
