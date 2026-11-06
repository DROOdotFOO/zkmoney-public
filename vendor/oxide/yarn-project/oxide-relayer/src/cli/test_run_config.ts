import { type Command, CommanderError } from 'commander';

import { createCliProgram } from './command.js';
import type { RunConfig } from './config.js';
import type { RunExactOperationConfig } from '../exact_operation/run.js';

import { RELAYER_ENV_VARS } from './options.js';

/** The flags that every `run` needs, for tests that parse the CLI. */
export const REQUIRED_ARGS = [
  '--deployment-env-manifest',
  'https://manifest.example/prod.json',
  '--portal',
  '0x0000000000000000000000000000000000000001',
  '--read-l1-rpc',
  'https://rpc.example',
  '--aztec-node',
  'https://aztec.example',
];

/** Parse `run` with `args` in an environment that holds only `env`, and return the config the command builds. */
export async function parseRunConfig(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<RunConfig> {
  return await withTestEnv(env, async () => {
    let config: RunConfig | undefined;
    let errorOutput = '';
    const program = createCliProgram(parsed => {
      config = parsed;
    });
    configureCommandForTest(program, str => {
      errorOutput += str;
    });

    try {
      await program.parseAsync(['run', ...args], { from: 'user' });
    } catch (err: unknown) {
      if (err instanceof CommanderError) {
        throw new Error(errorOutput.trim() || err.message);
      }
      throw err;
    }

    if (!config) {
      throw new Error('run action did not produce config');
    }
    return config;
  });
}

export async function parseExactOperationConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<RunExactOperationConfig> {
  return await withTestEnv(env, async () => {
    let config: RunExactOperationConfig | undefined;
    let errorOutput = '';
    const program = createCliProgram(
      () => {},
      parsed => {
        config = parsed;
      },
    );
    configureCommandForTest(program, str => {
      errorOutput += str;
    });
    try {
      await program.parseAsync(['relay-exact', ...args], { from: 'user' });
    } catch (err: unknown) {
      if (err instanceof CommanderError) {
        throw new Error(errorOutput.trim() || err.message);
      }
      throw err;
    }
    if (!config) {
      throw new Error('relay-exact action did not produce config');
    }
    return config;
  });
}

/** Return the `run --help` text in an environment that holds only `env`. */
export async function runHelpText(env: NodeJS.ProcessEnv = {}): Promise<string> {
  return await withTestEnv(env, () => {
    const program = createCliProgram(() => {});
    return Promise.resolve(program.commands.find(command => command.name() === 'run')!.helpInformation());
  });
}

function configureCommandForTest(command: Command, writeErr: (message: string) => void): void {
  command.exitOverride();
  command.configureOutput({
    writeErr,
    writeOut: () => {},
  });

  for (const child of command.commands) {
    configureCommandForTest(child, writeErr);
  }
}

async function withTestEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  const exactEnvVars = [
    'OXIDE_EXACT_APPROVAL_TOKEN',
    'OXIDE_EXACT_SUBMISSION_L1_RPC_URL',
    'OXIDE_RELAYER_PRIVATE_KEY_ENV',
    'OXIDE_RELAYER_KEYSTORE',
    'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
  ];
  for (const name of new Set<string>([...RELAYER_ENV_VARS, ...exactEnvVars, ...Object.keys(env)])) {
    previous.set(name, process.env[name]);
    const value = env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
