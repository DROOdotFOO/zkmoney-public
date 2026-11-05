import type { AztecNode } from '@aztec-labs/aztec.js/node';

import { redactedHttp } from '@oxide/oxide-lib/redacted_http.js';

import { type Chain, type PublicClient, type Transport, createPublicClient, defineChain, fallback } from 'viem';
import { foundry, mainnet, sepolia } from 'viem/chains';

/** Chains with a viem definition. A different chain id gets a minimal definition. */
const KNOWN_CHAINS: readonly Chain[] = [mainnet, sepolia, foundry];

/** The viem chain for `chainId`. */
export function chainFor(chainId: number | bigint): Chain {
  const id = Number(chainId);
  return (
    KNOWN_CHAINS.find(chain => chain.id === id) ??
    defineChain({
      id,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [] } },
    })
  );
}

/** Routes private submissions separately and keeps RPC URLs out of error messages. */
export function l1Transport(readUrl: string, submissionUrl?: string): Transport {
  const transport: Transport = submissionUrl
    ? fallback([
        redactedHttp(submissionUrl, { methods: { include: ['eth_sendRawTransaction'] } }),
        redactedHttp(readUrl, { methods: { exclude: ['eth_sendRawTransaction'] } }),
      ])
    : redactedHttp(readUrl);
  return params => {
    const inner = transport(params);
    const request: typeof inner.request = async (args, options) => {
      try {
        return await inner.request(args, options);
      } catch (cause) {
        throw new Error('L1 RPC request failed', { cause });
      }
    };
    return { ...inner, request };
  };
}

/**
 * Read-only L1 client; L1 chain id from the aztec node must match `readL1RpcUrl` chain id. Also returns the rollup
 * version the node follows, from the same node info call.
 */
export async function getL1PublicClient(
  readL1RpcUrl: string,
  node: AztecNode,
): Promise<{ publicClient: PublicClient<Transport, Chain>; chainId: bigint; rollupVersion: bigint }> {
  const info = await node.getNodeInfo();
  const expectedChainId = info.l1ChainId;
  const publicClient = createPublicClient({ chain: chainFor(expectedChainId), transport: l1Transport(readL1RpcUrl) });
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== expectedChainId) {
    // The hostname only: the read RPC URL can contain a provider API key.
    throw new Error(
      `L1 RPC at ${new URL(readL1RpcUrl).hostname} reports chain id ${rpcChainId}, but Aztec node reports ` +
        `l1ChainId ${expectedChainId}`,
    );
  }
  return { publicClient, chainId: BigInt(expectedChainId), rollupVersion: BigInt(info.rollupVersion) };
}
