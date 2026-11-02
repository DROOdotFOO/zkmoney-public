// @vitest-environment node
/**
 * The commit stamp `vite.config.ts` bakes into the bundle: what each source yields, and what a
 * build with no source at all reports.
 */
import { describe, expect, it, vi } from "vitest"
import { BUILD_COMMIT_UNKNOWN, resolveBuildCommit } from "../../buildCommit"

const SHA = "8f1c0d3a9b2e4d5f60718293a4b5c6d7e8f90123"

/** A git double: `args` joined by a space maps to stdout. */
function git(output: Record<string, string>) {
  return vi.fn((args: string[]) => {
    const key = args.join(" ")
    if (!(key in output)) throw new Error(`git ${key} failed`)
    return output[key]
  })
}

describe("resolveBuildCommit", () => {
  it("takes the CI revision and asks git nothing", () => {
    const run = git({})
    expect(resolveBuildCommit({ VITE_APP_VERSION: SHA }, run)).toBe(SHA)
    expect(run).not.toHaveBeenCalled()
  })

  it("falls back to HEAD for a local build", () => {
    const run = git({ "rev-parse HEAD": `${SHA}\n`, "status --porcelain": "" })
    expect(resolveBuildCommit({}, run)).toBe(SHA)
  })

  it("marks a dirty tree", () => {
    const run = git({ "rev-parse HEAD": `${SHA}\n`, "status --porcelain": " M src/boot.tsx\n" })
    expect(resolveBuildCommit({}, run)).toBe(`${SHA} (dirty)`)
  })

  it("reports the placeholder when neither source answers", () => {
    expect(resolveBuildCommit({}, git({}))).toBe(BUILD_COMMIT_UNKNOWN)
  })

  it("ignores an empty CI revision", () => {
    const run = git({ "rev-parse HEAD": `${SHA}\n`, "status --porcelain": "" })
    expect(resolveBuildCommit({ VITE_APP_VERSION: "" }, run)).toBe(SHA)
  })

  it("keeps the revision when the dirty check fails", () => {
    const run = git({ "rev-parse HEAD": `${SHA}\n` })
    expect(resolveBuildCommit({}, run)).toBe(SHA)
  })
})
