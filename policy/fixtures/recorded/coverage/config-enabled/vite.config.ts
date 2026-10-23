// Recorded source for the coverage adapter: a config that switches coverage on itself, under a test:coverage script without --coverage.
export default {
  test: {
    coverage: {
      enabled: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
