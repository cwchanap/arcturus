# Code Quality Setup

This project uses modern tooling to maintain code quality and consistency.

## Tools

### ESLint

Modern ESLint flat config with TypeScript and Astro support.

**Configuration:** `eslint.config.js`

**Run linting:**

```bash
bun run lint          # Check for issues
bun run lint:fix      # Auto-fix issues
```

### Prettier

Code formatter for consistent style across the codebase.

**Configuration:** `.prettierrc`

**Run formatting:**

```bash
bun run format        # Format all files
bun run format:check  # Check formatting without changes
```

### Husky

Git hooks for automated quality checks.

**Configuration:** `.husky/`

Automatically runs before each commit:

- ESLint (with auto-fix)
- Prettier (with auto-format)

### lint-staged

Runs linters only on staged files for faster commits.

**Configuration:** `package.json` (lint-staged section)

## Setup

The tools are already configured and will run automatically on `git commit`.

### First Time Setup

After cloning the repo:

```bash
bun install    # Installs dependencies and sets up Husky
```

That's it! Hooks are automatically installed.

## Configuration Details

### ESLint Rules

- **TypeScript recommended** rules
- **Astro recommended** rules
- **Prettier compatibility** (disables conflicting rules)
- Custom rules:
  - Unused vars starting with `_` are allowed
  - `console.warn` and `console.error` are allowed
  - `console.log` triggers a warning
  - Config files can use any console methods

### Prettier Rules

- **Semi-colons:** Yes
- **Quotes:** Single quotes
- **Tab width:** 2 spaces
- **Use tabs:** Yes
- **Trailing commas:** All
- **Print width:** 100 characters
- **Astro support:** Enabled via plugin

### Ignored Files

Both ESLint and Prettier ignore:

- `dist/` - Build output
- `.astro/` - Astro cache
- `node_modules/` - Dependencies
- `drizzle/**/*.sql` - SQL migrations
- `**/*.d.ts` - Type declarations
- Lock files and environment files

## Pre-commit Hook

When you run `git commit`, the following happens automatically:

1. **lint-staged** identifies staged files
2. **ESLint** checks and fixes JS/TS/Astro files
3. **Prettier** formats all staged files
4. If any errors remain, commit is blocked
5. If successful, commit proceeds

## Bypassing Hooks (Not Recommended)

In rare cases where you need to bypass hooks:

```bash
git commit --no-verify -m "your message"
```

**Note:** Only use this when absolutely necessary, as it skips quality checks.

## Manual Quality Check

Before pushing, you can run a full check:

```bash
# Check everything
bun run lint && bun run format:check

# Fix everything
bun run lint:fix && bun run format
```

## Adding Custom Rules

### ESLint

Edit `eslint.config.js`:

```javascript
{
  files: ['**/*.ts'],
  rules: {
    'your-rule': 'error'
  }
}
```

### Prettier

Edit `.prettierrc`:

```json
{
	"your-option": "value"
}
```

### lint-staged

Edit `package.json`:

```json
{
	"lint-staged": {
		"*.extension": ["command1", "command2"]
	}
}
```

## IDE Integration

### VS Code

Install extensions:

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
- [Astro](https://marketplace.visualstudio.com/items?itemName=astro-build.astro-vscode)

Recommended settings (`.vscode/settings.json`):

```json
{
	"editor.formatOnSave": true,
	"editor.defaultFormatter": "esbenp.prettier-vscode",
	"editor.codeActionsOnSave": {
		"source.fixAll.eslint": true
	},
	"[astro]": {
		"editor.defaultFormatter": "esbenp.prettier-vscode"
	}
}
```

## Troubleshooting

### Husky not working after clone

```bash
bun install    # Re-run to set up hooks
```

### ESLint not finding config

Make sure you're using ESLint 9+ which supports flat config by default.

### Prettier conflicts with ESLint

We use `eslint-config-prettier` which is already configured. If you see conflicts, make sure:

1. `eslint-config-prettier` is last in the config array
2. Both tools are up to date

### Pre-commit hook too slow

lint-staged only runs on changed files, but if it's still slow:

1. Check if you have too many files staged
2. Consider staging files in smaller batches
3. Ensure your IDE isn't re-formatting on save (causing conflicts)

## Benefits

✅ **Consistent code style** across the entire team  
✅ **Catch errors early** before they reach production  
✅ **Automated quality checks** - no manual work  
✅ **Better code reviews** - focus on logic, not style  
✅ **Modern tooling** - ESLint flat config, latest Prettier  
✅ **Fast commits** - only checks changed files

## Scripts Reference

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `bun run lint`         | Check for linting errors         |
| `bun run lint:fix`     | Auto-fix linting errors          |
| `bun run format`       | Format all files                 |
| `bun run format:check` | Check formatting without changes |

## Dependencies

### Runtime

None - all tools are dev dependencies.

### Development

- **eslint** - Linting engine
- **@eslint/js** - Base ESLint config
- **typescript-eslint** - TypeScript support
- **eslint-plugin-astro** - Astro support
- **eslint-config-prettier** - Prettier compatibility
- **prettier** - Code formatter
- **prettier-plugin-astro** - Astro formatting
- **husky** - Git hooks
- **lint-staged** - Staged files linting

## Resources

- [ESLint Docs](https://eslint.org/)
- [Prettier Docs](https://prettier.io/)
- [Husky Docs](https://typicode.github.io/husky/)
- [lint-staged Docs](https://github.com/okonet/lint-staged)
- [TypeScript ESLint](https://typescript-eslint.io/)
- [Astro ESLint Plugin](https://github.com/ota-meshi/eslint-plugin-astro)
