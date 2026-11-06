import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { OFAC_SDN_LIST_URL } from '@oxide/watcher-lib/sanctions';

import { describe, expect, it, jest } from '@jest/globals';

import { DEFAULT_LOG_SCAN_WINDOW } from '../l1_operations/l1_operation_relayer.js';
import { createCliProgram } from './command.js';
import { redactRunConfig } from './config.js';
import {
  REQUIRED_ARGS,
  parseExactOperationConfig,
  parseRunConfig,
  runHelpText,
} from './test_run_config.js';

describe('createCliProgram', () => {
  it('rejects the removed prover-claims mode', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--modes', 'prover-claims'], {})).rejects.toThrow(
      /invalid relayer mode/,
    );
  });

  it('keeps exact-operation approval descriptor-only and starts no generic workers', async () => {
    const args = ['--bundle-fd', '3', '--canonical-state', '/canonical', '--control-dir', '/control'];
    const env = {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/v6/prod/releases.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      OXIDE_EXACT_APPROVAL_TOKEN: 'must-not-be-read',
    };
    const config = await parseExactOperationConfig(args, env);

    expect(config).not.toHaveProperty('modes');
    expect(config).not.toHaveProperty('disableSubmission');
    expect(config.canonicalState).toBe('/canonical');
    expect(config.controlDir).toBe('/control');
    expect(config).not.toHaveProperty('journalPath');
    expect(config).not.toHaveProperty('runtimeLeasePath');
    expect(config.bundleFd).toBe(3);
    const stdinConfig = await parseExactOperationConfig(
      ['--bundle-fd', '0', '--canonical-state', '/canonical', '--control-dir', '/control'],
      env,
    );
    expect(stdinConfig.bundleFd).toBe(0);
    await expect(
      parseExactOperationConfig(
        ['--bundle-fd', '1', '--canonical-state', '/canonical', '--control-dir', '/control'],
        env,
      ),
    ).rejects.toThrow(/standard input/);
    await expect(parseExactOperationConfig([], env)).rejects.toThrow(/bundle-fd/);
    await expect(parseExactOperationConfig(['--bundle-fd', '3'], env)).rejects.toThrow(/canonical-state/);
    await expect(
      parseExactOperationConfig([...args, '--journal', '/tmp/bypass.sqlite3'], env),
    ).rejects.toThrow(/unknown option/);
  });
  it('suppresses sensitive exact-operation failure details at the CLI boundary', async () => {
    const sensitive = 'eth_sendRawTransaction: 0xsigned-private-recipient-commitment';
    const environment = jest.replaceProperty(process, 'env', {
      ...process.env,
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/v6/prod/releases.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
    });
    try {
      const program = createCliProgram(
        () => {},
        () => Promise.reject(new Error(sensitive)),
      );
      const error = await program
        .parseAsync(
          ['relay-exact', '--bundle-fd', '3', '--canonical-state', '/canonical', '--control-dir', '/control'],
          { from: 'user' },
        )
        .catch(value => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('relay-exact failed closed; sensitive failure details suppressed');
      expect(String(error)).not.toContain(sensitive);
      expect((error as Error).cause).toBeUndefined();
    } finally {
      environment.restore();
    }
  });


  it('parses public docker one-liner flags', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--signer',
        'keystore',
        '--keystore',
        '/data/relayer.json',
        '--keystore-password-file',
        '/run/secrets/password',
        '--modes',
        'l1-operations,fpc-funding',
      ],
      {},
    );

    expect(config.signer.backend).toBe('keystore');
    expect(config.signer.keystorePath).toBe('/data/relayer.json');
    expect(config.aztecNodeUrl).toBe('https://aztec.example');
    expect(config.modes).toEqual(['l1-operations', 'fpc-funding']);
    expect(config.state.sqlitePath).toBe('/data/oxide-relayer-{portal}.sqlite3');
    expect(config.disableSubmission).toBe(false);
    expect(config.excludePortals).toEqual([]);
    expect(config.l1OperationsSubmission).toBeDefined();
    expect(config.allowUnprofitable).toBe(false);
  });

  it.each([
    '--worker-id',
    '--lease-ttl-ms',
    '--sqlite-path',
    '--predicate-base-url',
    '--predicate-timeout-ms',
    '--l1-operations-max-retries',
  ])('rejects removed option %s', async flag => {
    await expect(parseRunConfig([...REQUIRED_ARGS, flag, '1'], {})).rejects.toThrow(`unknown option '${flag}'`);
  });

  it('starts with the removed max retries env var of an older configuration, and uses the max pending age', async () => {
    const config = await parseRunConfig(REQUIRED_ARGS, { OXIDE_RELAYER_L1_OPERATIONS_MAX_RETRIES: '10' });

    expect(config.l1OperationsSubmission).toEqual(
      expect.objectContaining({ maxPendingAgeMs: 2 * 7 * 24 * 60 * 60_000 }),
    );
    expect(config.l1OperationsSubmission).not.toHaveProperty('maxRetries');
  });

  it('reads the max pending age in seconds', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--l1-operations-max-pending-age-seconds', '3600'], {});

    expect(config.l1OperationsSubmission?.maxPendingAgeMs).toBe(3_600_000);
  });

  it('accepts the SQLite backend and rejects unsupported backends', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--state-backend', 'sqlite'], {});
    expect(config.state.backend).toBe('sqlite');
    await expect(parseRunConfig([...REQUIRED_ARGS, '--state-backend', 'postgres'], {})).rejects.toThrow(
      /invalid state backend/,
    );
  });

  it('hides the state backend option from help', async () => {
    const help = await runHelpText();
    expect(help).toContain('--state <path>');
    expect(help).not.toContain('--state-backend');
  });

  it('does not print secrets from the environment in help', async () => {
    const help = await runHelpText({
      OXIDE_RELAYER_KEYSTORE_PASSWORD: 'keystore-secret',
      OXIDE_RELAYER_PREDICATE_API_KEY: 'predicate-secret',
      AZTEC_NODE_API_KEY: 'aztec-secret',
    });
    expect(help).not.toMatch(/keystore-secret|predicate-secret|aztec-secret/);
    expect(help).toMatch(/--keystore-password <password>[\s\S]*default: <redacted>/);
    expect(help).toMatch(/--predicate-api-key <key>[\s\S]*default: <redacted>/);
  });

  it('shows only the origin of env-set RPC URLs in help', async () => {
    const help = await runHelpText({
      READ_L1_RPC_URL: 'https://eth.example/v2/rpc-secret',
      AZTEC_NODE_URL: 'https://aztec.example/node-secret',
      OXIDE_RELAYER_PROVER_NODE_URL: 'https://prover.example/?key=prover-secret',
    });
    expect(help).not.toMatch(/rpc-secret|node-secret|prover-secret/);
    expect(help).toContain('default: "https://eth.example"');
    expect(help).toContain('default: "https://aztec.example"');
    expect(help).toContain('default: "https://prover.example"');
  });

  it('reads the env signer key from L1_PRIVATE_KEY or the variable that --private-key-env names', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], { L1_PRIVATE_KEY: '0x' + '11'.repeat(32) });
    expect(defaults.signer).toMatchObject({ backend: 'env', privateKeyEnvVar: 'L1_PRIVATE_KEY' }); // gitleaks:allow

    const custom = await parseRunConfig([...REQUIRED_ARGS, '--private-key-env', 'RELAYER_KEY'], {
      RELAYER_KEY: '0x' + '22'.repeat(32),
    });
    expect(custom.signer).toMatchObject({ backend: 'env', privateKeyEnvVar: 'RELAYER_KEY' }); // gitleaks:allow
  });

  it('reads the keystore password from the flag or the environment', async () => {
    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--keystore-password', 'flag-secret'], {});
    expect(fromFlag.signer.keystorePassword).toBe('flag-secret');

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_KEYSTORE_PASSWORD: 'env-secret' });
    expect(fromEnv.signer.keystorePassword).toBe('env-secret');
  });

  it('redacts secrets and RPC URL paths in the loggable config', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--read-l1-rpc',
        'https://eth.example/v2/rpc-secret',
        '--predicate-verification-hash',
        'x-managed-policy-abc',
        '--predicate-chain',
        'ethereum-mainnet',
      ],
      {
        AZTEC_NODE_API_KEY: 'aztec-secret',
        OXIDE_RELAYER_KEYSTORE_PASSWORD: 'keystore-secret',
        OXIDE_RELAYER_PREDICATE_API_KEY: 'predicate-secret',
      },
    );
    const redacted = redactRunConfig(config);
    expect(JSON.stringify(redacted)).not.toMatch(/rpc-secret|aztec-secret|keystore-secret|predicate-secret/);
    expect(redacted.readL1RpcUrl).toBe('https://eth.example');
    expect(redacted.deploymentEnvManifestUrl).toBe('https://manifest.example');
    expect(redacted.sdnUrl).toBe('https://sanctionslistservice.ofac.treas.gov');
    expect(redacted.portal).toBe('0x0000000000000000000000000000000000000001');
    expect(redacted.logScanWindow).toBe(DEFAULT_LOG_SCAN_WINDOW.toString());
  });

  it('uses the state flag before its environment default', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--state', '/data/flag-{portal}.sqlite3'], {
      OXIDE_RELAYER_STATE_PATH: '/data/env-{portal}.sqlite3',
    });
    expect(config.state).toEqual({ backend: 'sqlite', sqlitePath: '/data/flag-{portal}.sqlite3' });
  });

  it('requires --portal or OXIDE_PORTAL', async () => {
    await expect(
      parseRunConfig([], {
        OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.v4.json',
        READ_L1_RPC_URL: 'https://rpc.example',
        AZTEC_NODE_URL: 'https://aztec.example',
        DISABLE_SUBMISSION: '1',
      }),
    ).rejects.toThrow(/--portal or OXIDE_PORTAL/);
  });

  it('falls back to environment config', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
      DISABLE_SUBMISSION: '1',
    });

    expect(config.deploymentEnvManifestUrl).toBe('https://manifest.example/dev.json');
    expect(config.portal.toString()).toBe('0x0000000000000000000000000000000000000001');
    expect(config.readL1RpcUrl).toBe('https://rpc.example');
    expect(config.aztecNodeUrl).toBe('https://aztec.example');
    expect(config.signer.backend).toBe('env');
    expect(config.disableSubmission).toBe(true);
  });

  it('accepts no command-line option for the Aztec node API key, so it cannot reach argv', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--aztec-node-api-key', 'leaked-value'], {})).rejects.toThrow(
      /unknown option '--aztec-node-api-key'/,
    );
  });

  it('reads the Aztec node API key from the environment', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      AZTEC_NODE_API_KEY: 'a-key-value',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBe('a-key-value');
  });

  it('falls back to OXIDE_AZTEC_NODE_API_KEY for the Aztec node API key', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      OXIDE_AZTEC_NODE_API_KEY: 'a-fallback-key',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBe('a-fallback-key');
  });

  it('leaves the Aztec node API key unset when the environment holds none', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.aztecNodeApiKey).toBeUndefined();
  });

  it('reads the L1 RPC from the legacy L1_RPC_URL env var', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      L1_RPC_URL: 'https://legacy-rpc.example',
      AZTEC_NODE_URL: 'https://aztec.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });

    expect(config.readL1RpcUrl).toBe('https://legacy-rpc.example');
  });

  it('parses false boolean env values as false', async () => {
    const config = await parseRunConfig([], {
      OXIDE_DEPLOYMENT_ENV_MANIFEST_URL: 'https://manifest.example/dev.json',
      OXIDE_PORTAL: '0x0000000000000000000000000000000000000001',
      READ_L1_RPC_URL: 'https://rpc.example',
      OXIDE_AZTEC_NODE_URL: 'https://aztec-fallback.example',
      L1_PRIVATE_KEY: '0x' + '11'.repeat(32),
      DISABLE_SUBMISSION: 'false',
    });

    expect(config.aztecNodeUrl).toBe('https://aztec-fallback.example');
    expect(config.disableSubmission).toBe(false);
  });

  it('parses explicit false boolean CLI values as false', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--disable-submission', 'false'], {});

    expect(config.disableSubmission).toBe(false);
  });

  it('parses valueless boolean CLI flags as true', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--disable-submission'], {});

    expect(config.disableSubmission).toBe(true);
  });

  it('parses the exclude list from the flag or the environment, and redacts it as addresses', async () => {
    const a = '0x00000000000000000000000000000000000000aa';
    const b = '0x00000000000000000000000000000000000000bb';
    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--exclude-portals', `${a}, ${b},`], {});
    expect(fromFlag.excludePortals.map(portal => portal.toString())).toEqual([a, b]);
    expect(redactRunConfig(fromFlag).excludePortals).toEqual([a, b]);

    const fromEnv = await parseRunConfig(REQUIRED_ARGS, { OXIDE_RELAYER_EXCLUDE_PORTALS: a });
    expect(fromEnv.excludePortals.map(portal => portal.toString())).toEqual([a]);

    await expect(parseRunConfig([...REQUIRED_ARGS, '--exclude-portals', 'garbage'], {})).rejects.toThrow(
      '--exclude-portals has an invalid address: garbage.',
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--exclude-portals', ','], {})).rejects.toThrow(
      '--exclude-portals must include at least one address.',
    );
  });

  it('rejects disabled submission with epoch proofs', async () => {
    await expect(
      parseRunConfig([...REQUIRED_ARGS, '--disable-submission', '--modes', 'l1-operations,epoch-proofs'], {}),
    ).rejects.toThrow(/epoch-proofs mode cannot run with --disable-submission/);
  });

  it('rejects the removed deposits mode and its flags', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--modes', 'deposits'], {})).rejects.toThrow(
      /invalid relayer mode 'deposits'/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--resolver-scope', 'allowlist'], {})).rejects.toThrow(
      /unknown option '--resolver-scope'/,
    );
    await expect(parseRunConfig([...REQUIRED_ARGS, '--min-profit', '1'], {})).rejects.toThrow(
      /unknown option '--min-profit'/,
    );
  });

  it('rejects unknown options through Commander', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--bogus'], {})).rejects.toThrow(/unknown option '--bogus'/);
  });

  it('rejects the deposit subsidy manager flag', async () => {
    const address = '0x2222222222222222222222222222222222222222';
    await expect(parseRunConfig([...REQUIRED_ARGS, '--deposit-subsidy-manager', address], {})).rejects.toThrow(
      /unknown option '--deposit-subsidy-manager'/,
    );
  });

  it('omits the L1 operation submission policy when the mode is off', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--modes', 'fpc-funding'], {});
    expect(config.l1OperationsSubmission).toBeUndefined();
  });

  it('keeps the L1 operation submission policy when submission is disabled', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--modes', 'l1-operations', '--disable-submission'], {});
    expect(config.l1OperationsSubmission).toBeDefined();
  });

  it('parses the unprofitable opt-in', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS, '--allow-unprofitable'], {});
    expect(config.allowUnprofitable).toBe(true);
  });

  it('leaves sanctions screening off when no Predicate options are set', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(config.predicate).toBeUndefined();
  });

  it('builds the sanctions screening config from Predicate flags', async () => {
    const config = await parseRunConfig(
      [
        ...REQUIRED_ARGS,
        '--predicate-api-key',
        'secret-key',
        '--predicate-verification-hash',
        'x-managed-policy-abc',
        '--predicate-chain',
        'ethereum-mainnet',
      ],
      {},
    );
    expect(config.predicate).toEqual({
      apiKey: 'secret-key',
      verificationHash: 'x-managed-policy-abc',
      chain: 'ethereum-mainnet',
    });
  });

  it('builds the sanctions screening config from Predicate env vars', async () => {
    const config = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_PREDICATE_API_KEY: 'env-key',
      OXIDE_RELAYER_PREDICATE_VERIFICATION_HASH: 'x-managed-policy-env',
      OXIDE_RELAYER_PREDICATE_CHAIN: 'ethereum-sepolia',
    });
    expect(config.predicate).toMatchObject({
      apiKey: 'env-key',
      verificationHash: 'x-managed-policy-env',
      chain: 'ethereum-sepolia',
    });
  });

  it('rejects a partial Predicate config', async () => {
    await expect(
      parseRunConfig([...REQUIRED_ARGS, '--predicate-verification-hash', 'x-managed-policy-abc'], {}),
    ).rejects.toThrow(/predicate-api-key/);
  });

  it('defaults the Flashbots block range and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.flashbotsBlockRange).toBe(5);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--flashbots-block-range', '10'], {});
    expect(fromFlag.flashbotsBlockRange).toBe(10);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_FLASHBOTS_BLOCK_RANGE: '25' });
    expect(fromEnv.flashbotsBlockRange).toBe(25);
  });

  it('rejects a non-positive Flashbots block range', async () => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--flashbots-block-range', '0'], {})).rejects.toThrow(
      /positive integer/,
    );
  });

  it('leaves the L1 max fee per gas unset by default and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.l1MaxFeePerGasGwei).toBeUndefined();

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--l1-max-fee-per-gas-gwei', '80'], {});
    expect(fromFlag.l1MaxFeePerGasGwei).toBe(80);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_L1_MAX_FEE_PER_GAS_GWEI: '12.5' });
    expect(fromEnv.l1MaxFeePerGasGwei).toBe(12.5);

    await expect(parseRunConfig([...REQUIRED_ARGS, '--l1-max-fee-per-gas-gwei', '0'], {})).rejects.toThrow(
      /positive decimal gwei/,
    );
  });

  it('leaves the L1 operation payout tokens unset by default and parses a CLI/env list', async () => {
    const dai = EthAddress.random();
    const sUsds = EthAddress.random();
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.l1OperationsPayoutTokens).toBeUndefined();

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--l1-operations-payout-tokens', `${dai}, ${sUsds},`], {});
    expect(fromFlag.l1OperationsPayoutTokens).toEqual([dai, sUsds]);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS: sUsds.toString(),
    });
    expect(fromEnv.l1OperationsPayoutTokens).toEqual([sUsds]);
  });

  it.each([
    ['an invalid address', 'not-an-address', /invalid address: not-an-address/],
    ['an empty list', ',', /at least one address/],
  ])('rejects L1 operation payout tokens with %s', async (_case, value, error) => {
    await expect(parseRunConfig([...REQUIRED_ARGS, '--l1-operations-payout-tokens', value], {})).rejects.toThrow(error);
  });

  it('defaults the L1 operations poll interval and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.l1OperationsPollIntervalMs).toBe(10_000);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--l1-operations-poll-interval-ms', '60000'], {});
    expect(fromFlag.l1OperationsPollIntervalMs).toBe(60_000);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], {
      OXIDE_RELAYER_L1_OPERATIONS_POLL_INTERVAL_MS: '30000',
    });
    expect(fromEnv.l1OperationsPollIntervalMs).toBe(30_000);
  });

  it('defaults the SDN list URL to the OFAC export and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.sdnUrl).toBe(OFAC_SDN_LIST_URL);

    const fromFlag = await parseRunConfig([...REQUIRED_ARGS, '--sdn-url', 'http://sdn.flag/SDN.XML'], {});
    expect(fromFlag.sdnUrl).toBe('http://sdn.flag/SDN.XML');

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_SDN_URL: 'http://sdn.env/SDN.XML' });
    expect(fromEnv.sdnUrl).toBe('http://sdn.env/SDN.XML');
  });

  it('defaults the log scan window and accepts CLI/env overrides', async () => {
    const defaults = await parseRunConfig([...REQUIRED_ARGS], {});
    expect(defaults.logScanWindow).toBe(DEFAULT_LOG_SCAN_WINDOW);

    const fromEnv = await parseRunConfig([...REQUIRED_ARGS], { OXIDE_RELAYER_LOG_SCAN_WINDOW: '500' });
    expect(fromEnv.logScanWindow).toBe(500n);
  });
});

describe('--version', () => {
  const printVersion = async (version: string | undefined): Promise<string> => {
    const previous = process.env.OXIDE_RELAYER_VERSION;
    if (version === undefined) {
      delete process.env.OXIDE_RELAYER_VERSION;
    } else {
      process.env.OXIDE_RELAYER_VERSION = version;
    }
    try {
      let output = '';
      const program = createCliProgram(() => {})
        .exitOverride()
        .configureOutput({ writeOut: str => (output += str) });
      await expect(program.parseAsync(['--version'], { from: 'user' })).rejects.toThrow();
      return output.trim();
    } finally {
      if (previous === undefined) {
        delete process.env.OXIDE_RELAYER_VERSION;
      } else {
        process.env.OXIDE_RELAYER_VERSION = previous;
      }
    }
  };

  it('prints the release version that the image build sets', async () => {
    expect(await printVersion('1.2.3')).toBe('1.2.3');
  });

  it('prints dev when no release version is set', async () => {
    expect(await printVersion(undefined)).toBe('dev');
  });
});
