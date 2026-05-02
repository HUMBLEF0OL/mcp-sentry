#!/usr/bin/env node
/*
 * scripts/measure-fp.ts — measures the mcp-sentry false-positive rate against
 * the corpus pinned in `packages/cli/fixtures/corpus.txt`.
 *
 * Usage:
 *   tsx scripts/measure-fp.ts [--limit N] [--out reports/fp-<date>.json] [--non-interactive]
 *
 * --non-interactive defaults every finding to "true positive" (smoke run).
 * Interactive mode prompts y/n/s per finding.
 *
 * Exits 1 when the resulting fp-rate exceeds 0.15 (15%).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const corpusFile = path.resolve(repoRoot, 'packages/cli/fixtures/corpus.txt');
const cliEntry = path.resolve(repoRoot, 'packages/cli/dist/index.cjs');
const tmpDir = path.resolve(repoRoot, '.tmp/corpus');

interface Args {
    limit?: number;
    out: string;
    nonInteractive: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { out: defaultOut(), nonInteractive: false };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--limit' && argv[i + 1]) {
            a.limit = Number(argv[++i]);
        } else if (v === '--out' && argv[i + 1]) {
            a.out = argv[++i] as string;
        } else if (v === '--non-interactive') {
            a.nonInteractive = true;
        }
    }
    return a;
}

function defaultOut(): string {
    const d = new Date().toISOString().slice(0, 10);
    return path.resolve(repoRoot, `reports/fp-${d}.json`);
}

interface Entry {
    owner: string;
    repo: string;
    sha: string;
}

function loadCorpus(): Entry[] {
    const text = readFileSync(corpusFile, 'utf8');
    const out: Entry[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([\w.-]+)\/([\w.-]+)@([\w.-]+)$/.exec(line);
        if (!m) continue;
        const owner = m[1] as string;
        const repo = m[2] as string;
        const sha = m[3] as string;
        if (sha.startsWith('TODO_')) continue; // skip un-pinned entries
        out.push({ owner, repo, sha });
    }
    return out;
}

function clone(entry: Entry, dest: string): boolean {
    const url = `https://github.com/${entry.owner}/${entry.repo}.git`;
    const r = spawnSync('git', ['clone', '--depth', '50', url, dest], { stdio: 'inherit' });
    if (r.status !== 0) return false;
    const c = spawnSync('git', ['-C', dest, 'checkout', entry.sha], { stdio: 'inherit' });
    return c.status === 0;
}

interface Finding {
    checkId: string;
    owaspId: string;
    severity: string;
    file: string;
    line: number;
    column: number;
    message: string;
    fix: string;
    suppressed?: boolean;
}

function runScan(target: string, outFile: string): Finding[] {
    const r = spawnSync(process.execPath, [cliEntry, 'scan', target, '--format', 'json', '--output', outFile], {
        stdio: 'inherit',
    });
    if (r.status !== 0 && r.status !== 1) return [];
    if (!existsSync(outFile)) return [];
    try {
        const j = JSON.parse(readFileSync(outFile, 'utf8'));
        return Array.isArray(j.findings) ? j.findings : [];
    } catch {
        return [];
    }
}

async function prompt(rl: readline.Interface, q: string): Promise<string> {
    return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

interface PerRepo {
    repo: string;
    total: number;
    truePositive: number;
    falsePositive: number;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(cliEntry)) {
        process.stderr.write('mcp-sentry CLI not built. Run `pnpm --filter mcp-sentry build` first.\n');
        process.exit(2);
    }
    const entries = loadCorpus().slice(0, args.limit);
    if (entries.length === 0) {
        process.stderr.write('measure-fp: no usable corpus entries (all TODO_SHA?). Pin SHAs in corpus.txt.\n');
        process.exit(2);
    }

    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(path.dirname(args.out), { recursive: true });
    const cleanup = () => {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    };
    process.on('SIGINT', () => {
        cleanup();
        process.exit(130);
    });

    const rl = args.nonInteractive
        ? null
        : readline.createInterface({ input: process.stdin, output: process.stdout });

    let total = 0;
    let truePositive = 0;
    let falsePositive = 0;
    const perRepo: PerRepo[] = [];

    for (const entry of entries) {
        const slug = `${entry.owner}__${entry.repo}`;
        const dest = path.join(tmpDir, slug);
        process.stdout.write(`\n=== ${entry.owner}/${entry.repo}@${entry.sha} ===\n`);
        const ok = clone(entry, dest);
        if (!ok) {
            process.stderr.write(`measure-fp: clone failed for ${slug}\n`);
            continue;
        }
        const out = path.join(tmpDir, `${slug}.json`);
        const findings = runScan(dest, out);
        let tp = 0;
        let fp = 0;
        for (const f of findings) {
            total++;
            if (rl) {
                process.stdout.write(`\n${f.severity.toUpperCase()} ${f.checkId} ${f.file}:${f.line}\n  ${f.message}\n`);
                const ans = (await prompt(rl, '[y]es=true positive, [n]o=false positive, [s]kip: ')).trim().toLowerCase();
                if (ans === 'n') {
                    falsePositive++;
                    fp++;
                } else if (ans !== 's') {
                    truePositive++;
                    tp++;
                }
            } else {
                truePositive++;
                tp++;
            }
        }
        perRepo.push({ repo: `${entry.owner}/${entry.repo}`, total: tp + fp, truePositive: tp, falsePositive: fp });
    }
    rl?.close();

    const fpRate = total === 0 ? 0 : falsePositive / total;
    const report = {
        schemaVersion: '1.0',
        timestamp: new Date().toISOString(),
        corpusSize: entries.length,
        total,
        truePositive,
        falsePositive,
        fpRate,
        perRepo,
    };
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    process.stdout.write(`\nmeasure-fp: total=${total} tp=${truePositive} fp=${falsePositive} rate=${(fpRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`measure-fp: report written to ${args.out}\n`);

    cleanup();
    if (fpRate > 0.15) {
        process.stderr.write('measure-fp: FAIL — fp-rate exceeds 15%.\n');
        process.exit(1);
    }
}

void main();
