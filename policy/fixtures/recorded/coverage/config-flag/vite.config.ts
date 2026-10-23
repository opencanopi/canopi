// Recorded source for the coverage adapter: a Vite config the test:coverage script does not load (it names another with --config).
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
