/**
 * Recovery signatures — the EIP-191 signatures a legacy SIPA's `recoverERC20` / `recoverETH`
 * verify: `ECDSA.recover(toEthSignedMessageHash(keccak256(abi.encode(contract, chainId, target[,
 * token], nonce))), sig) == recoveryAddress`. The signer is the derived recovery key; any EOA can
 * submit the signed transaction, and the contract's `usedNonces` mapping makes each nonce
 * single-use.
 *
 * Pure compute — signing only; submission goes through an L1 wallet channel.
 */

import { toBufferBE } from "@aztec-labs/foundation/bigint-buffer"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import type { EthAddress } from "@aztec-labs/foundation/eth-address"
import { secp256k1 } from "@noble/curves/secp256k1"

const ETH_SIGNED_MESSAGE_PREFIX = Buffer.from("\x19Ethereum Signed Message:\n32", "utf8")

function addressWord(address: EthAddress): Buffer {
  return Buffer.concat([Buffer.alloc(12), address.toBuffer()])
}

function assertNonce(nonce: Buffer) {
  if (nonce.length !== 32) {
    throw new Error(`recovery nonce must be 32 bytes, got ${nonce.length}`)
  }
}

/** Inner digest of `recoverERC20`: `keccak256(abi.encode(contract, chainId, target, token, nonce))`. */
export function buildRecoverErc20Digest(args: {
  /** The SIPA or escrow being recovered. */
  contract: EthAddress
  chainId: bigint
  target: EthAddress
  token: EthAddress
  nonce: Buffer
}): Buffer {
  assertNonce(args.nonce)
  return keccak256(
    Buffer.concat([
      addressWord(args.contract),
      toBufferBE(args.chainId, 32),
      addressWord(args.target),
      addressWord(args.token),
      args.nonce,
    ]),
  )
}

/** Inner digest of `recoverETH`: `keccak256(abi.encode(contract, chainId, target, nonce))`. */
export function buildRecoverEthDigest(args: {
  contract: EthAddress
  chainId: bigint
  target: EthAddress
  nonce: Buffer
}): Buffer {
  assertNonce(args.nonce)
  return keccak256(
    Buffer.concat([
      addressWord(args.contract),
      toBufferBE(args.chainId, 32),
      addressWord(args.target),
      args.nonce,
    ]),
  )
}

/**
 * Sign an inner recovery digest with the derived recovery key. Applies the
 * EIP-191 prefix (`toEthSignedMessageHash`) internally so callers can never
 * sign the raw digest by mistake. Returns the 65-byte `r ‖ s ‖ v` layout
 * OpenZeppelin's `ECDSA.recover(bytes)` expects (low-s, v ∈ {27, 28}).
 */
export function signSipaRecovery(innerDigest: Buffer, recoveryPrivateKey: bigint): `0x${string}` {
  if (innerDigest.length !== 32) {
    throw new Error(`recovery digest must be 32 bytes, got ${innerDigest.length}`)
  }
  const prefixed = keccak256(Buffer.concat([ETH_SIGNED_MESSAGE_PREFIX, innerDigest]))
  // Plain Uint8Arrays: noble type-checks its byte inputs, and a polyfilled
  // Buffer (e.g. jsdom) can fail its cross-realm instanceof check.
  const signature = secp256k1.sign(
    Uint8Array.from(prefixed),
    Uint8Array.from(toBufferBE(recoveryPrivateKey, 32)),
    { lowS: true },
  )
  const v = 27 + signature.recovery
  return `0x${signature.toCompactHex()}${v.toString(16).padStart(2, "0")}`
}
