import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts', 'src/bin.ts'],
	format: ['cjs', 'esm'],
	target: 'node20',
	dts: { entry: ['src/index.ts'] },
	sourcemap: true,
	clean: true,
	bundle: true,
	shims: true,
	shebang: true,
	outExtension({ format }) {
		return { js: format === 'cjs' ? '.cjs' : '.mjs' };
	},
});
