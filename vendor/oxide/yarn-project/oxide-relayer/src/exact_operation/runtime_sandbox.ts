import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  EXACT_AZTEC_NODE_URL_PATH,
  EXACT_CANONICAL_DIRECTORY,
  EXACT_CONTROL_DIRECTORY,
  EXACT_RUNTIME_CONFIG_DIRECTORY,
  EXACT_RUNTIME_IDENTITY_PATH,
  EXACT_SECRET_DIRECTORY,
  EXACT_SIGNER_KEYSTORE_PATH,
  EXACT_SIGNER_PASSWORD_PATH,
  EXACT_STATE_INVENTORY_PATH,
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_CONFIG_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
  GENERIC_DATA_DIRECTORY,
} from './paths.js';
import { preparePrivilegedRuntimeIdentity } from './runtime_identity.js';

export type RuntimeProfile = 'exact' | 'restore' | 'generic-restore';

interface MountEntry {
  device: string;
  mountPoint: string;
  options: ReadonlySet<string>;
  root: string;
  source: string;
  superOptions: ReadonlySet<string>;
  type: string;
}

const RAW_SECRET_ENVIRONMENT = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'L1_PRIVATE_KEY',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD',
  'OXIDE_RELAYER_PRIVATE_KEY',
  'OXIDE_SIGNER_PRIVATE_KEY',
] as const;

const PROFILE_FILES: Record<RuntimeProfile, readonly string[]> = {
  exact: [
    EXACT_SIGNER_KEYSTORE_PATH,
    EXACT_SIGNER_PASSWORD_PATH,
    EXACT_WITNESS_ACCESS_KEY_ID_PATH,
    EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
    EXACT_WITNESS_CONFIG_PATH,
    EXACT_AZTEC_NODE_URL_PATH,
  ],
  restore: [EXACT_WITNESS_ACCESS_KEY_ID_PATH, EXACT_WITNESS_SECRET_ACCESS_KEY_PATH, EXACT_WITNESS_CONFIG_PATH],
  'generic-restore': [
    EXACT_SIGNER_KEYSTORE_PATH,
    EXACT_SIGNER_PASSWORD_PATH,
    EXACT_WITNESS_ACCESS_KEY_ID_PATH,
    EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
    EXACT_WITNESS_CONFIG_PATH,
    EXACT_AZTEC_NODE_URL_PATH,
  ],
};

const FILE_ENVIRONMENT = new Map<string, string>([
  [EXACT_SIGNER_KEYSTORE_PATH, 'OXIDE_RELAYER_KEYSTORE'],
  [EXACT_SIGNER_PASSWORD_PATH, 'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE'],
  [EXACT_WITNESS_ACCESS_KEY_ID_PATH, 'OXIDE_EXACT_WITNESS_ACCESS_KEY_ID_FILE'],
  [EXACT_WITNESS_SECRET_ACCESS_KEY_PATH, 'OXIDE_EXACT_WITNESS_SECRET_ACCESS_KEY_FILE'],
  [EXACT_WITNESS_CONFIG_PATH, 'OXIDE_EXACT_WITNESS_CONFIG_FILE'],
  [EXACT_AZTEC_NODE_URL_PATH, 'AZTEC_NODE_URL_FILE'],
  [EXACT_RUNTIME_IDENTITY_PATH, 'OXIDE_EXACT_RUNTIME_IDENTITY_FILE'],
  [EXACT_STATE_INVENTORY_PATH, 'OXIDE_EXACT_STATE_INVENTORY_FILE'],
]);

const retainedDescriptors: number[] = [];

export async function initializeRuntimeSandbox(
  profile: RuntimeProfile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runtimeUid = parseDedicatedIdentity(env.OXIDE_EXACT_RUNTIME_UID, 'UID');
  const runtimeGid = parseDedicatedIdentity(env.OXIDE_EXACT_RUNTIME_GID, 'GID');
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error('Runtime initialization must begin as container root');
  }
  rejectRawSecretEnvironment(env);
  await validateMountContract(profile, readFileSync('/proc/self/mountinfo', 'utf8'), runtimeUid, runtimeGid);
  await preparePrivilegedRuntimeIdentity(profile, runtimeUid, runtimeGid);

  const files = [EXACT_RUNTIME_IDENTITY_PATH, EXACT_STATE_INVENTORY_PATH, ...PROFILE_FILES[profile]];
  const descriptors = files.map(openRootOnlyFile);
  for (let index = 0; index < files.length; index += 1) {
    const name = FILE_ENVIRONMENT.get(files[index]!);
    if (name) env[name] = `/proc/self/fd/${descriptors[index]}`;
  }
  env.OXIDE_RELAYER_SIGNER = 'keystore';

  dropPrivileges(runtimeUid, runtimeGid);
  retainedDescriptors.push(...descriptors);
}

