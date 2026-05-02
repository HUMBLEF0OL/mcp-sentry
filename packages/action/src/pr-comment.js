const fs = require('node:fs');

const MARKER = '<!-- mcp-sentry-action -->';

const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };

function rankGrade(g) {
	return GRADE_RANK[g] ?? GRADE_RANK.F;
}

function escapePipes(s) {
	return String(s == null ? '' : s)
		.replace(/\|/g, '\\|')
		.replace(/\r?\n/g, ' ');
}

function buildBody(report, minGrade) {
	// The CLI JSON reporter (TSD §5.2) nests grade fields under `report.grade`:
	//   { grade: { grade: 'D', critical: 1, high: 2, medium: 0, low: 1 }, findings: [...] }
	const g = report?.grade || {};
	const grade = g.grade;
	const counts = {
		critical: g.critical | 0,
		high: g.high | 0,
		medium: g.medium | 0,
		low: g.low | 0,
	};
	const status = rankGrade(grade) > rankGrade(minGrade) ? '❌ failing' : '✅ passing';

	const findings = Array.isArray(report.findings) ? report.findings : [];
	const critical = findings.filter((f) => f.severity === 'critical' && !f.suppressed);

	let body = `${MARKER}\n## mcp-sentry Security Scan\n\n`;
	body += `Status: ${status} (threshold: \`${minGrade}\`)\n\n`;
	body += '| Grade | Critical | High | Medium | Low |\n';
	body += '|-------|----------|------|--------|-----|\n';
	body += `| **${grade}** | ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} |\n\n`;

	if (critical.length > 0) {
		body += '### Critical Findings\n\n';
		body += '| File | Line | Message | Fix |\n';
		body += '|------|------|---------|-----|\n';
		for (const f of critical.slice(0, 25)) {
			const file = escapePipes(f.file ?? '');
			body += `| ${file} | ${f.line ?? ''} | ${escapePipes(f.message)} | ${escapePipes(f.fix)} |\n`;
		}
		if (critical.length > 25) {
			body += `\n_…and ${critical.length - 25} more critical findings._\n`;
		}
		body += '\n';
	}

	if (g.nextGrade) {
		body += `> ${g.nextGrade}\n`;
	}
	return body;
}

async function postPrComment({ github, context, core }) {
	const reportPath = process.env.MCP_SENTRY_REPORT;
	const minGrade = process.env.MCP_SENTRY_MIN_GRADE || 'C';
	if (!reportPath || !fs.existsSync(reportPath)) {
		core.warning(`mcp-sentry: report not found at ${reportPath}; skipping PR comment.`);
		return;
	}
	let report;
	try {
		report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	} catch (err) {
		core.warning(`mcp-sentry: failed to parse report JSON: ${err.message}`);
		return;
	}

	const pr = context.payload.pull_request;
	if (!pr) {
		core.info('mcp-sentry: not a pull_request event; skipping PR comment.');
		return;
	}

	const body = buildBody(report, minGrade);
	const { owner, repo } = context.repo;
	const issue_number = pr.number;

	const existing = await github.paginate(github.rest.issues.listComments, {
		owner,
		repo,
		issue_number,
		per_page: 100,
	});
	const prior = existing.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
	if (prior) {
		await github.rest.issues.updateComment({
			owner,
			repo,
			comment_id: prior.id,
			body,
		});
	} else {
		await github.rest.issues.createComment({
			owner,
			repo,
			issue_number,
			body,
		});
	}
}

module.exports = postPrComment;
module.exports.buildBody = buildBody;
