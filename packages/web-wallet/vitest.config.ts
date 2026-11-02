import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    conditions: ["source"],
    alias: {
      "@obsidion/web-ds": path.resolve(__dirname, "../design-system/src/index.ts"),
      // The boot's build-time profile; as under `vite dev`, a test bakes none.
      "virtual:baked-config-profile": path.resolve(
        __dirname,
        "test/fixtures/bakedConfigProfile.ts",
      ),
    },
  },
})
