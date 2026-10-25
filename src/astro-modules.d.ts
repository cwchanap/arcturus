// Plain `tsc` cannot resolve .astro single-file components (astro check can,
// via its language server). This ambient wildcard keeps type-only tsc runs
// (e.g. CI type checks, test files importing pages) working.
declare module '*.astro' {
	const Component: import('astro/runtime/server/render/index.js').AstroComponentFactory;
	export default Component;
}
