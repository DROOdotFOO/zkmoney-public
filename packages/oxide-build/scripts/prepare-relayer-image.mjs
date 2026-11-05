import { access, cp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yarnProject = path.join(repository, 'vendor/oxide/yarn-project');
const output = path.join(repository, '.relayer-image');
const runtimeAssets = new Map([
  ['l1-contracts', ['dest']],
  ['noir-contracts.js', ['dest', 'artifacts']],
  ['oxide-client', ['dest']],
  ['oxide-lib', ['dest']],
  ['oxide-lib-tee', ['dest']],
  ['refund-proof', ['dest']],
  ['telemetry', ['dest']],
  ['watcher-lib', ['dest']],
]);

await requireBuildOutput(path.join(yarnProject, 'oxide-relayer/dest/bin/oxide-relayer.js'));
for (const [packageName, assets] of runtimeAssets) {
  for (const asset of assets) {
    await requireBuildOutput(path.join(yarnProject, packageName, asset));
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true, mode: 0o755 });
await run('corepack', [
  'pnpm',
  '--filter',
  '@oxide/oxide-relayer',
  'deploy',
  '--prod',
  output,
]);

for (const [packageName, assets] of runtimeAssets) {
  for (const asset of assets) {
    const deployedAsset = path.join(output, 'node_modules/@oxide', packageName, asset);
    if (!(await exists(deployedAsset))) {
      await cp(path.join(yarnProject, packageName, asset), deployedAsset, {
        recursive: true,
      });
    }
  }
}

await run('node', [path.join(output, 'dest/bin/oxide-relayer.js'), 'relay-exact', '--help']);

async function requireBuildOutput(filename) {
  try {
    await access(filename);
  } catch (cause) {
    throw new Error(`Missing build output ${path.relative(repository, filename)}; run pnpm build:relayer first`, {
      cause,
    });
  }
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}
