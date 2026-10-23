// Recorded source for the coverage adapter: a config that does not switch coverage on, under a test:coverage script without --coverage.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
