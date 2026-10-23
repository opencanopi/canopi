// Recorded source for the coverage adapter: the config the test:coverage script names with --config; the given vite.config.ts is never loaded.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 50 },
    },
  },
};
