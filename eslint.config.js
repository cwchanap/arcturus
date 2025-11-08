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
		ignores: ['dist/**', '.astro/**', 'node_modules/**', 'drizzle/**/*.sql', '**/*.d.ts'],
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
