mcp-sentry  |  Technical Specification Document  |  v1.2

**mcp-sentry**

Technical Specification Document  v1.2

*The security linter for TypeScript MCP servers*

| **Document Title** | mcp-sentry — Technical Specification Document v1.2 |
| --- | --- |
| **TSD Version** | 1.2 (audit-corrected) |
| **BRD Reference** | mcp-sentry BRD v1.4 |
| **Status** | Draft — For Review |
| **Date** | May 2, 2026 |
| **Author** | Solo Developer |
| **Package** | mcp-sentry (npm) |
| **Stack** | Node.js 20 / TypeScript 5.x / Cloudflare Workers / Vercel |

**CONFIDENTIAL — INTERNAL USE ONLY**

# **1. Introduction**

## **1.1 Purpose**

This Technical Specification Document (TSD) translates the requirements defined in the mcp-sentry BRD v1.4 into concrete engineering decisions, module designs, API contracts, data schemas, and implementation guidance. Engineers building mcp-sentry should treat this document as the authoritative source of truth for all technical decisions.

## **1.2 Scope**

This TSD covers:

- The CLI package (packages/cli) — scanner engine, checks, reporter, grader

- The Badge API (workers/badge) — Cloudflare Worker + KV

- The GitHub Action (packages/action)

- The landing page / docs site (apps/web) — configuration only; content is out of scope

- Cross-cutting concerns: monorepo structure, CI/CD, release pipeline, security

## **1.3 Relationship to BRD**

The BRD defines what mcp-sentry must do and why. This TSD defines how it will be built. Where the TSD makes a decision that goes beyond or refines a BRD statement, the TSD is authoritative for engineering. If a conflict exists, it should be raised and the BRD updated.

## **1.4 Definitions ****&**** Abbreviations**

| **Term** | **Definition** |
| --- | --- |
| AST | Abstract Syntax Tree — tree representation of source code structure |
| BRD | Business Requirements Document |
| CLI | Command-Line Interface |
| DXA | Document eXtended Attribute — unit of measure in Word XML (1440 DXA = 1 inch) |
| KV | Key-Value store (Cloudflare KV) |
| MCP | Model Context Protocol — Anthropic open standard for AI agent tool integration |
| OWASP | Open Web Application Security Project |
| SARIF | Static Analysis Results Interchange Format |
| TSD | Technical Specification Document |
| ts-morph | TypeScript Compiler API ergonomic wrapper used for AST traversal |

# **2. System Architecture**

## **2.1 High-Level Overview**

mcp-sentry is a monorepo (pnpm workspaces) consisting of four deployable units:

| **Unit** | **Package Path** | **Runtime** | **Deployment** |
| --- | --- | --- | --- |
| CLI | packages/cli | Node.js 20 LTS | npm registry (npx) |
| Badge API | workers/badge | Cloudflare Workers (V8) | Cloudflare (edge) |
| GitHub Action | packages/action | Node.js (GitHub runner) | GitHub Marketplace |
| Landing/Docs | apps/web | Static HTML (Astro) | Vercel Hobby |

## **2.2 CLI Internal Architecture**

The CLI follows a pipeline pattern: parse CLI args → discover files → run checks in parallel → aggregate findings → score → render output.

| **Module** | **Responsibility** |
| --- | --- |
| index.ts | Commander.js entry point. Registers commands (scan, checks) and version (.version() — flag -V). Bootstraps scanner. |
| scanner.ts | Orchestrator. Discovers TS/JS files, instantiates ts-morph Project, fans out checks, collects CheckResult[]. |
| checks/mcp01-secrets.ts | Regex scan across source files and tool description strings for secrets/tokens. |
| checks/mcp02-scope.ts | AST scan for overly-broad Zod schemas and unbounded fs access patterns. |
| checks/mcp03-poisoning.ts | AST + regex scan for hidden instructions in tool descriptions, name shadowing. |
| checks/mcp04-supply-chain.ts | Reads package.json; spawns npm audit --json; checks lockfile presence and semver pins. |
| checks/mcp05-injection.ts | AST taint-trace from tool input parameters to exec/spawn call arguments. |
| checks/mcp06-intent.ts | STUB — v1.0 placeholder. Throws NotImplementedError. Full intent-subversion detection deferred to v1.1. |
| checks/mcp07-auth.ts | AST scan for HTTP transport handlers missing bearer token / auth middleware. |
| checks/mcp08-logging.ts | AST scan for missing tool invocation log calls and unguarded error propagation. |
| grade.ts | Maps CheckResult[] to severity counts and computes letter grade (A–F). |
| reporter.ts | Renders findings in text / json / sarif / markdown format. Handles --report POST. |

