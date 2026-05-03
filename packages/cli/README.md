# mcp-sentry

[![npm](https://img.shields.io/npm/v/mcp-sentry)](https://www.npmjs.com/package/mcp-sentry)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)

Static-analysis security linter for TypeScript **Model Context Protocol (MCP)** servers. Scans your MCP implementation for all eight **OWASP MCP Top 10** vulnerabilities, grades your project A–F, and integrates seamlessly with CI/CD pipelines.

## What is mcp-sentry?

`mcp-sentry` is a comprehensive security scanner designed specifically for MCP (Model Context Protocol) server implementations. It detects:

- **Token/Secret exposure** in environment, code, and configuration
- **Privilege scope creep** in tool definitions
- **Tool poisoning** and malicious implementations
- **Supply chain risks** in dependencies
- **Command injection** vulnerabilities (intra- and inter-procedural)
- **Intent subversion** (read-only tools that mutate state)
- **Insufficient authentication** and authorization
- **Missing audit logging** on sensitive operations

Each finding is reported with severity, line numbers, and remediation guidance. Projects receive an overall security grade (A–F).

## Installation

### Quick Start

```bash
npx mcp-sentry@latest scan ./path/to/mcp-server
```

### As a dependency

```bash
npm install --save-dev mcp-sentry
# or
pnpm add --save-dev mcp-sentry
# or
yarn add --dev mcp-sentry
```

## Usage

### CLI: Scan a project

```bash
mcp-sentry scan [path] [options]
```

**Examples:**

```bash
# Scan current directory
mcp-sentry scan .

# Scan a specific MCP server
mcp-sentry scan ./my-mcp-server

# Output as JSON
mcp-sentry scan . --format json

# Output as SARIF (for GitHub Code Scanning)
mcp-sentry scan . --format sarif --output report.sarif

# Generate Markdown report
mcp-sentry scan . --format markdown --output security-report.md

# Fail CI if grade is below B
mcp-sentry scan . --fail-on B

# Disable specific checks
mcp-sentry scan . --disable MCP01 MCP02

# Ignore additional file patterns
mcp-sentry scan . --ignore "vendor/**" "dist/**"

# Report results to badge API
mcp-sentry scan . --report
```

### CLI: List all checks

```bash
mcp-sentry checks
```

Outputs all implemented OWASP MCP Top 10 checks with IDs, titles, and descriptions.

### CLI: Show version

```bash
mcp-sentry --version
# or
mcp-sentry -V
```

## Command-line Options

| Option | Alias | Type | Description |
|--------|-------|------|-------------|
| `--format` | `-f` | `text\|json\|sarif\|markdown` | Output format. Default: `text` |
| `--output` | `-o` | `<file>` | Write output to file instead of stdout |
| `--fail-on` | | `A\|B\|C\|D\|F` | Exit with code 1 if grade is at or below threshold |
| `--disable` | | `<id...>` | Skip specific OWASP checks (e.g., `--disable MCP01 MCP02`) |
| `--ignore` | | `<glob...>` | Additional glob patterns to exclude from scan |
| `--report` | | Boolean | POST scan results to the mcp-sentry badge API |
| `--version` | `-V` | Boolean | Print version and exit |
| `--help` | `-h` | Boolean | Show help message |

## Output Formats

### Text (default)

Human-readable report with color-coded severity levels:

```
mcp-sentry scan ./my-server
✓ Scanning ./my-server
  MCP01 [HIGH] Token exposure detected in .env file
    └─ packages/server/src/env.ts:12
  MCP05 [MEDIUM] Potential command injection
    └─ packages/server/src/tools.ts:45
─────────────────────────────────────────
Grade: B | 2 findings | 1 high | 1 medium
```

### JSON

Machine-readable format suitable for programmatic processing:

```bash
mcp-sentry scan . --format json
```

Output structure:

```json
{
  "version": "1.1.0",
  "grade": "B",
  "summary": {
    "total": 2,
    "high": 1,
    "medium": 1,
    "low": 0,
    "info": 0
  },
  "findings": [
    {
      "id": "MCP01",
      "title": "Token / Secret Exposure",
      "severity": "HIGH",
      "file": "packages/server/src/env.ts",
      "line": 12,
      "column": 5,
      "message": "Environment variable containing potential API key",
      "remediation": "Move secrets to a .env file or secrets manager"
    }
  ]
}
```

### SARIF

GitHub Code Scanning compatible format:

```bash
mcp-sentry scan . --format sarif --output report.sarif
```

Upload to GitHub Actions:

```yaml
- name: Scan MCP server
  run: mcp-sentry scan . --format sarif --output report.sarif

- name: Upload SARIF report
  uses: github/codeql-action/upload-sarif@v2
  with:
    sarif_file: report.sarif
```

### Markdown

Formatted report for documentation or pull requests:

```bash
mcp-sentry scan . --format markdown --output SECURITY-REPORT.md
```

## Integration with CI/CD

### GitHub Actions

Use the official GitHub Action:

```yaml
- name: Scan MCP server with mcp-sentry
  uses: HUMBLEF0OL/mcp-sentry@v1
  with:
    path: ./packages/server
    fail-on: B
    format: sarif
    report: true
```

Or use the CLI directly:

```yaml
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - run: npx mcp-sentry@latest scan . --fail-on B
      
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: report.sarif
```

### npm scripts

Add to `package.json`:

```json
{
  "scripts": {
    "security:scan": "mcp-sentry scan . --fail-on C",
    "security:check": "mcp-sentry checks",
    "security:report": "mcp-sentry scan . --format markdown --output SECURITY-REPORT.md"
  }
}
```

Then run:

```bash
npm run security:scan
```

### Pre-commit hook

Use `husky` or similar:

```bash
# .husky/pre-commit
#!/bin/sh
npx mcp-sentry scan . --fail-on D
```

## OWASP MCP Top 10 Checks

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| **MCP01** | Token / Secret Exposure | HIGH | ✅ Active |
| **MCP02** | Privilege Scope Creep | MEDIUM | ✅ Active |
| **MCP03** | Tool Poisoning | HIGH | ✅ Active |
| **MCP04** | Supply Chain Risks | MEDIUM | ✅ Active |
| **MCP05** | Command Injection | HIGH | ✅ Active |
| **MCP06** | Intent Subversion | MEDIUM | ✅ Active |
| **MCP07** | Insufficient Authentication | HIGH | ✅ Active |
| **MCP08** | Missing Audit Logging | MEDIUM | ✅ Active |

## Configuration

### .sentryignore

Create a `.sentryignore` file in your project root to exclude paths from scanning:

```
node_modules/
dist/
build/
.git/
*.test.ts
spec/
```

Patterns follow `.gitignore` syntax.

### Environment Variables

- `MCP_SENTRY_SECRET` — HMAC-SHA256 secret for signing badge API requests (optional)
- `SENTRY_DEBUG` — Set to `1` to enable debug logging

## Badge

Display your MCP security grade in your README:

```markdown
[![mcp-sentry Grade](https://img.shields.io/endpoint?url=https://mcp-sentry.dev/api/badge/owner/repo)](https://mcp-sentry.dev)
```

To update the badge, run:

```bash
mcp-sentry scan . --report
```

**Note:** The badge reflects the most recent reported scan. For enforcement, use `--fail-on` in CI/CD.

## API

`mcp-sentry` is primarily a **CLI tool**. For programmatic automation, use the CLI through npm scripts or GitHub Actions.

### Use via npm scripts

```json
{
  "scripts": {
    "scan": "mcp-sentry scan . --format json > report.json"
  }
}
```

Then parse `report.json` in your tools/scripts.

### Use via child_process (Node.js)

```javascript
const { execSync } = require('child_process');

const report = JSON.parse(
  execSync('mcp-sentry scan . --format json', { encoding: 'utf-8' })
);

console.log(`Security Grade: ${report.grade}`);
```

## Troubleshooting

### "No findings detected" but I know there are issues

- Verify the path is correct: `mcp-sentry scan ./path`
- Check `.sentryignore` isn't excluding relevant files
- Run with debug logging: `SENTRY_DEBUG=1 mcp-sentry scan .`

### SARIF upload fails in GitHub Actions

- Ensure your branch is protected and SARIF upload is enabled
- Check file size: SARIF reports > 20MB may be rejected
- Verify workflow permissions: `contents: read`, `security-events: write`

### Performance: Scan is slow

- Large projects: exclude `node_modules/` and build directories
- Update to the latest version: `npm install --save-dev mcp-sentry@latest`
- Report issues at: https://github.com/HUMBLEF0OL/mcp-sentry/issues

## Performance

Typical scan times:

- Small server (~500 LOC): < 500ms
- Medium server (~5K LOC): < 2s
- Large server (~50K LOC): < 10s

Times are measured on Ubuntu CI runners (GitHub Actions). Local performance varies by hardware.

## Contributing

Contributions welcome! See the [main repository](https://github.com/HUMBLEF0OL/mcp-sentry) for contribution guidelines.

## License

MIT – See [LICENSE](../../LICENSE)

## Resources

- **Documentation**: https://mcp-sentry.dev
- **OWASP MCP Security**: https://owasp.org/www-project-model-context-protocol/
- **Report Issues**: https://github.com/HUMBLEF0OL/mcp-sentry/issues
- **Security Advisories**: https://github.com/HUMBLEF0OL/mcp-sentry/security/advisories

---

Made for securing **Model Context Protocol** servers. Built by the MCP security community.
