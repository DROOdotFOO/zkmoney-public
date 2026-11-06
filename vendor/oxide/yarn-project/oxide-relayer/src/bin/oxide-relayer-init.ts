import { closeSync } from 'node:fs';

import {
  closeRetainedSecretDescriptors,
  initializeRuntimeSandbox,
  installInheritedBundleDescriptor,
  runtimeProfileFromArguments,
} from '../exact_operation/runtime_sandbox.js';


async function main(): Promise<void> {
  const originalArgv = process.argv.slice(2);
  const profile = runtimeProfileFromArguments(originalArgv);
  await initializeRuntimeSandbox(profile);
  const { argv, descriptor } = installInheritedBundleDescriptor(originalArgv);
  try {
    const [{ createCliProgram }, { runRelayer }, { runExactOperation }, { authorizeGenericRestore }] = await Promise.all([
      import('../cli/command.js'),
      import('../main.js'),
      import('../exact_operation/run.js'),
      import('../exact_operation/generic_quarantine.js'),
    ]);
    await createCliProgram(runRelayer, runExactOperation, authorizeGenericRestore).parseAsync([
      process.execPath,
      'oxide-relayer',
      ...argv,
    ]);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

main()
  .catch(() => {
    console.error('oxide-relayer privileged initialization or runtime failed closed');
    process.exitCode = 1;
  })
  .finally(() => closeRetainedSecretDescriptors());