## **2.3 Data Flow**

The following sequence describes a standard npx mcp-sentry scan ./server invocation:

- index.ts parses argv via Commander; constructs ScanOptions.

- scanner.ts calls discoverFiles(path) → string[] of .ts/.js paths.

- scanner.ts initialises a ts-morph Project, adds all discovered source files.

- scanner.ts calls each check module in parallel (Promise.all). Each check returns CheckResult[].

- grade.ts.computeGrade(results) returns { grade, critical, high, medium, low }.

- reporter.ts.render(format, results, grade) writes to stdout, or to the file path specified by --output / -o if provided.

- If --report flag set, reporter.ts POSTs { grade, counts, owner, repo } to Badge API.

- Process exits with code 0 (pass) or 1 (--fail-on threshold breached).

# **3. Module Specifications**

## **3.1 File Discovery (scanner.ts)**

The discoverFiles function must satisfy:

- Accept a path string (file or directory). If file, return [path].

- Recursively traverse directories, returning all .ts and .js files.

- Exclude node_modules, dist, .git, coverage, and *.d.ts files by default.

- Respect an optional .mcp-sentry.ignore file (gitignore syntax) via the ignore npm package.

- Return paths as absolute path strings (path.resolve).

## **3.2 TypeScript Project Initialisation**

ts-morph Project configuration:

- Use skipAddingFilesFromTsConfig: true — we control file selection.

- Use skipFileDependencyResolution: false — resolve imports for type information.

- Set compilerOptions: { allowJs: true, checkJs: false, noEmit: true }.

- Handle projects without a tsconfig.json gracefully (fall back to default compiler options).

- Parse error handling: if ts-morph throws on addSourceFileAtPath() (syntax error, unsupported syntax, encoding issue), catch the error, emit a diagnostic warning { file, error.message } to stderr, skip the file, and continue scanning. A parse failure on one file must never abort the full scan.

- At scan completion, if any files were skipped due to parse errors, include a summary count in all output formats: e.g. 'Warning: 2 files skipped due to parse errors (run with --verbose / -v for details)'.

## **3.3 Core Types**

All shared TypeScript types live in packages/cli/src/types.ts. Check modules import from this file.

### **ScanOptions**

Constructed by index.ts from CLI args and .mcp-sentry.json config. Passed to every check.

