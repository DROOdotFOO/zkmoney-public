import { defineConfig } from "vitest/config"

// The deposit sync benchmark: a local JSON-RPC L1 and a fake L2 with a fixed latency. Not a test;
// the canonical suite never collects bench/.
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    globals: true,
    environment: "node",
    include: ["bench/**/*.bench.ts"],
    testTimeout: 3_600_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
