import { defineConfig } from 'tsup';

// `chalk@5` and `ora@8` are ESM-only. To support both `dist/index.cjs` and
// `dist/index.mjs`, inline them via `noExternal` so the CJS bundle can call
// them without a runtime `require()` of an ESM module (which Node refuses).
const noExternal = ['chalk', 'ora', 'log-symbols', 'cli-cursor', 'restore-cursor'];

export default defineConfig([
	// Library entry — imported by tests and (eventually) downstream programmatic use.
	{
		entry: ['src/index.ts'],
		format: ['cjs', 'esm'],
		target: 'node20',
		dts: true,
		sourcemap: true,
		clean: true,
		bundle: true,
		shims: true,
		shebang: false,
		noExternal,
		outExtension({ format }) {
			return { js: format === 'cjs' ? '.cjs' : '.mjs' };
		},
	},
	// CLI entry — receives the executable shebang; tiny shim that re-exports
	// `main` from the library bundle, so `bin.cjs` stays small. The
	// `./index.js` import in src/bin.ts is rewritten per-format to the
	// matching sibling bundle on disk (`./index.cjs` / `./index.mjs`).
	{
		entry: ['src/bin.ts'],
		format: ['cjs', 'esm'],
		target: 'node20',
		dts: false,
		sourcemap: true,
		clean: false,
		bundle: true,
		shims: true,
		shebang: true,
		esbuildPlugins: [
			{
				name: 'rewrite-index-import',
				setup(build) {
					const fmt = build.initialOptions.format;
					const ext = fmt === 'cjs' ? '.cjs' : '.mjs';
					build.onResolve({ filter: /^\.\/index\.js$/ }, () => ({
						path: `./index${ext}`,
						external: true,
					}));
				},
			},
		],
		outExtension({ format }) {
			return { js: format === 'cjs' ? '.cjs' : '.mjs' };
		},
	},
]);
