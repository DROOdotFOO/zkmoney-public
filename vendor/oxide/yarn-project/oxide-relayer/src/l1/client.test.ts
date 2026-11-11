/**
 * The relayer's L1 client against two fake JSON-RPC endpoints: which methods reach the submission relay, and
 * which reach the normal read RPC.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { l1Transport } from './client.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const RAW_TX = `0x${'ab'.repeat(64)}` as const;
const TX_HASH = `0x${'cd'.repeat(32)}`;

/** Records the JSON-RPC methods it is asked for and answers each with a canned result, or with `error` when set. */
class FakeRpc {
  readonly methods: string[] = [];
  url = '';
  error: { code: number; message: string } | undefined;
  /** Answers the next requests with a retryable internal error before any canned result. */
  transientFailures = 0;
  disconnect = false;

  private readonly server = http.createServer((req, res) => void this.handle(req, res));

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const { id, method } = JSON.parse(Buffer.concat(chunks).toString());
    this.methods.push(method);
    if (this.disconnect) {
      req.socket.destroy();
      return;
    }
    const result = method === 'eth_sendRawTransaction' ? TX_HASH : '0x7a69';
    res.writeHead(200, { 'content-type': 'application/json' });
    const transient = this.transientFailures > 0;
    if (transient) this.transientFailures--;
    const error = transient ? { code: -32603, message: 'internal error' } : this.error;
    res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }));
  }
}

describe('l1Transport', () => {
  const endpoints: FakeRpc[] = [];

  const startRpc = async (): Promise<FakeRpc> => {
    const rpc = await new FakeRpc().start();
    endpoints.push(rpc);
    return rpc;
  };

  afterEach(async () => {
    await Promise.all(endpoints.splice(0).map(rpc => rpc.stop()));
  });

  it('sends raw transactions to the submission RPC and everything else to the read RPC', async () => {
    const read = await startRpc();
    const submission = await startRpc();
    const client = createPublicClient({ chain: foundry, transport: l1Transport(read.url, submission.url) });

    await client.getChainId();
    await client.getTransactionCount({ address: ACCOUNT.address, blockTag: 'pending' });
    await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).resolves.toBe(TX_HASH);

    expect(submission.methods).toEqual(['eth_sendRawTransaction']);
    expect(read.methods).toEqual(['eth_chainId', 'eth_getTransactionCount']);
  });

  it('keeps every method on the one RPC when no submission RPC is configured', async () => {
    const read = await startRpc();
    const client = createPublicClient({ chain: foundry, transport: l1Transport(read.url) });

    await client.getChainId();
    await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).resolves.toBe(TX_HASH);

    expect(read.methods).toEqual(['eth_chainId', 'eth_sendRawTransaction']);
  });

  it('retries a transient read failure but sends a raw transaction once', async () => {
    const read = await startRpc();
    const client = createPublicClient({ chain: foundry, transport: l1Transport(read.url) });

    read.transientFailures = 1;
    await expect(client.getChainId()).resolves.toBe(31337);
    expect(read.methods).toEqual(['eth_chainId', 'eth_chainId']);

    read.transientFailures = 1;
    await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).rejects.toThrow();
    expect(read.methods.filter(method => method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('keeps the RPC URL, which can hold a provider API key, out of the message of a failed request', async () => {
    const rpc = await startRpc();
    // viem does not retry this error, and without the transport wrapper its message holds the URL.
    rpc.error = { code: -32601, message: 'the method does not exist' };
    const url = `${rpc.url}v2/secret-api-key`;
    const clients = [
      createPublicClient({ chain: foundry, transport: l1Transport(url) }),
      createPublicClient({ chain: foundry, transport: l1Transport(url, (await startRpc()).url) }),
    ];

    for (const client of clients) {
      const error = await client.getChainId().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('secret-api-key');
      // The failure from viem stays in the cause chain for debugging, without the key.
      expect(String((error as Error).cause)).toContain('the method does not exist');
      expect(String((error as Error).cause)).not.toContain('secret-api-key');
      expect(((error as Error).cause as Error).stack).not.toContain('secret-api-key');
    }
  });

  it.each(['rpc', 'retryable-rpc', 'network'])(
    'does not retry or send through the public RPC after a private %s failure',
    async failure => {
      const read = await startRpc();
      const submission = await startRpc();
      submission.error =
        failure === 'rpc'
          ? { code: -32000, message: 'rejected' }
          : failure === 'retryable-rpc'
            ? { code: -32603, message: 'internal error' }
            : undefined;
      submission.disconnect = failure === 'network';
      const client = createPublicClient({ chain: foundry, transport: l1Transport(read.url, submission.url) });

      await expect(client.sendRawTransaction({ serializedTransaction: RAW_TX })).rejects.toThrow();

      expect(read.methods).toEqual([]);
      expect(submission.methods).toEqual(['eth_sendRawTransaction']);
    },
  );

  it('does not send failed reads to Protect', async () => {
    const read = await startRpc();
    const submission = await startRpc();
    read.error = { code: -32601, message: 'the method does not exist' };
    const client = createPublicClient({ chain: foundry, transport: l1Transport(read.url, submission.url) });

    await expect(client.getChainId()).rejects.toThrow();

    expect(read.methods).toEqual(['eth_chainId']);
    expect(submission.methods).toEqual([]);
  });
});
