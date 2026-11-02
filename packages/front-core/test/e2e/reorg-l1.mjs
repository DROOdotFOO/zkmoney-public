#!/usr/bin/env node
// Forces an L1 reorg on the local-network anvil. Mirrors the pinned @aztec-labs/ethereum
// EthCheatCodes.reorg(): pause interval-mining + automine, anvil_rollback(depth), restore.
// Zero deps on purpose — @aztec/* is not hoisted to the root node_modules.
//
// CLI: node packages/front-core/test/e2e/reorg-l1.mjs <depth> [rpcUrl=http://localhost:8545]
// Importable: reorgL1(rpcUrl, depth, { holdMining }) — holdMining keeps L1 mining paused
// after the rollback (the sequencer cannot re-propose) until the returned resume() runs.

import { pathToFileURL } from "node:url"

export function makeRpc(rpcUrl) {
  let id = 0
  return async (method, params = []) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    })
    const json = await res.json()
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`)
    return json.result
  }
}

export async function reorgL1(rpcUrl, depth, { holdMining = false } = {}) {
  const rpc = makeRpc(rpcUrl)
  const tip = Number(await rpc("eth_blockNumber"))
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`invalid depth ${depth}`)
  if (depth >= tip) throw new Error(`refusing: depth ${depth} >= current L1 tip ${tip}`)

  const [interval, automine] = await Promise.all([
    rpc("anvil_getIntervalMining"),
    rpc("anvil_getAutomine"),
  ])
  let restored = false
  const resume = async () => {
    if (restored) return
    restored = true
    if (automine) await rpc("anvil_setAutomine", [true])
    if (interval) await rpc("anvil_setIntervalMining", [interval])
  }

  if (interval) await rpc("anvil_setIntervalMining", [0])
  if (automine) await rpc("anvil_setAutomine", [false])
  try {
    await rpc("anvil_rollback", [depth])
  } catch (err) {
    await resume()
    throw err
  }
  if (!holdMining) await resume()

  const newTip = Number(await rpc("eth_blockNumber"))
  return { tip, newTip, resume }
}

/**
 * A rollback rewinds account nonces, but a publisher's cached nonce manager keeps counting —
 * its next tx parks in the queued pool behind a nonce gap that replacement can never fill,
 * freezing the rollup. Close the gap so parked txs mine. Call repeatedly after a rollback.
 */
export async function healNonceGaps(rpcUrl) {
  const rpc = makeRpc(rpcUrl)
  const pool = await rpc("txpool_content")
  const healed = []
  const byAddr = {}
  for (const section of [pool?.pending ?? {}, pool?.queued ?? {}]) {
    for (const [addr, txs] of Object.entries(section)) {
      ;(byAddr[addr] ??= []).push(...Object.keys(txs).map(Number))
    }
  }
  for (const [addr, nonces] of Object.entries(byAddr)) {
    const chainNonce = Number(await rpc("eth_getTransactionCount", [addr, "latest"]))
    // Stale sub-chain-nonce txs linger in the pool after a rollback; they can never mine
    // and must not poison the gap computation.
    const viable = nonces.filter((n) => n >= chainNonce)
    if (!viable.length) continue
    const min = Math.min(...viable)
    if (chainNonce < min) await rpc("anvil_setNonce", [addr, "0x" + min.toString(16)])
    // Automine only fires on new submissions; parked txs (gap-healed or already valid)
    // need a block kick to mine.
    healed.push({ addr, from: chainNonce, to: min })
  }
  if (healed.length) await rpc("evm_mine")
  return healed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const depth = Number(process.argv[2])
  const rpcUrl = process.argv[3] ?? "http://localhost:8545"
  if (!Number.isInteger(depth) || depth < 1) {
    console.error("usage: node packages/front-core/test/e2e/reorg-l1.mjs <depth> [rpcUrl]")
    process.exit(1)
  }
  const { tip, newTip } = await reorgL1(rpcUrl, depth)
  console.log(`L1 reorg done: tip ${tip} -> ${newTip} (depth ${depth})`)
}
