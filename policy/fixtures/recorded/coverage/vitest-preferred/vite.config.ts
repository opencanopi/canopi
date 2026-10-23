// Recorded source for the coverage adapter: the Vite config vitest skips while a vitest.config.ts stands beside it.
export default {
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 94.8 },
    },
  },
};
