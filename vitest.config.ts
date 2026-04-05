import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'mcp-services/src/**/*.test.ts'],
  },
});
