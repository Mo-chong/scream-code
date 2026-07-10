import { defineConfig } from 'vitest/config';

const isWin = process.platform === 'win32';

export default defineConfig({
  test: {
    projects: isWin ? ['packages/*'] : ['packages/*', 'apps/scream-code'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
  },
});
