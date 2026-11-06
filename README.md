# Gahar Code

[![CI](https://github.com/mhanafi09051998/gahar-code/actions/workflows/ci.yml/badge.svg)](https://github.com/mhanafi09051998/gahar-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Gahar Code is an agentic coding CLI for your terminal, powered by [OpenRouter](https://openrouter.ai).
It reads your project, edits files, runs commands and explains what it did, with a permission
prompt before anything risky. Pick any model OpenRouter offers.

[Bahasa Indonesia](README.id.md)

## Install

Requires Node.js 20.3 or newer.

```sh
npm install -g https://github.com/mhanafi09051998/gahar-code/releases/latest/download/gahar-code.tgz
```

Every release on the [Releases page](https://github.com/mhanafi09051998/gahar-code/releases) ships
`gahar-code.tgz` plus `gahar-code.tgz.sha256`. Check the version with `gahar --version`.

## Quick start

```sh
gahar auth login          # store your OpenRouter API key
gahar setup               # choose the key and default model
gahar                     # interactive session in the current directory
gahar -p "summarize this repo"   # one prompt, print the answer, exit
```

Get an API key at <https://openrouter.ai/keys>. You can also export `OPENROUTER_API_KEY`
instead of running `gahar auth login`.

## Keeping it updated

```sh
gahar update --check   # show the installed and latest versions
gahar update           # download, verify and install the latest release
gahar update --force   # reinstall the latest release even if already current
```

`gahar update` downloads `gahar-code.tgz` from the latest GitHub release, verifies it against
`gahar-code.tgz.sha256`, runs `npm install -g --force` on it and confirms the result with
`gahar --version`. If anything fails it prints the manual command shown under Install.

At startup Gahar Code checks the GitHub releases API at most once per 24 hours (3 second timeout)
and prints a single line when a newer version exists. Turn it off with `--no-update-check` or
`GAHAR_NO_UPDATE_CHECK=1`. Watch the repository (Watch > Custom > Releases) to be notified of new
versions on GitHub.

## Permissions and safety

| Mode | Reads | File edits in the project | Shell commands and network | Anything outside the project |
| --- | --- | --- | --- | --- |
| `ask` (default) | allowed | asks | asks | asks |
| `auto-edit` | allowed | allowed | asks | asks |
| `full-auto` | allowed | allowed | allowed | asks |

Choose a mode with `--permission-mode`, `--yolo` (same as `full-auto`), `/permissions` inside a
session, or `GAHAR_PERMISSION_MODE`. Use `full-auto` only in a disposable or version controlled
workspace. `/undo` restores the files changed by the previous turn.

## Command line

```
gahar [options] [prompt]
gahar <command> [args]
```

| Flag | Meaning |
| --- | --- |
| `-p, --print <text>` | run a single prompt non-interactively and exit |
| `-m, --model <id>` | model to use, for example `anthropic/claude-sonnet-4.6` |
| `--permission-mode <mode>` | `ask`, `auto-edit` or `full-auto` (default `ask`) |
| `--yolo` | alias for `--permission-mode full-auto` |
| `--max-tokens <n>` | maximum tokens per model response |
| `--json` | emit JSONL events on stdout, logs on stderr |
| `-c, --continue` | resume the most recent session in this project |
| `-r, --resume <id>` | resume a session by id |
| `--no-update-check` | skip the release update check |
| `--no-color` | disable colored output |
| `--debug` | verbose diagnostics on stderr |
| `-q, --quiet` | suppress the banner and non-essential output |
| `-v, --version` | print the version and exit |
| `-h, --help` | print help and exit |

Value flags also accept `--flag=value`. Use `--` to pass a prompt that starts with a dash.

| Command | Meaning |
| --- | --- |
| `setup` | configure the API key and default model |
| `auth login`, `auth status`, `auth logout` | manage the OpenRouter API key |
| `model list`, `model set <id>`, `model show` | inspect and choose models |
| `sessions list`, `sessions show <id>`, `sessions rm <id>` | manage saved sessions |
| `doctor` | diagnose the installation |
| `update [--check] [--force]` | update to the latest release |
| `help` | print help |

### Slash commands (interactive session)

| Command | Meaning |
| --- | --- |
| `/help` | show the list of commands |
| `/model [id]` | show or set the active model |
| `/auth` | show the API key source and status |
| `/init` | create an `AGENTS.md` stub for this project |
| `/compact` | compact the conversation history |
| `/clear` | clear the screen |
| `/undo` | restore the files changed by the previous turn |
| `/cost` | show tokens and cost for this session |
| `/status` | show session, model and usage |
| `/permissions [ask\|auto-edit\|full-auto]` | show or change the permission mode |
| `/verbose` | toggle reasoning output |
| `/exit`, `/quit` | leave the session |

## Configuration

| Location | Contents |
| --- | --- |
| `~/.gahar/config.json` | global settings and the API key saved by `gahar auth login` |
| `<project>/.gahar/config.json` | per-project settings (never secrets, they are ignored there) |
| `~/.gahar/projects/` | saved sessions per project |
| `~/.gahar/cache/` | update check cache |
| `AGENTS.md` or `GAHAR.md` | project instructions loaded into the system prompt |

| Environment variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | API key, takes precedence over the saved key |
| `GAHAR_MODEL` | default model |
| `GAHAR_BASE_URL` | API base URL (default `https://openrouter.ai/api/v1`) |
| `GAHAR_PERMISSION_MODE` | `ask`, `auto-edit` or `full-auto` |
| `GAHAR_CONFIG_DIR` | config directory instead of `~/.gahar` |
| `GAHAR_NO_UPDATE_CHECK` | `1` disables the startup update check |
| `GAHAR_DEBUG` | `1` enables debug output |
| `GAHAR_JSON` | `1` behaves like `--json` |
| `GAHAR_NO_COLOR`, `NO_COLOR` | disable colors |
| `GAHAR_SHELL` | on Windows, `powershell` uses Windows PowerShell instead of `pwsh` |

See [.env.example](.env.example). Precedence: command line flags, then environment variables,
then the project config, then the global config, then built-in defaults.

## Cost and tokens

OpenRouter reports token usage and cost for every response. `/cost` and `/status` show the
running totals for the session.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401` from OpenRouter | the key is wrong or revoked: `gahar auth login` |
| `402` insufficient credits | add credits at <https://openrouter.ai/settings/credits> |
| `404` model not found | `gahar model list`, then `gahar model set <id>` |
| `429` rate limit | wait a moment or choose another model |
| `gahar` not found after install | open a new terminal; check `npm prefix -g` is on `PATH` |
| `gahar update` fails with EACCES | fix npm global permissions or use a Node version manager, then retry |
| anything else | `gahar doctor`, then `gahar --debug` |

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/cli/` | argument parsing, subcommands, slash commands, headless and JSON output |
| `src/agent/` | the agent loop, system prompt, compaction and usage accounting |
| `src/api/` | OpenRouter client and streaming (SSE) parser |
| `src/tools/` | file, search, shell, web and todo tools exposed to the model |
| `src/security/` | permission gate, path checks and secret redaction |
| `src/session/` | session storage, titles and undo snapshots |
| `src/config/`, `src/auth/` | configuration files and API key handling |
| `src/update/` | release check, verified self-update |
| `src/ui/` | terminal rendering, prompts and approvals |
| `src/contracts/` | shared types between modules |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
