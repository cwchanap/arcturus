// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginAstro from 'eslint-plugin-astro';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
	// Base recommended configs
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	...eslintPluginAstro.configs.recommended,
	eslintConfigPrettier,

	// Global ignores
	{
		ignores: [
			'dist/**',
			'.astro/**',
			'.wrangler/**',
			'node_modules/**',
			'drizzle/**/*.sql',
			'**/*.d.ts',
		],
	},

	// TypeScript and JavaScript files
	{
		files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-console': ['warn', { allow: ['warn', 'error'] }],
		},
	},

	// Production locale-formatting guard: ad-hoc `toLocale*` calls and direct
	// `Intl` formatting constructors are rejected outside the shared formatting
	// module and the i18n layer, so presentation stays locale-aware forever.
	{
		files: ['src/**/*.{ts,tsx,astro}'],
		ignores: ['src/lib/formatting.ts', 'src/lib/i18n/**', '**/*.test.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector:
						'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString)$/]',
					message:
						'Use shared locale formatting from src/lib/formatting.ts or src/lib/i18n/ instead of ad-hoc toLocale* calls.',
				},
				{
					selector:
						'NewExpression[callee.type="MemberExpression"][callee.object.name="Intl"][callee.property.name=/^(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)$/]',
					message:
						'Use shared locale formatting from src/lib/formatting.ts or src/lib/i18n/ instead of direct Intl formatting constructors.',
				},
				{
					selector:
						'CallExpression[callee.type="MemberExpression"][callee.object.name="Intl"][callee.property.name=/^(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)$/]',
					message:
						'Use shared locale formatting from src/lib/formatting.ts or src/lib/i18n/ instead of direct Intl formatting calls.',
				},
			],
		},
	},

	// Astro files specific rules
	{
		files: ['**/*.astro'],
		rules: {
			// Astro-specific rules can be added here
		},
	},

	// Config files can use console.log
	{
		files: ['*.config.{js,mjs,ts}'],
		rules: {
			'no-console': 'off',
		},
	},

	// Scripts can use console.log
	{
		files: ['scripts/**/*.ts'],
		rules: {
			'no-console': 'off',
		},
	},

	// Tests - relax some rules; console.log is warned (not errored) to keep CI signal focused
	{
		files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
);
