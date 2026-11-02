import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // Environment-backed suites have their own Node configs: live testnet gates
    // (vitest.testnet.config.ts) and anvil-backed L1 tests (vitest.anvil.config.ts).
    exclude: ["test/testnet/**", "**/*.anvil.test.ts", "**/node_modules/**", "**/dist/**"],
    // Run tests sequentially to prevent React concurrent rendering issues
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Limit concurrency to 1 to ensure tests run sequentially
    maxConcurrency: 1,
    environmentOptions: {
      jsdom: {
        resources: "usable",
      },
    },
    // Coverage gate. Thresholds pinned to current measured baseline; bump in
    // lockstep with new tests, never lower. Target is 80/80 line+branch.
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "test/",
        "**/*.d.ts",
        "**/*.config.ts",
        "**/*.config.js",
        "src/stories/**",
      ],
      thresholds: {
        lines: 50,
        branches: 75,
      },
    },
    deps: {
      optimizer: {
        web: {
          include: ["buffer"],
        },
      },
    },
  },
  resolve: {
    conditions: ["source"],
    alias: {
      src: path.resolve(__dirname, "./src"),
      buffer: "buffer",
      stream: "stream-browserify",
      crypto: "crypto-browserify",
    },
  },
  optimizeDeps: {
    include: ["buffer", "process"],
  },
})