| export interface ScanOptions {   path:     string;          // resolved absolute path to scan root   format:   'text'│'json'│'sarif'│'markdown';  // output format   output?:  string;          // file path for --output / -o (stdout if absent)   report:   boolean;         // --report flag: POST grade to badge API   failOn?:  'A'│'B'│'C'│'D'│'F'; // exit 1 if grade below this   disable:  string[];        // OWASP check IDs to skip, e.g. ['MCP08']   ignore:   string[];        // glob patterns to exclude from scanning   owner?:   string;          // GitHub owner for --report (env: GITHUB_REPOSITORY)   repo?:    string;          // GitHub repo name for --report } |
| --- |

### **CheckResult**

Returned by every check module. Severity critical | high drives the grade; medium | low appear in the report but do not affect the headline grade.

| export interface CheckResult {   checkId:    string;        // e.g. 'MCP05-001'   owaspId:    string;        // e.g. 'MCP05'   severity:   'critical' │ 'high' │ 'medium' │ 'low';   file:       string;        // absolute path   line:       number;        // 1-indexed   column:     number;        // 1-indexed   message:    string;        // human-readable description   fix:        string;        // actionable remediation advice   ruleUrl?:   string;        // optional link to docs (optional field)   suppressed: boolean;       // true if mcp-sentry-ignore comment present }  // Every check module exports a CheckFn as its default export export type CheckFn = (   project: Project,          // ts-morph Project (from ts-morph)   files:   SourceFile[],     // discovered source files   opts:    ScanOptions        // CLI flags forwarded ) => Promise<CheckResult[]>; |
| --- |

## **3.4 Check Specifications**

### **MCP01 — Token / Secret Exposure**

Implementation approach: regex scan (no AST required for this check).

- Patterns: 30–40 regexes covering AWS (AKIA…), GCP service account keys, Anthropic API keys (sk-ant-…), OpenAI keys (sk-…), GitHub tokens (ghp_/ghs_/github_pat_…), JWT secrets, generic high-entropy strings (≥32 chars of base64/hex).

- Scan scope: source file text content AND string literals inside tool description fields (via AST to extract description values).

- False positive reduction: skip files matching *.test.ts, *.spec.ts, fixtures/; skip strings matching known placeholder patterns (e.g. YOUR_API_KEY, <API_KEY>, process.env.*).

- Severity: Critical for all matches.

### **MCP02 — Privilege Scope Creep**

Implementation approach: AST traversal via ts-morph.

- Detect z.any() usage in tool input schemas — report as High.

- Detect z.string() or z.number() without .min()/.max()/.regex()/.refine() — report as Medium.

- Detect fs.readdir() or glob patterns covering root-level paths ('/') — report as High.

- Detect tool schemas accepting arbitrary file paths without path validation — report as High.

### **MCP03 — Tool Poisoning**

Implementation approach: AST + regex.

- Scan tool description strings for hidden instruction patterns: 'ignore previous', 'disregard', 'system prompt', 'you are now', ANSI escape codes, zero-width characters (\u200B, \uFEFF, etc.).

- Detect tool names that shadow well-known tools: read_file, write_file, execute_command, bash, computer (case-insensitive).

- Detect dynamic schema modification: tool schemas assigned from external variables rather than literals.

### **MCP04 — Supply Chain**

Implementation approach: file reads + subprocess.

- Read package.json; flag dependencies with ^ or * version ranges as Medium.

- Check for presence of package-lock.json or pnpm-lock.yaml; absence is High.

- Spawn npm audit using child_process.spawn(npmBinary, ['audit', '--json'], { shell: false, timeout: 10000 }) where npmBinary is resolved cross-platform (see §13.1). Never use shell:true or exec(). Parse stdout JSON; report vulnerabilities with severity >= high as High findings.

- Known-malicious package list: maintain a small hardcoded list of confirmed-malicious MCP packages (updated via releases).

### **MCP05 — Command Injection (Priority Check)**

Implementation approach: AST taint analysis.

- Identify tool handler functions (functions registered via server.tool() or similar MCP SDK patterns).

- Track data flow from tool input parameters to calls of: exec, execSync, spawn, spawnSync, execFile, execFileSync (child_process).

- If a tool input variable reaches a shell command argument without an explicit sanitise/escape call, report Critical.

- Separately, detect fs.readFile / fs.writeFile / fs.unlink calls where the path argument derives from tool input without path.resolve() + allowlist check — report as Critical (path traversal).

- Use conservative matching: only flag when the data flow is clear within function scope. Cross-function taint is a v1.1 enhancement.

### **MCP07 — Insufficient Authentication**

Implementation approach: AST pattern matching.

- Detect HTTP transport setup (StreamableHTTPServerTransport or express/fastify app patterns).

- If HTTP transport is present but no bearer token extraction (req.headers.authorization) or auth middleware is found in the same file or imported module, report High.

- Stdio-only servers are exempt from this check.

### **MCP08 — Missing Audit Logging**

Implementation approach: AST structural check.

- For each registered tool handler, check for presence of a logging call (console.log, logger.info, winston, pino, or custom log function containing 'tool' or 'invoke') — absence is Medium.

- Detect catch blocks that rethrow or send raw Error.stack or Error.message to tool responses — report Low.

- Detect absence of a global error handler (process.on('uncaughtException')) in server entry point — report Low.

# **4. Grading Engine (grade.ts)**

## **4.1 Grade Computation Algorithm**

The grade is computed as follows:

- Count findings by severity: critical_count, high_count, medium_count, low_count.

- Apply the grade matrix below.

- Attach a 'Fix X to reach grade Y' suggestion to the grade result.

| **Grade** | **Condition** | **Meaning** | **Badge Hex** |
| --- | --- | --- | --- |
| A | critical=0, high=0 | Production-ready | #4c1 |
| B | critical=0, high 1–2 | Minor risks — fix before wide release | #97CA00 |
| C | critical=0, high 3+ | Moderate risk — not production-ready | #dfb317 |
| D | critical=1 | Serious risk — fix before any deploy | #fe7d37 |
| F | critical≥2 | Do not ship — actively exploitable | #e05d44 |

## **4.2 GradeResult Type**

| export interface GradeResult {   grade:    "A" │ "B" │ "C" │ "D" │ "F";   critical: number;   high:     number;   medium:   number;   low:      number;   total:    number;       // sum of all non-suppressed findings (critical+high+medium+low)   nextGrade?: string;   // e.g. "Fix 1 critical finding to reach grade D"   badgeColor: string;   // hex string for Shields.io } |
| --- |

# **5. Output Formats (reporter.ts)**

## **5.1 Text (Default)**

- Uses chalk for ANSI colours (Windows-safe since chalk v5 — ESM-only).

- Uses ora spinner during scan phase.

- Renders: spinner → finding list (grouped by file, sorted critical→low) → grade summary box.

- Grade box uses box-drawing characters. Grade letter coloured by severity.

- Respect NO_COLOR environment variable (chalk honours this automatically).

## **5.2 JSON**

Machine-readable. Full CheckResult[] plus GradeResult. Schema:

| {   "schemaVersion": "1.0",   "timestamp": "2026-05-02T10:30:00Z",   "scanPath": "/home/user/my-mcp-server",   "grade": { "grade": "D", "critical": 1, "high": 2, "medium": 0, "low": 1 },   "skippedFiles": [],         // files skipped due to parse errors; populated by §3.2 handler   "findings": [     {       "checkId": "MCP05-001",       "owaspId": "MCP05",       "severity": "critical",       "file": "/home/user/my-mcp-server/src/tools.ts",       "line": 42,       "column": 12,       "message": "Tool input flows unsanitised into exec() call",       "fix": "Validate and sanitise input before passing to child_process functions",       "suppressed": false,     // true if mcp-sentry-ignore comment present on this line       "ruleUrl": "https://mcp-sentry.dev/rules/MCP05"     }   ] } |
| --- |

## **5.3 SARIF**

- SARIF 2.1.0 format. Compatible with GitHub Security tab (Advanced Security) and Azure DevOps.

- tool.driver.name = 'mcp-sentry', version from package.json.

- rules[] populated from check registry — one rule per unique checkId.

- results[].locations uses artifactLocation.uri (relative path) + region.startLine/startColumn.

- Severity maps: critical → error, high → error, medium → warning, low → note.

## **5.4 Markdown**

- Suitable for PR comments, wikis, and Notion pages.

- Includes grade badge image (Shields.io URL) at the top.

- Finding table: Severity | File | Line | Message | Fix.

- Ends with OWASP MCP Top 10 coverage table showing which checks ran.

# **6. Badge API (workers/badge)**

## **6.1 Cloudflare Worker Endpoints**

| **Endpoint** | **Description** |
| --- | --- |
| POST /api/report | Receives scan results. Validates payload. Writes to KV. Returns 200 OK. |
| GET  /api/badge/{owner}/{repo} | Reads KV for key owner/repo. Returns Shields.io JSON endpoint response. Cache-Control: max-age=3600. |
| GET  /health | Returns { status: 'ok', version }. Used for uptime monitoring. |

## **6.2 POST /api/report — Request Schema**

| {   "owner":    "string",   // GitHub owner/org (required)   "repo":     "string",   // Repository name (required)   "grade":    "A"│"B"│"C"│"D"│"F",   "critical": number,   "high":     number,   "medium":   number,   "low":      number,   "version":  "string"    // mcp-sentry version that generated this report } |
| --- |

Validation: All fields required. grade must be one of A/B/C/D/F. Counts must be non-negative integers. owner/repo must match regex /^[a-zA-Z0-9_.-]+$/ (max 100 chars each). Reject with 400 if invalid.

## **6.3 GET /api/badge — Response Schema (Shields.io Endpoint Format)**

| {   "schemaVersion": 1,   "label":         "mcp-sentry",   "message":       "A",       // the grade letter   "color":         "4c1",     // hex without #   "namedLogo":     "shield",   "cacheSeconds":  3600 } |
| --- |

## **6.4 Cloudflare KV Schema**

| **Field** | **Detail** |
| --- | --- |
| Key format | {owner}/{repo}   e.g. acme-corp/my-mcp-server |
| Value (JSON) | { grade, critical, high, medium, low, version, updatedAt (ISO8601) } |
| TTL | No TTL — entries persist until overwritten by --report |
| Namespace | MCP_SENTRY_BADGES (configured in wrangler.toml) |

## **6.5 Rate Limiting**

- POST /api/report: 10 writes per owner/repo per hour (implemented via KV timestamp check). Reject with 429 if exceeded.

- GET /api/badge: No rate limit — relying on Cloudflare CDN + Shields.io caching.

ℹ  *Known limitation: the KV timestamp check is subject to a TOCTOU (check-time/use-time) race under concurrent requests. Two simultaneous POST requests may both read a stale timestamp, both pass the rate-limit check, and both write. Cloudflare KV has no compare-and-swap primitive. This is acceptable for v1.0 given low expected write volume. For v1.1+, consider Cloudflare Durable Objects for atomic counters. Tracked in Open Questions §14 item 7.*

## **6.6 Security**

### **Threat model — badge poisoning (known limitation)**

POST /api/report requires no authentication. This is a deliberate v1.0 trade-off: adding auth would require developers to manage tokens, creating friction for the primary solo-dev persona. The consequence is that any actor who knows an owner/repo pair can POST a false grade of 'A' and persist it to KV.

Mitigating factors: (1) the badge is a social signal, not a security gate — CI --fail-on is the enforcement mechanism; (2) the grade can only be set to a valid enum value (A–F); (3) the real grade is always shown in CI output regardless of the badge.

v1.1 mitigation plan: sign the POST payload with HMAC-SHA256 using a repo-specific secret stored in GitHub Secrets. The Worker verifies the signature before writing to KV.

ℹ  *Do not document this API as **'**secure**'** or imply the badge cannot be spoofed. README badge documentation should note that the badge reflects the last scan run with --report.*

- CORS: Access-Control-Allow-Origin: * on GET /api/badge only (required for Shields.io). POST /api/report restricts to no CORS header — browser fetch blocked by default.

- Content-Security-Policy: default-src 'none' on all Worker responses.

- Input validation: strict JSON schema on POST /api/report — reject unknown fields, validate enum values, clamp integer counts to [0, 9999].

- KV keys use only validated owner/repo strings (regex: /^[a-zA-Z0-9_.-]+$/) — no path traversal possible in Cloudflare KV.

- No secrets in Worker source — all configuration via Cloudflare env bindings (wrangler secret).

## **6.7 wrangler.toml — Required Configuration**

The following fields are required for the badge Cloudflare Worker. Variables marked [FILL] must be set before deployment.

| name            = "mcp-sentry-badge" main            = "src/index.ts" compatibility_date = "2026-05-01" compatibility_flags = ["nodejs_compat"]  [[kv_namespaces]] binding  = "MCP_SENTRY_BADGES" id       = "[FILL: KV namespace ID from Cloudflare dashboard]" preview_id = "[FILL: preview KV namespace ID]"  # Route (set when custom domain is registered) # [[routes]] # pattern = "mcp-sentry.dev/api/*" # zone_name = "mcp-sentry.dev"  # Secrets — set via: wrangler secret put BADGE_HMAC_SECRET (v1.1+) # [vars]  — no plaintext secrets; use wrangler secret for sensitive values  [dev] port = 8787 |
| --- |

# **7. GitHub Action (packages/action)**

The GitHub Action lives at packages/action/ in the monorepo. It is published to GitHub Marketplace as a standalone composite action from this path. The .github/actions/ directory in the monorepo root is NOT used for this action — that path was incorrect in a prior draft.

ℹ  *To use the action in workflows: uses: owner/mcp-sentry-action@v1 — the action.yml at packages/action/action.yml must be copied to the root of a dedicated mcp-sentry-action repository for Marketplace publishing. See packages/action/README.md for publishing steps.*

## **7.1 action.yml Inputs**

| **Input** | **Type** | **Default** | **Description** |
| --- | --- | --- | --- |
| path | string | '.' | Path to the MCP server directory to scan |
| min-grade | string | 'C' | Fail the workflow if grade is below this (A/B/C/D/F) |
| report | boolean | false | Push grade to badge API after scan |
| output-format | string | 'json' | Output format (json/sarif/markdown/text) |
| github-token | string | required | GitHub token for PR comments and SARIF upload |
| upload-sarif | boolean | false | Upload SARIF to GitHub Security tab |
| comment-pr | boolean | true | Post grade summary comment on PRs |

## **7.2 Action Steps**

- Set up Node.js 20 (actions/setup-node@v4).

- Run: npx mcp-sentry@latest scan {path} --format json --output scan-results.json.

- Parse scan-results.json in a JS step (actions/github-script).

- If comment-pr=true and event is pull_request: post/update PR comment with Markdown grade table.

- If upload-sarif=true: run npx mcp-sentry scan --format sarif; upload via github/codeql-action/upload-sarif.

- If report=true: run npx mcp-sentry scan --report (extracts owner/repo from GITHUB_REPOSITORY env var).

- Exit with code 1 if grade < min-grade. Grade comparison order: A > B > C > D > F.

## **7.3 PR Comment Format**

The PR comment is posted under the GitHub Actions bot identity using GITHUB_TOKEN. Format:

| ## mcp-sentry Security Scan  │ Grade │ Critical │ High │ Medium │ Low │ │-------│----------│------│--------│-----│ │ D     │ 1        │ 2    │ 0      │ 3   │  **New findings:** 2   │   **Resolved:** 1  ### Critical Findings │ File │ Line │ Message │ Fix │ │------│------│---------│-----│ │ src/tools.ts │ 42 │ Tool input flows into exec() │ Sanitise input... │  > Fix 1 critical finding to reach grade C |
| --- |

# **8. CLI Configuration ****&**** Ignore Mechanism**

## **8.0 CLI Flag Reference**

Complete set of flags supported by the scan command. All flags may also be set via .mcp-sentry.json (see §8.1).

| **Flag** | **Alias** | **Type** | **Description** |
| --- | --- | --- | --- |
| --format | -f | text│json│sarif│markdown | Output format. Default: text |
| --output | -o | string (file path) | Write report to file instead of stdout. E.g. --output report.json |
| --report |  | boolean flag | POST grade + counts to badge API. Requires owner/repo in config or GITHUB_REPOSITORY env var |
| --fail-on |  | 'A'│'B'│'C'│'D'│'F' | Exit 1 if grade is below this threshold. Default: no threshold |
| --disable |  | string (check ID) | Disable one check by OWASP ID. Repeatable: --disable MCP08 --disable MCP04 |
| --ignore |  | string (glob) | Exclude paths matching glob. Repeatable. Merged with .mcp-sentry.json ignore list |
| --version | -V |  | Print mcp-sentry version and exit. Uses capital -V (lowercase -v reserved for future --verbose flag) |

ℹ  *When both --output and --format are set, the file is written in the specified format. The --report flag always POSTs JSON regardless of --format.*

ℹ  *-v (lowercase) is intentionally unassigned in v1.0 and reserved for a future --verbose flag. Use -V (capital) for version.  Commander.js registers --version via .version(), not .command().*

## **8.1 .mcp-sentry.json (Optional Config File)**

If present in the scan root, mcp-sentry reads this file. All fields are optional. Note: the --output / -o flag is CLI-only and cannot be set in this file — output paths are per-invocation, not persistent config.

| {   "ignore": ["src/fixtures/**", "src/test/**"],   // glob patterns to exclude   "disable": ["MCP08"],                           // checks to skip entirely   "failOn": "B",                                  // equivalent to --fail-on flag   "report": {     "owner": "acme",     "repo":  "my-mcp-server"   } } |
| --- |

## **8.2 Inline Suppression Comments**

Developers can suppress a specific finding on a line with a comment:

| const result = exec(userInput); // mcp-sentry-ignore: MCP05 -- reviewed, input validated upstream |
| --- |

- Only suppresses the specified check ID on that exact line.

- Suppressed findings are shown in the report with a [suppressed] tag but do not count toward the grade.

- In SARIF output, suppressed findings have suppressed: [{ kind: 'inSource' }].

# **9. Repository ****&**** Monorepo Structure**

| mcp-sentry/                         ← pnpm workspace root ├── package.json                     ← workspace: ["packages/*","apps/*","workers/*"] ├── pnpm-workspace.yaml ├── pnpm-lock.yaml ├── biome.json                       ← linter / formatter config ├── .github/ │   ├── workflows/ │   │   ├── ci.yml                   ← lint, test, build on PR │   │   └── release.yml              ← publish to npm + deploy badge worker │   └── actions/                    ← (not used for the published Action — see §7) ├── packages/ │   ├── cli/ │   │   ├── package.json             ← name: mcp-sentry, bin: mcp-sentry │   │   ├── tsconfig.json │   │   ├── tsup.config.ts │   │   ├── src/ │   │   │   ├── index.ts │   │   │   ├── scanner.ts │   │   │   ├── grade.ts │   │   │   ├── reporter.ts │   │   │   ├── types.ts             ← shared interfaces (CheckResult, etc.) │   │   │   └── checks/ │   │   │       ├── mcp01-secrets.ts │   │   │       ├── mcp02-scope.ts │   │   │       ├── mcp03-poisoning.ts │   │   │       ├── mcp04-supply-chain.ts │   │   │       ├── mcp05-injection.ts │   │   │       ├── mcp06-intent.ts     ← stub; v1.1 full implementation │   │   │       ├── mcp07-auth.ts │   │   │       └── mcp08-logging.ts │   │   └── fixtures/ │   │       ├── clean-server/        ← should produce grade A │   │       ├── injection-vuln/      ← MCP05 fixture │   │       ├── secrets-exposed/     ← MCP01 fixture │   │       └── full-vulns/          ← all checks fire │   └── action/ │       ├── action.yml │       └── src/ │           └── main.ts ├── apps/ │   └── web/                         ← Astro site (docs + landing) └── workers/     └── badge/         ├── wrangler.toml         └── src/             └── index.ts |
| --- |

# **10. Build ****&**** Release Pipeline**

## **10.1 CLI Build (tsup)**

- Entry: src/index.ts. Outputs: dist/index.cjs (CommonJS), dist/index.mjs (ESM), dist/index.d.ts.

- Target: node20. Bundle: true (inline dependencies except Node built-ins).

- Shebang: #!/usr/bin/env node prepended to dist/index.cjs. This requires explicit configuration in tsup.config.ts — set the shebang option: { entry: ['src/index.ts'], shebang: true } or use banner: { js: '#!/usr/bin/env node' }. It is NOT automatic without this config.

- Bundle size target: <5 MB installed (validate in CI with bundlephobia or du -sh node_modules).

## **10.2 CI Workflow (ci.yml)**

Triggers: pull_request to main, push to main.

- Matrix: ubuntu-latest, windows-latest, macos-latest × Node 20.

- Steps: pnpm install → biome check → vitest run → tsup build → validate bundle size.

- Windows step: ensure path separator tests pass (path.sep normalization tests).

## **10.3 Release Workflow (release.yml)**

Triggers: push of tag v*.*.* to main.

- Run full CI matrix.

- Build CLI: tsup.

- Publish to npm: npm publish --access public.

- Deploy badge Worker: wrangler deploy.

- Deploy Astro site: git push triggers Vercel auto-deploy.

- Create GitHub Release with auto-generated changelog (gh release create).

# **11. Testing Strategy**

## **11.1 Unit Tests (Vitest)**

- Each check module has a corresponding test file: checks/mcp05-injection.test.ts etc.

- Tests use fixture MCP servers in packages/cli/fixtures/.

- Each fixture has an expected findings manifest (fixture-name.expected.json) — CI asserts exact match.

- grade.ts unit tests cover all grade boundary conditions.

## **11.2 False Positive Targets**

| **Phase** | **Target FP Rate** |
| --- | --- |
| MVP (v1.0) | < 15% |
| v1.1 | < 8% |

False positive rate is measured by running the scanner against a corpus of 20 real-world open-source MCP servers and manually reviewing all findings. Any finding that a human reviewer agrees is not a genuine vulnerability counts as a false positive.

The corpus is pinned in packages/cli/fixtures/corpus.txt (committed to the repo). Each line is a GitHub URL in the format owner/repo@commitSHA. The file is updated only on minor or major releases, ensuring FP measurements are repeatable across patch versions. Suggested initial 20 repos should cover: official Anthropic MCP examples, top-10 most-downloaded MCP npm packages, and community MCP servers from the awesome-mcp list.

## **11.3 Scan Performance Tests**

- Benchmark fixture: a synthetic 50-file MCP server.

- Target: scan completes in < 2 seconds on a GitHub Actions runner (ubuntu-latest, 2-core).

- Measured via Vitest bench or simple Date.now() wrapper in CI step.

## **11.4 Integration Tests**

- E2E test A — scan output: npx mcp-sentry scan ./fixtures/injection-vuln --format json exits with code 0 (no --fail-on). JSON output must contain >= 1 finding with owaspId=MCP05 and severity=critical.

- E2E test B — fail gate: npx mcp-sentry scan ./fixtures/injection-vuln --fail-on C exits with code 1, confirming the threshold triggers a non-zero exit when the grade breaches the threshold.

- E2E test C — clean fixture: npx mcp-sentry scan ./fixtures/clean-server exits with code 0, grade=A, zero findings.

- Badge API Worker test: POST /api/report with grade=B, then GET /api/badge/{owner}/{repo} — assert response JSON has message=B and color=97CA00.

- Action smoke test: run the composite GitHub Action against the injection-vuln fixture; assert a PR comment is created and contains grade D or F.

# **12. Non-Functional Specifications**

| **Requirement** | **Target** | **Implementation Note** |
| --- | --- | --- |
| Scan speed | < 2s (5–15 files), < 1s (v1.1) | Parallel Promise.all across checks. ts-morph lazy-loads type info. |
| False positive rate | < 15% MVP, < 8% v1.1 | Conservative pattern matching. Explicit suppression support. |
| Node.js version | 20 LTS minimum | Use native fetch (no node-fetch). ESM-first output from tsup. |
| Cross-platform | Windows / macOS / Linux | path.resolve() everywhere. chalk v5 (Windows ANSI safe). CI matrix. |
| Bundle size | < 5 MB installed | tsup bundle. Avoid heavy deps. chalk + ora + commander + ts-morph. |
| Offline operation | 100% (except --report) | No network calls in scanner. npm audit spawned only for MCP04. |
| License | MIT | LICENSE file at repo root. SPDX identifier in package.json. |
| Accessibility | Respect NO_COLOR env var | chalk v5 honours NO_COLOR automatically. |

# **13. Security Considerations**

## **13.1 CLI Package**

- mcp-sentry itself must not execute scanned code — read-only static analysis only.

- MCP04 spawns npm audit — use child_process.spawn(npmBinary, ['audit', '--json'], { shell: false, timeout: 10000 }). Resolve npmBinary cross-platform: (1) use process.env.npm_execpath if set — this is populated when mcp-sentry is itself invoked via npx/npm scripts and points to the correct platform npm binary; (2) otherwise use the which package (which.sync('npm')) to locate npm on PATH. Do NOT use path.join(path.dirname(process.execPath), 'npm') — on Windows npm is npm.cmd (a batch file), not a bare executable, and this pattern fails. Never use shell: true or exec().

- Do not log or transmit source file contents. --report flag sends only { grade, counts, owner, repo }.

- Validate --report payload size before POST (< 1 KB).

## **13.2 Badge API**

- Input validation on POST /api/report: strict schema check, reject unknown fields.

- KV key constructed from validated owner/repo strings only (no path traversal possible in KV keys).

- No secrets stored in Worker code — Cloudflare env bindings only.

## **13.3 GitHub Action**

- GITHUB_TOKEN permissions: contents: read, pull-requests: write (for PR comments), security-events: write (for SARIF upload only if enabled).

- No third-party actions with write permissions.

# **14. Open Technical Questions**

| **#** | **Question** | **Assumption / Plan** | **Owner** |
| --- | --- | --- | --- |
| 1 | ts-morph performance on 50+ file projects? | Benchmark in Phase 1. Use Project.addSourceFilesAtPaths selectively if slow. | Dev |
| 2 | MCP05 cross-function taint tracking? | v1.0: intra-function only. v1.1: inter-function taint via call graph. | Dev |
| 3 | npm audit --json structure stability? | Pin to npm CLI version in CI. Parse using known schema; log unexpected fields. | Dev |
| 4 | Cloudflare KV 1K writes/day sufficient? | At launch, yes. Add write batching / queue if exceeded post-launch. | Dev |
| 5 | MCP06 intent subversion static detectability? | Research during v1.0 build. Include in v1.0 if pattern is clear. | Dev |
| 6 | Vercel Hobby plan bandwidth for docs site? | 100 GB/month. Adequate for static Astro site at projected traffic. | Dev |
| 7 | KV rate-limit TOCTOU race — Durable Objects for v1.1? | Known limitation in v1.0. Evaluate Cloudflare Durable Objects for atomic counter in v1.1. Low priority until write volume exceeds ~500/day. | Dev |

# **15. Implementation Phases**

| **Phase** | **Duration** | **Deliverables** | **Exit Condition** |
| --- | --- | --- | --- |
| 1 — Foundation | Week 1 | CLI scaffold, Commander setup, file walker, ts-morph integration, MCP05 check, mcp06-intent.ts stub (NotImplementedError placeholder) | npx mcp-sentry . detects exec() injection in fixture; mcp06 stub present and throws NotImplementedError |
| 2 — Core Checks | Week 2 | MCP01, MCP02, MCP03, MCP04 checks. Text output with grade. Vitest fixtures. | MCP01–MCP05 pass fixture suite with <15% FP rate |
| 3 — Completion | Week 3 | MCP07, MCP08. JSON + SARIF + Markdown output. --fail-on. npm publish. | npm package published. npx mcp-sentry works globally. |
| 4 — Ecosystem | Week 4 | Cloudflare Worker badge API. Shields.io. --report. Astro docs. GitHub Action v1. | Full E2E: scan → badge → README → Action PR comment |
| 5+ — v1.1 | Post-launch | Dynamic analysis, Python support, pre-commit hook, VS Code extension, MCP06 | Community demand drives prioritisation |

# **16. Appendix A — Dependency List**

## **16.1 CLI Production Dependencies**

| **Package** | **Version** | **Purpose** | **Weekly Downloads** |
| --- | --- | --- | --- |
| commander | ^13.0.0 | CLI argument parsing | ~500M |
| ts-morph | ^23.0.0 | TypeScript AST traversal | ~2M |
| chalk | ^5.3.0 | Terminal colour output | ~300M |
| ora | ^8.0.0 | CLI spinner | ~50M |
| ignore | ^5.3.0 | .gitignore-style path exclusions | ~200M |
| which | ^4.0.0 | Cross-platform npm binary resolution (MCP04) | ~50M |

## **16.2 CLI Dev Dependencies**

| **Package** | **Purpose** |
| --- | --- |
| vitest | Test runner — native ESM, fast, fixture support |
| tsup | TypeScript bundler — CJS + ESM + .d.ts output |
| biome | Linter + formatter (replaces ESLint + Prettier) |
| typescript | TypeScript compiler (peer dep for ts-morph) |

## **16.3 Badge Worker Dependencies**

| **Package / Service** | **Purpose** |
| --- | --- |
| Cloudflare Workers runtime | Serverless edge execution |
| Cloudflare KV (binding) | Grade result persistence |
| Shields.io | SVG badge rendering from JSON endpoint |
| wrangler (dev dep) | Local dev and deploy CLI |

mcp-sentry TSD v1.2  —  Confidential  —  Page 

	Confidential — Internal Use Only