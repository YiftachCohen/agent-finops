# Contributing

Thanks for helping improve agent-finops. Before opening an issue or pull
request, read the privacy boundary in [SECURITY.md](SECURITY.md).

## Development

Requirements: Node.js 20 or newer, plus
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the audit scripts.
The project intentionally has no runtime dependencies.

```sh
npm test
npm run audit
npm run release-check
```

Use synthetic fixtures only. Never commit Claude transcripts, prompts, tool
arguments/results, local indexes, absolute workstation paths, customer data,
AWS credentials, or production billing exports.

## Design constraints

- Keep the persistent index metadata-only and private to the current user.
- Do not add outbound network calls, telemetry, subprocess execution, or hidden
  data collection.
- Any new retained field needs a documented reason, an allowlist/validation
  rule, and a regression test proving sensitive content is excluded.
- The dashboard must remain loopback-only and must not grow API endpoints or
  third-party assets.
- Cost output is an estimate. Do not present attribution or local rates as an
  invoice or causal proof.

## Pull requests

Explain the user-visible impact and privacy impact. Add or update tests, run
`npm run release-check`, and keep the change focused. Maintainers may ask for a
synthetic reproduction when a report depends on private log data.
