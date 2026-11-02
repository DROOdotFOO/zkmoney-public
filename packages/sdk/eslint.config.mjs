import { migrated } from "@obsidion/lint-config"

export default migrated({ tsconfigRootDir: import.meta.dirname, tests: ["test/**/*.ts"] })
