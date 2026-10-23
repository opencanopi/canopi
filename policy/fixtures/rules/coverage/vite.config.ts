// A planted violation of the coverage family (policy/ratchets/coverage.json): vitest's line floor lowered below the
// family's, and a test-only exclusion added. Self-contained so the adapter loads it through Vite like the real one; it
// switches coverage on itself, as no test:coverage script stands beside it.
export default {
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/__tests__/**", "src/generated/**", "src/canvas/**"],
      thresholds: { statements: 92.0, branches: 85.4, functions: 92.9, lines: 90.0 },
    },
  },
};
