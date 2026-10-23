// Recorded source for the coverage adapter: a config whose floor the test:coverage script overrides on the command line.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
