import {
  closeRetainedSecretDescriptors,
  initializeRuntimeSandbox,
  runtimeProfileFromArguments,
} from '../exact_operation/runtime_sandbox.js';


async function main(): Promise<void> {
  const originalArgv = process.argv.slice(2);
  const profile = runtimeProfileFromArguments(originalArgv);
  const argv = await initializeRuntimeSandbox(profile, originalArgv);
  if (profile === 'preflight-exact') {
    const [{ createCliProgram }, { preflightExactOperation }] = await Promise.all([
      import('../cli/command.js'),
      import('../exact_operation/preflight.js'),
    ]);
    const rejectGenericRun = () => {
      throw new Error('Generic runtime is unavailable in the exact preflight profile');
    };
    await createCliProgram(rejectGenericRun, undefined, undefined, preflightExactOperation).parseAsync([
      process.execPath,
      'oxide-relayer',
      ...argv,
    ]);
    return;
  }

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
  .catch(error => {
    const detail =
      process.argv[2] === 'preflight-exact' && error instanceof Error ? `: ${error.message}` : '';
    console.error(`oxide-relayer privileged initialization or runtime failed closed${detail}`);
    process.exitCode = 1;
  })
  .finally(() => closeRetainedSecretDescriptors());
