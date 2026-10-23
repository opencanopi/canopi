// Recorded source for the coverage adapter: the config vitest loads before vite.config.ts beside it, with a lower floor;
// it switches coverage on itself, as no test:coverage script stands beside it.
export default {
  test: {
    coverage: {
      enabled: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 50 },
    },
  },
};