export function runtimeProfileFromArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const command = argv[0];
  if (command === 'relay-exact') return 'exact';
  if (command === 'authorize-generic-restore') return 'restore';
  if (command === 'run' && env.OXIDE_RUNTIME_PROFILE === 'generic-restore') return 'generic-restore';
  throw new Error('Root initializer permits only reviewed exact or restore runtime modes');
}

export async function validateMountContract(
  profile: RuntimeProfile,
  mountInfo: string,
  runtimeUid: number,
  runtimeGid: number,
): Promise<void> {
  const canonical = profile === 'generic-restore' ? GENERIC_DATA_DIRECTORY : EXACT_CANONICAL_DIRECTORY;
  const expected = [canonical, EXACT_CONTROL_DIRECTORY, EXACT_RUNTIME_CONFIG_DIRECTORY, EXACT_SECRET_DIRECTORY, '/tmp'];
  for (const candidate of expected) {
    await assertCanonicalDirectory(candidate);
  }

  const mounts = parseMountInfo(mountInfo);
  const byPath = new Map(mounts.map(mount => [mount.mountPoint, mount]));
  const canonicalMount = requireMount(byPath, canonical);
  const controlMount = requireMount(byPath, EXACT_CONTROL_DIRECTORY);
  const configMount = requireMount(byPath, EXACT_RUNTIME_CONFIG_DIRECTORY);
  const secretMount = requireMount(byPath, EXACT_SECRET_DIRECTORY);
  const temporaryMount = requireMount(byPath, '/tmp');

  requireReadOnly(canonicalMount, profile !== 'generic-restore', 'canonical state');
  requireReadOnly(controlMount, false, 'control state');
  requireReadOnly(configMount, true, 'runtime configuration');
  requireReadOnly(secretMount, true, 'runtime credentials');
  requireReadOnly(temporaryMount, false, 'temporary runtime state');
  if (
    temporaryMount.type !== 'tmpfs' ||
    !temporaryMount.options.has('nosuid') ||
    !temporaryMount.options.has('nodev') ||
    !temporaryMount.options.has('noexec')
  ) {
    throw new Error('Temporary runtime state must be an isolated noexec,nosuid,nodev tmpfs');
  }

  const identities = expected.map(candidate => {
    const mount = requireMount(byPath, candidate);
    const metadata = statSync(candidate);
    return {
      candidate,
      mountIdentity: `${mount.device}:${mount.root}:${mount.source}`,
      objectIdentity: `${metadata.dev}:${metadata.ino}`,
    };
  });
  assertDistinctRuntimeMounts(identities);


  const control = statSync(EXACT_CONTROL_DIRECTORY);
  if (control.uid !== runtimeUid || control.gid !== runtimeGid || (control.mode & 0o777) !== 0o700) {
    throw new Error('Control state must be an owner-only directory for the dedicated runtime identity');
  }
  for (const directory of [EXACT_RUNTIME_CONFIG_DIRECTORY, EXACT_SECRET_DIRECTORY]) {
    const metadata = statSync(directory);
    if (metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o777) !== 0o700) {
      throw new Error('Runtime configuration and credential directories must remain root-owned mode 0700');
    }
  }
}

export function assertDistinctRuntimeMounts(
  identities: readonly { candidate: string; mountIdentity: string; objectIdentity: string }[],
): void {
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const first = identities[left]!;
      const second = identities[right]!;
      if (
        pathsOverlap(first.candidate, second.candidate) ||
        first.mountIdentity === second.mountIdentity ||
        first.objectIdentity === second.objectIdentity
      ) {
        throw new Error('Canonical, control, configuration, credential and tmpfs paths must not alias');
      }
    }
  }
}

