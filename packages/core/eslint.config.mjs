import { migrated } from "@obsidion/lint-config"

export default migrated({
  tsconfigRootDir: import.meta.dirname,
  engine: ["src/errors/index.ts"],
  tests: ["test/**/*.mjs"],
})
