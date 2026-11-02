import { configDefaults, defineConfig } from "vitest/config"

// The canonical sdk test: every test file that has not opted into an environment. Sandbox tests
// carry `.sandbox.test.ts` (`pnpm test:sandbox`, vitest.sandbox.config.ts), live-network checks
// `.live.test.ts` (manual), the shared-stack relayer suites `.relayer.test.ts`
// (vitest.relayer.config.ts), and live-testnet gates live under test/testnet/. Everything else must
// pass with no sandbox and no network; test/setup/noNetwork.ts enforces the second half.
//
// Coverage measured here spans only the sandbox-free tests, so the number understates the sdk's real
// coverage. No threshold is enforced for that reason.
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    globals: true,
    environment: "node",
    reporters: ["verbose"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/*.sandbox.test.ts",
      "**/*.live.test.ts",
      "**/*.relayer.test.ts",
      "test/testnet/**",
      // Quarantined: each fails for a reason unrelated to any environment. Fix or retire, then remove.
    ],
    setupFiles: ["test/setup/noNetwork.ts"],
    hookTimeout: 10_000,
    testTimeout: 10_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    server: { deps: { inline: [/@aztec-labs\/accounts/] } },
    onConsoleLog() {
      return process.env.HIDE_CONSOLE_LOGS !== "true"
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/test.ts"],
    },
  },
})
