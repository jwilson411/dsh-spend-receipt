# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for a security report.

Use GitHub's private advisory form:

https://github.com/jwilson411/dsh-spend-receipt/security/advisories/new

Include the version or commit, steps to reproduce, and what an attacker gains.

## Scope

dsh-spend-receipt is a DeepSeek Harness function plugin and a CLI. It turns reported usage into an append-only JSONL cost receipt and reads that receipt back through the `spend_receipt` tool.

The library path does not open a network socket. The CLI and the plugin read and append local files only (`receiptPath`, optional `sessionLog`). Receipt lines record token counts, a dated rate table, a USD amount or `usd: null`, and a source path and line. They do not store API keys, tokens, or request text.

An attacker who already controls the process running the harness, or who can write the receipt or session log this package reads, is out of scope.

## Supported versions

Only the latest release receives security fixes.
