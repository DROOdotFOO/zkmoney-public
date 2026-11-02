import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    globals: true,
    environment: "node",
    include: ["test/testnet/**/*.test.ts"],
    hookTimeout: 9999999,
    testTimeout: 9999999,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
