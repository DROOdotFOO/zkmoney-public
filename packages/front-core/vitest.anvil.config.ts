import path from "path"
import { defineConfig } from "vitest/config"

// L1 tests that start their own anvil. Foundry must be installed; the jsdom unit config excludes
// these so the canonical package test stays environment-free.
export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: { src: path.resolve(__dirname, "./src") },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.anvil.test.ts"],
    hookTimeout: 300_000,
    testTimeout: 300_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
