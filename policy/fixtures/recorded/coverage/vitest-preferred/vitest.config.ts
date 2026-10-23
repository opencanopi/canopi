// Recorded source for the coverage adapter: the config vitest loads before vite.config.ts beside it, with a lower floor.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 50 },
    },
  },
};
