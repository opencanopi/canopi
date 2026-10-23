// Recorded source for the coverage adapter: a config whose coverage the test:coverage script switches off with --coverage=false.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
