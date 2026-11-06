import { Buffer32 } from '@aztec-labs/foundation/buffer';

import { Wallet } from 'ethers';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type { Address, Hex } from 'viem';
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { SignerConfig } from '../cli/config.js';

/** A local account ready for later transaction signing, plus the backend that produced it. */
export interface LoadedSigner {
  backend: 'env' | 'keystore' | 'ephemeral';
  address: Address;
  account: PrivateKeyAccount;
}

/** Whether the config points at key material: the private-key env var is set, or a keystore path is given. */
export function hasSignerKey(config: SignerConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return config.backend === 'env'
    ? !!env[config.privateKeyEnvVar]
    : config.keystoreJson !== undefined || config.keystorePath !== undefined;
}

/** A random in-memory key for disabled submission, which simulates as a sender but never signs. */
export function createEphemeralSigner(): LoadedSigner {
  const account = privateKeyToAccount(generatePrivateKey());
  return { backend: 'ephemeral', account, address: account.address };
}

/**
 * Load the configured signer backend.
 *
 * When `disableSubmission` is set and no key is configured, the caller uses `createEphemeralSigner` instead.
 */
export async function loadSigner(config: SignerConfig, env: NodeJS.ProcessEnv = process.env): Promise<LoadedSigner> {
  switch (config.backend) {
    case 'env': {
      const account = loadEnvAccount(config.privateKeyEnvVar, env);
      return {
        backend: 'env',
        account,
        address: account.address,
      };
    }
    case 'keystore': {
      const account = await loadKeystoreAccount(config);
      return { backend: 'keystore', account, address: account.address };
    }
  }
}

function loadEnvAccount(envVar: string, env: NodeJS.ProcessEnv): PrivateKeyAccount {
  const raw = env[envVar];
  if (!raw) {
    throw new Error(`signer env backend requires ${envVar} to be set.`);
  }
  return privateKeyToAccount(normalizePrivateKey(raw, envVar));
}

async function loadKeystoreAccount(config: SignerConfig): Promise<PrivateKeyAccount> {
  if (!config.keystoreJson && !config.keystorePath) {
    throw new Error('keystore signer requires initializer-prepared bytes or --keystore/OXIDE_RELAYER_KEYSTORE.');
  }
  const jsonBytes = config.keystoreJson;
  const passwordBytes = config.keystorePasswordBytes;
  try {
    const json = jsonBytes ? jsonBytes.toString('utf8') : await readFile(config.keystorePath!, 'utf8');
    const password = await loadKeystorePassword(config);
    const wallet = await Wallet.fromEncryptedJson(json, password);
    return privateKeyToAccount(normalizePrivateKey(wallet.privateKey, 'keystore private key'));
  } finally {
    jsonBytes?.fill(0);
    passwordBytes?.fill(0);
  }
}

async function loadKeystorePassword(config: SignerConfig): Promise<string> {
  if (config.keystorePassword !== undefined) {
    return config.keystorePassword;
  }
  if (config.keystorePasswordBytes) {
    const password = config.keystorePasswordBytes.toString('utf8').replace(/\r?\n$/, '');
    if (!password) throw new Error('initializer-prepared keystore password is empty');
    return password;
  }
  if (config.keystorePasswordFile) {
    const passwordFile = await readFile(config.keystorePasswordFile, 'utf8');
    // Remove trailing newline from the password file data
    const password = passwordFile.replace(/\r?\n$/, '');
    return password;
  }
  if (!process.stdin.isTTY) {
    throw new Error('keystore signer requires --keystore-password-file when stdin is not interactive.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('Keystore password: ');
  } finally {
    rl.close();
  }
}

function normalizePrivateKey(value: string, source: string): Hex {
  try {
    return Buffer32.fromString(value.trim()).toString() as Hex;
  } catch {
    throw new Error(`${source} must be a 32-byte hex private key.`);
  }
}
