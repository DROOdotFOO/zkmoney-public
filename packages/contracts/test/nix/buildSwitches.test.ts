import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repo = fileURLToPath(new URL("../../../../", import.meta.url))
const buildContracts = join(repo, "packages/contracts/scripts/build_contracts.sh")
const dockerSh = join(repo, "packages/contracts/nix/docker.sh")

// A bare environment, so the runner's CI flags and a developer's NIMBUS_* never reach the scripts.
const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync("bash", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH!, HOME: tmpdir(), ...env },
    timeout: 60_000,
  })

describe("build_contracts.sh", () => {
  let fixture: string
  const spec = () => join(fixture, "spec.json")
  const log = () => join(fixture, "log")
  const artifacts = () => join(fixture, "packages/contracts/src/artifacts")
  const goldenTicket = "packages/contracts/circuits/golden_ticket/target"

  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(join(fixture, path), content)
  }

  // A checkout whose toolchain, VK generator and nix/build.sh are stubs that log their calls; build.sh also records
  // the spec and writes the outputs Nix would for golden_ticket.
  beforeAll(() => {
    // Resolved, as the script's `git rev-parse --show-toplevel` is: macOS's tmpdir() is under a symlink.
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "build-contracts-")))
    run(["-c", "git init -q"], fixture)
    write(
      "package.json",
      JSON.stringify({ scripts: { "update-versions": "x --newVersion v1.2.3" } }),
    )
    write("packages/contracts/scripts/transform-artifact.cjs", "")
    write(
      "packages/contracts/contracts/app/Nargo.toml",
      '[package]\nname = "app"\ntype = "contract"\n',
    )
    write(
      "packages/contracts/circuits/circuit/Nargo.toml",
      '[package]\nname = "circuit"\ntype = "bin"\n',
    )
    write(
      "packages/contracts/circuits/golden_ticket/Nargo.toml",
      '[package]\nname = "golden_ticket"\ntype = "bin"\n',
    )
    write(
      "vendor/oxide/noir-projects/oxide_token_contract/Nargo.toml",
      '[package]\ntype = "contract"\n',
    )
    write(`${goldenTicket}/vk/vk`, "tracked")
    write(
      "packages/sdk/scripts/generate-vk.mjs",
      'import { appendFileSync } from "node:fs"\n' +
        'appendFileSync(process.env.LOG, ["generate-vk", ...process.argv.slice(2)].join(" ") + "\\n")\n' +
        "if (process.env.FAIL_VK) process.exit(1)\n",
    )
    // `aztec compile` writes an artifact; with BLOCK_COPY, codegen puts a file where its copy goes.
    const stubs = {
      "bin/aztec": [
        'echo "aztec $*" >>"$LOG"',
        '[ "$1" != compile ] || { mkdir -p target; echo {} >"target/${PWD##*/}-C.json"; }',
        '[ "$1" != codegen ] || [ -z "$BLOCK_COPY" ] || { mkdir -p "$4/target"; : >"$4/target/${PWD##*/}"; }',
      ].join("\n"),
      "bin/aztec-nargo":
        'echo "aztec-nargo $*" >>"$LOG"; mkdir -p target; echo {} >"target/${PWD##*/}.json"',
      "packages/contracts/nix/build.sh": `printf '%s' "$1" >"$SPEC"; cd ${goldenTicket}; echo {} >golden_ticket.json; echo vk >golden_ticket.vk`,
    }
    for (const [path, body] of Object.entries(stubs)) {
      write(path, `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(join(fixture, path), 0o755)
    }
  })
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  const build = (env: Record<string, string>) => {
    rmSync(spec(), { force: true })
    rmSync(log(), { force: true })
    rmSync(artifacts(), { recursive: true, force: true })
    const result = run([buildContracts], fixture, {
      PATH: `${join(fixture, "bin")}:${process.env.PATH}`,
      LOG: log(),
      SPEC: spec(),
      SKIP_CONTRACTS_DIST_REBUILD: "1",
      ...env,
    })
    const calls = existsSync(log()) ? readFileSync(log(), "utf8").trimEnd().split("\n") : []
    return { ...result, calls }
  }
  const nix = (env: Record<string, string> = {}) => build({ ENABLE_NIX: "1", ...env })
  it.each(["1", "4"])(
    "compiles on the host and derives the VK there without ENABLE_NIX, with CODEGEN_JOBS=%s",
    (jobs) => {
      const result = build({ CODEGEN_JOBS: jobs })
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(spec())).toBe(false)
      expect(result.calls.sort()).toEqual([
        `aztec codegen ./ -o ${artifacts()}`,
        `aztec codegen ./ -o ${artifacts()}`,
        "aztec compile --silence-warnings",
        "aztec compile --silence-warnings --inliner-aggressiveness 0",
        "aztec-nargo compile",
        "aztec-nargo compile",
        `generate-vk --in ./target/golden_ticket.json --out ${fixture}/packages/core/src/constants/index.ts --circuit golden_ticket`,
      ])
      expect(existsSync(join(artifacts(), "target/app/app-C.json"))).toBe(true)
      expect(
        existsSync(join(artifacts(), "target/oxide_token_contract/oxide_token_contract-C.json")),
      ).toBe(true)
      expect(existsSync(join(fixture, "packages/contracts/contracts/app/target"))).toBe(false)
    },
  )

  // Only a background contract's failure prints the replayed-log error.
  it.each([
    ["1", "mkdir"],
    ["4", "ERROR: finishing a contract failed"],
  ])("fails when a contract's copy fails with CODEGEN_JOBS=%s", (jobs, message) => {
    const result = build({ CODEGEN_JOBS: jobs, BLOCK_COPY: "1" })
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).toContain(`${artifacts()}/target/app`)
    expect(output).toContain(message)
  })

  it("prints a background contract's log when a later package fails", () => {
    const result = build({ CODEGEN_JOBS: "4", FAIL_VK: "1" })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("golden_ticket VK generation failed")
    expect(result.stdout).toContain("Running codegen for: packages/contracts/contracts/app")
  })

  it("refuses a CODEGEN_JOBS that is not a positive integer before compiling", () => {
    const result = nix({ CODEGEN_JOBS: "0" })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("CODEGEN_JOBS must be a positive integer")
    expect(existsSync(spec())).toBe(false)
    expect(result.calls).toEqual([])
  })

  it.each(["CI", "GITHUB_ACTIONS"])("refuses ENABLE_NIX=1 when %s is set", (flag) => {
    const result = nix({ [flag]: "true" })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("ENABLE_NIX=1 is for development machines")
    expect(existsSync(spec())).toBe(false)
  })

  it("refuses ENABLE_NIX=1 with a VERSION other than the pinned one", () => {
    const result = nix({ VERSION: "v9.9.9" })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("compiles with the pinned Aztec v1.2.3, not VERSION=v9.9.9")
    expect(existsSync(spec())).toBe(false)
  })

  it("hands Nix every package, with a contract's compile arguments and a pinned circuit's vk flag", () => {
    const result = nix({ VERSION: "1.2.3" })
    expect(result.status, result.stderr).toBe(0)
    const packages = JSON.parse(readFileSync(spec(), "utf8")) as { dir: string }[]
    expect(packages.sort((a, b) => a.dir.localeCompare(b.dir))).toEqual([
      { dir: "packages/contracts/circuits/circuit" },
      { dir: "packages/contracts/circuits/golden_ticket", vk: true },
      { dir: "packages/contracts/contracts/app", args: ["--silence-warnings"] },
      {
        dir: "vendor/oxide/noir-projects/oxide_token_contract",
        args: ["--silence-warnings", "--inliner-aggressiveness", "0"],
      },
    ])
  })

  it("pins Nix's VK without compiling on the host, and removes it, leaving the fixtures", () => {
    const result = nix()
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls.sort()).toEqual([
      `aztec codegen ./ -o ${artifacts()}`,
      `aztec codegen ./ -o ${artifacts()}`,
      `generate-vk --in ./target/golden_ticket.json --out ${fixture}/packages/core/src/constants/index.ts --circuit golden_ticket --vk ./target/golden_ticket.vk`,
    ])
    expect(existsSync(join(artifacts(), "target/golden_ticket/golden_ticket.json"))).toBe(true)
    expect(existsSync(join(fixture, `${goldenTicket}/golden_ticket.vk`))).toBe(false)
    expect(readFileSync(join(fixture, `${goldenTicket}/vk/vk`), "utf8")).toBe("tracked")
  })
})

describe("docker.sh", () => {
  const dockerArgs = (env: Record<string, string> = {}) => {
    const result = run(
      ["-c", '. "$1"; docker() { printf "%s\\n" "$@"; }; nix_container build SPEC', "-", dockerSh],
      repo,
      env,
    )
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trimEnd().split("\n")
  }
  const volume = (args: string[]) => args.find((arg) => arg.endsWith(":/nix"))
  const passed = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []))

  const nimbus = {
    NIMBUS_ENDPOINT: "https://nimbus.example",
    NIMBUS_CACHE: "cache",
    NIMBUS_CACHE_PUBLIC_KEY: "cache:key",
    NIMBUS_AUTH_TOKEN: "secret-token",
  }

  it("runs a sandboxed build privileged, without Nimbus", () => {
    const args = dockerArgs()
    expect(args).toContain("--privileged")
    expect(passed(args)).toEqual(["DISABLE_NIX_SANDBOX", "DISABLE_NIMBUS_PUSH"])
  })

  it("gives an unsandboxed build its own store and no privileges", () => {
    const args = dockerArgs({ DISABLE_NIX_SANDBOX: "1" })
    expect(args).not.toContain("--privileged")
    expect(volume(args)).toBe(volume(dockerArgs())!.replace(/:\/nix$/, "-unsandboxed:/nix"))
  })

  it("passes the Nimbus settings by name only", () => {
    const args = dockerArgs(nimbus)
    expect(passed(args)).toEqual(expect.arrayContaining(Object.keys(nimbus)))
    expect(args.join(" ")).not.toContain("secret-token")
  })

  it("passes no Nimbus settings when NIMBUS_CACHE is empty", () => {
    const args = dockerArgs({ ...nimbus, NIMBUS_CACHE: "" })
    expect(passed(args).filter((name) => name.startsWith("NIMBUS_"))).toEqual([])
  })
})

describe("build.sh", () => {
  let fixture: string
  const at = (path: string) => join(fixture, path)
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const target = "packages/contracts/circuits/circuit/target"

  // A checkout with the real nix scripts and a docker that prints $OUT_TAR as the build's output.
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "nix-build-"))
    run(["-c", "git init -q"], fixture)
    for (const name of ["build.sh", "docker.sh"]) {
      write(
        at(`packages/contracts/nix/${name}`),
        readFileSync(join(repo, "packages/contracts/nix", name), "utf8"),
      )
    }
    write(at("bin/docker"), '#!/bin/sh\ncat "$OUT_TAR"\n')
    chmodSync(at("bin/docker"), 0o755)
  })
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  // Runs build.sh on a build output holding these files, archived the way in-container.sh does.
  const extract = (files: Record<string, string>) => {
    const out = mkdtempSync(join(tmpdir(), "nix-out-"))
    for (const [path, content] of Object.entries(files)) write(join(out, "result", path), content)
    run(["-c", "cd result && find . -type f | tar -cf ../out.tar -T -"], out)
    write(at(`${target}/vk/vk`), "tracked")
    rmSync(at(`${target}/circuit.json`), { force: true })
    const result = run(["packages/contracts/nix/build.sh", "[]"], fixture, {
      PATH: `${at("bin")}:${process.env.PATH}`,
      OUT_TAR: join(out, "out.tar"),
    })
    rmSync(out, { recursive: true, force: true })
    return result
  }

  it("writes the files directly in target/ and leaves its subdirectories alone", () => {
    const result = extract({ [`${target}/circuit.json`]: "{}" })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(at(`${target}/circuit.json`), "utf8")).toBe("{}")
    expect(readFileSync(at(`${target}/vk/vk`), "utf8")).toBe("tracked")
  })

  it("refuses a build with files in a target/ subdirectory", () => {
    const result = extract({ [`${target}/circuit.json`]: "{}", [`${target}/vk/vk`]: "built" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${target}/vk/vk`)
    expect(existsSync(at(`${target}/circuit.json`))).toBe(false)
    expect(readFileSync(at(`${target}/vk/vk`), "utf8")).toBe("tracked")
  })
})
