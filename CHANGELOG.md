# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-07

### Added

- Interactive terminal session and one-shot mode (`gahar -p`) backed by OpenRouter with streaming responses.
- Tools for the model: read, write, edit and multi-edit files, list directories, glob, grep, run shell commands, fetch URLs, web search and a todo list.
- Permission modes `ask`, `auto-edit` and `full-auto`, with workspace path checks and secret redaction.
- Sessions saved per project with `--continue`, `--resume` and the `sessions` command, plus `/undo` of file changes.
- Commands `setup`, `auth`, `model`, `sessions`, `doctor`, `update` and slash commands such as `/model`, `/cost`, `/compact` and `/permissions`.
- JSONL output with `--json` for scripting.
- Release update check (once per 24 hours) and `gahar update`, which installs the latest GitHub release after verifying its sha256 checksum.
- CI on Linux, Windows and macOS, a tag-driven release workflow, CodeQL and a repository secret scan.

[Unreleased]: https://github.com/mhanafi09051998/gahar-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mhanafi09051998/gahar-code/releases/tag/v0.1.0
