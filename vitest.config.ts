import { getViteConfig } from 'astro/config';

export default getViteConfig(
	{
		test: {
			environment: 'node',
			include: ['integration/**/*.test.ts'],
		},
	},
	{
		configFile: false,
		root: new URL('.', import.meta.url),
	},
);