export function parseMountInfo(input: string): MountEntry[] {
  return input
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf(' - ');
      if (separator < 0) throw new Error('Malformed Linux mountinfo record');
      const before = line.slice(0, separator).split(' ');
      const after = line.slice(separator + 3).split(' ');
      if (before.length < 6 || after.length < 3) throw new Error('Malformed Linux mountinfo record');
      return {
        device: before[2]!,
        root: decodeMountInfo(before[3]!),
        mountPoint: decodeMountInfo(before[4]!),
        options: new Set(before[5]!.split(',')),
        type: after[0]!,
        source: decodeMountInfo(after[1]!),
        superOptions: new Set(after[2]!.split(',')),
      };
    });
}

export function assertFinalPrivilegeState(status: string, runtimeUid: number, runtimeGid: number): void {
  const values = new Map(
    status
      .split('\n')
      .filter(line => line.includes(':'))
      .map(line => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
      }),
  );
  const ids = (name: string) => (values.get(name) ?? '').split(/\s+/).filter(Boolean).map(Number);
  if (ids('Uid').some(value => value !== runtimeUid) || ids('Gid').some(value => value !== runtimeGid)) {
    throw new Error('Final runtime process identity drifted');
  }
  if ((values.get('Groups') ?? '').trim() !== '') {
    throw new Error('Final runtime process retains supplementary groups');
  }
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    if (!/^0+$/.test(values.get(name) ?? '')) throw new Error('Final runtime process retains Linux capabilities');
  }
  if (values.get('NoNewPrivs') !== '1') {
    throw new Error('Final runtime process is missing no-new-privileges');
  }
}

export function closeRetainedSecretDescriptors(): void {
  while (retainedDescriptors.length > 0) closeSync(retainedDescriptors.pop()!);
}

function dropPrivileges(runtimeUid: number, runtimeGid: number): void {
  const setgroups = process.setgroups;
  const setgid = process.setgid;
  const setuid = process.setuid;
  if (!setgroups || !setgid || !setuid) throw new Error('Linux process identity controls are unavailable');
  setgroups([]);
  setgid(runtimeGid);
  setuid(runtimeUid);
  assertFinalPrivilegeState(readFileSync('/proc/self/status', 'utf8'), runtimeUid, runtimeGid);
  try {
    setuid(0);
    throw new Error('Final runtime process regained root privileges');
  } catch (error) {
    if (process.getuid?.() === 0) throw error;
  }
}

function openRootOnlyFile(filename: string): number {
  const before = statSync(filename, { bigint: true });
  if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || (before.mode & 0o777n) !== 0o400n || before.nlink !== 1n) {
    throw new Error('Approved runtime inputs must be one root-owned mode-0400 regular file');
  }
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const after = fstatSync(descriptor, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    closeSync(descriptor);
    throw new Error('Approved runtime input changed while opening');
  }
  return descriptor;
}

export function rejectRawSecretEnvironment(env: NodeJS.ProcessEnv): void {
  if (RAW_SECRET_ENVIRONMENT.some(name => env[name] !== undefined)) {
    throw new Error('Raw credential environment variables are prohibited');
  }
}

export function parseDedicatedIdentity(value: string | undefined, label: string): number {
  if (!/^[0-9]+$/.test(value ?? '')) throw new Error(`Dedicated runtime ${label} is missing or malformed`);
  const identity = Number(value);
  if (!Number.isSafeInteger(identity) || identity !== 65532) {
    throw new Error(`Dedicated runtime ${label} must be 65532`);
  }
  return identity;
}

export function assertCanonicalRootObject(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Runtime mount paths must be canonical directories without symlinks');
  }
}

async function assertCanonicalDirectory(filename: string): Promise<void> {
  const [metadata, canonical] = await Promise.all([lstat(filename), realpath(filename)]);
  assertCanonicalRootObject(metadata);
  if (canonical !== filename) {
    throw new Error('Runtime mount paths must be canonical directories without symlinks');
  }
}

function requireMount(mounts: ReadonlyMap<string, MountEntry>, destination: string): MountEntry {
  const mount = mounts.get(destination);
  if (!mount) throw new Error(`Required runtime mount is missing: ${destination}`);
  return mount;
}

function requireReadOnly(mount: MountEntry, expected: boolean, label: string): void {
  const readOnly = mount.options.has('ro') || mount.superOptions.has('ro');
  if (readOnly !== expected) throw new Error(`${label} mount access mode drifted`);
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) || (!reverse.startsWith('..') && !path.isAbsolute(reverse));
}

function decodeMountInfo(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
