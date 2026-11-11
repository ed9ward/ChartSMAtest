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
      thresholds: {
        'src/coinbase.js': { statements: 85, functions: 90, lines: 90 },
        'src/feed.js': { statements: 100, functions: 100, lines: 100 },
        'src/indicator-engine.js': { statements: 90, functions: 80, lines: 90 },
        'src/indicators.js': { statements: 95, functions: 100, lines: 95 },
        'src/live.js': { statements: 90, functions: 90, lines: 95 },
        'src/request.js': { statements: 80, functions: 80, lines: 95 },
        'src/sanitize.js': { statements: 95, functions: 100, lines: 95 },
        'src/statistics.js': { statements: 80, functions: 100, lines: 95 },
      },
    },
  },
});
