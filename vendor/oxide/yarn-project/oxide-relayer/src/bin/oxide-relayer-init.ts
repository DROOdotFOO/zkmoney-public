import {
  closeRetainedSecretDescriptors,
  initializeRuntimeSandbox,
  runtimeProfileFromArguments,
} from '../exact_operation/runtime_sandbox.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const profile = runtimeProfileFromArguments(argv);
  await initializeRuntimeSandbox(profile);

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
}

main()
  .catch(() => {
    console.error('oxide-relayer privileged initialization or runtime failed closed');
    process.exitCode = 1;
  })
  .finally(() => closeRetainedSecretDescriptors());
