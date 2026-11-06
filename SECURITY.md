# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mhanafi09051998/gahar-code/security/advisories/new).
Do not open a public issue. Include the version (`gahar --version`), your OS and Node.js version,
and steps to reproduce. You will get an acknowledgement within 7 days.

Only the latest release receives security fixes. Update with `gahar update`.

## Data model

Gahar Code runs locally and has no telemetry.

- Your OpenRouter API key comes from `OPENROUTER_API_KEY` or `~/.gahar/config.json` (written by
  `gahar auth login`). Project config files may not contain secrets; such fields are ignored.
- Sessions, undo snapshots and the update check cache stay under `~/.gahar/` on your machine.
- Prompts, file contents the agent reads and tool results are sent only to the OpenRouter API
  (or the base URL you configure) to produce responses. Their handling is governed by the
  OpenRouter and model provider policies.
- The update check makes one unauthenticated request to the public GitHub releases API. No token
  and no project data are sent.

## What the CLI never uploads

- Your API key to anyone other than the configured API endpoint.
- Files the agent did not read during the session.
- Usage analytics, crash reports or identifiers.

## Release integrity

Each release ships `gahar-code.tgz` with a `gahar-code.tgz.sha256` checksum built by the public
release workflow. `gahar update` refuses to install when the checksum does not match.
