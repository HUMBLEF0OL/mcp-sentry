# mcp-sentry GitHub Action

A composite action that runs [`mcp-sentry`](https://www.npmjs.com/package/mcp-sentry) inside CI, posts a PR comment with the grade summary, optionally uploads SARIF, and optionally pushes the grade to the public badge API.

## Usage

```yaml
name: security
on:
  pull_request:
  push:
    branches: [main]

jobs:
  mcp-sentry:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write   # only required when upload-sarif: true
    steps:
      - uses: actions/checkout@v4
      - uses: owner/mcp-sentry-action@v1
        with:
          path: '.'
          min-grade: 'C'
          upload-sarif: true
          comment-pr: true
          report: false
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input           | Default | Description                                                          |
| --------------- | ------- | -------------------------------------------------------------------- |
| `path`          | `.`     | Path to the MCP server directory to scan.                            |
| `min-grade`     | `C`     | Fail the workflow if the grade is below this letter (A/B/C/D/F).     |
| `report`        | `false` | POST grade to the badge API. Requires `GITHUB_REPOSITORY` env (auto). |
| `output-format` | `json`  | Reserved for future use. The action always writes JSON internally.   |
| `github-token`  | _required_ | Used for PR comments and SARIF upload. Pass `${{ secrets.GITHUB_TOKEN }}`. |
| `upload-sarif`  | `false` | Upload SARIF results to the GitHub Security tab.                     |
| `comment-pr`    | `true`  | Post / update a PR comment with the grade summary.                   |

## Outputs

`grade`, `critical`, `high`, `medium`, `low` — surfaced as step outputs for downstream jobs.

## Token scopes

| Scope                  | Required when |
| ---------------------- | ------------- |
| `contents: read`       | Always.       |
| `pull-requests: write` | `comment-pr: true` and event is `pull_request`. |
| `security-events: write` | `upload-sarif: true`. |

## Marketplace publishing

The action lives at `packages/action/` in the monorepo. To publish to the GitHub Marketplace:

1. Create a dedicated public repo named `mcp-sentry-action` under your org/user.
2. Copy the contents of `packages/action/` (including `action.yml`, `src/`, and this `README.md`) to the **root** of that repo. Composite actions execute `npx mcp-sentry@latest` directly, so no bundling step is required (only JavaScript actions need `@vercel/ncc`).
3. Tag the release: `git tag v1 && git push --tags`.
4. From the GitHub UI, draft a release pointing at `v1` and submit to the Marketplace.
5. Verify the listing renders the inputs from this file's table.
