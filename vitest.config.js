import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['src/**/*.js'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
