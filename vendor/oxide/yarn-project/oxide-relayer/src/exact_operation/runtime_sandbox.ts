import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  EXACT_AZTEC_NODE_URL_PATH,
  EXACT_CANONICAL_DIRECTORY,
  EXACT_CONTROL_DIRECTORY,
  EXACT_RUNTIME_CONFIG_DIRECTORY,
  EXACT_SECRET_DIRECTORY,
  EXACT_SIGNER_KEYSTORE_PATH,
  EXACT_SIGNER_PASSWORD_PATH,
  EXACT_WITNESS_ACCESS_KEY_ID_PATH,
  EXACT_WITNESS_CONFIG_PATH,
  EXACT_WITNESS_SECRET_ACCESS_KEY_PATH,
  GENERIC_DATA_DIRECTORY,
} from './paths.js';
import { preparePrivilegedRuntimeIdentity } from './runtime_identity.js';

export type RuntimeProfile = 'exact' | 'preflight-exact' | 'restore' | 'generic-restore';

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
  'AWS_SESSION_TOKEN',
  'AZTEC_NODE_URL',
  'AZTEC_NODE_URL_FILE',
  'AZTEC_NODE_API_KEY',
  'OXIDE_AZTEC_NODE_API_KEY',
  'L1_PRIVATE_KEY',
  'OXIDE_EXACT_WITNESS_ACCESS_KEY_ID_FILE',
  'OXIDE_EXACT_WITNESS_CONFIG_FILE',
  'OXIDE_EXACT_WITNESS_SECRET_ACCESS_KEY_FILE',
  'OXIDE_RELAYER_KEYSTORE',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD',
  'OXIDE_RELAYER_KEYSTORE_PASSWORD_FILE',
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
  'preflight-exact': [],
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

const preparedRuntimeInputs = new Map<string, Buffer>();
const preparedInheritedBundles = new Map<number, Buffer>();
const MAX_RUNTIME_INPUT_BYTES = 1024 * 1024;
const MAX_INHERITED_BUNDLE_BYTES = 64 * 1024;
function readInheritedDescriptor(fd: number): Buffer {
  const input = Buffer.allocUnsafe(MAX_INHERITED_BUNDLE_BYTES + 1);
  let offset = 0;
  while (offset < input.length) {
    const bytesRead = readSync(fd, input, offset, input.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return input.subarray(0, offset);
}


export async function initializeRuntimeSandbox(
  profile: RuntimeProfile,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const runtimeUid = parseDedicatedIdentity(env.OXIDE_EXACT_RUNTIME_UID, 'UID');
  const runtimeGid = parseDedicatedIdentity(env.OXIDE_EXACT_RUNTIME_GID, 'GID');
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error('Runtime initialization must begin as container root');
  }
  const startupStatus = readFileSync('/proc/self/status', 'utf8');
  assertStartupPrivilegeState(startupStatus);
  rejectRawSecretEnvironment(env);
  await validateMountContract(profile, readFileSync('/proc/self/mountinfo', 'utf8'), runtimeUid, runtimeGid);
  await preparePrivilegedRuntimeIdentity(profile, runtimeUid, runtimeGid);

  prepareRootOnlyRuntimeInputs(profile);
  const normalized = installInheritedBundleBuffer(argv);
  env.OXIDE_RELAYER_SIGNER = 'keystore';

  dropPrivileges(runtimeUid, runtimeGid);
  return normalized;
}

export function runtimeProfileFromArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const command = argv[0];
  if (command === 'relay-exact') return 'exact';
  if (command === 'preflight-exact') return 'preflight-exact';
  if (command === 'authorize-generic-restore') return 'restore';
  if (command === 'run' && isGenericRestoreProfile(env)) return 'generic-restore';
  throw new Error('Root initializer permits only reviewed exact, preflight, or restore runtime modes');
}

/** True when the generic run is the privileged generic-restore profile of the image's root initializer. */
export function isGenericRestoreProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OXIDE_RUNTIME_PROFILE === 'generic-restore';
}

export function installInheritedBundleBuffer(
  argv: readonly string[],
  readDescriptor: (fd: number) => Buffer = readInheritedDescriptor,
  closeDescriptor: (fd: number) => void = readDescriptor === readInheritedDescriptor ? closeSync : () => {},
): string[] {
  const normalized = [...argv];
  const option = normalized.indexOf('--bundle-fd');
  if (option < 0) return normalized;
  const rawFd = normalized[option + 1];
  if (!/^(0|[3-9][0-9]*)$/.test(rawFd ?? '')) {
    throw new Error('Inherited approval descriptor must be standard input or an inherited descriptor of at least 3');
  }
  const descriptor = Number(rawFd);
  if (preparedInheritedBundles.has(descriptor)) {
    throw new Error('Inherited approval descriptor was already prepared');
  }
  let input: Buffer;
  try {
    input = readDescriptor(descriptor);
  } finally {
    closeDescriptor(descriptor);
  }
  if (input.length === 0 || input.length > MAX_INHERITED_BUNDLE_BYTES) {
    input.fill(0);
    throw new Error('Inherited approval bundle is empty or exceeds 64 KiB');
  }
  preparedInheritedBundles.set(descriptor, input);
  return normalized;
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
  requireReadOnly(secretMount, profile !== 'preflight-exact', 'runtime credentials');
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

export function assertStartupPrivilegeState(status: string): void {
  const values = parseProcessStatus(status);
  const expected = 0xc4n;
  for (const name of ['Uid', 'Gid']) {
    const identities = (values.get(name) ?? '').split(/\s+/).filter(Boolean).map(Number);
    if (identities.length !== 4 || identities.some(value => value !== 0)) {
      throw new Error('Runtime initialization must begin with every process identity set to root');
    }
  }
  for (const name of ['CapPrm', 'CapEff', 'CapBnd']) {
    const encoded = values.get(name) ?? '';
    if (!/^[0-9a-fA-F]+$/.test(encoded) || BigInt(`0x${encoded}`) !== expected) {
      throw new Error('Startup capabilities must be exactly DAC_READ_SEARCH, SETGID and SETUID');
    }
  }
  for (const name of ['CapInh', 'CapAmb']) {
    if (!/^0+$/.test(values.get(name) ?? '')) {
      throw new Error('Startup process retains an unexpected inheritable or ambient capability');
    }
  }
  if (values.get('NoNewPrivs') !== '1') {
    throw new Error('Startup process is missing no-new-privileges');
  }
}

export function assertFinalPrivilegeState(status: string, runtimeUid: number, runtimeGid: number): void {
  const values = parseProcessStatus(status);
  const ids = (name: string) => (values.get(name) ?? '').split(/\s+/).filter(Boolean).map(Number);
  const uids = ids('Uid');
  const gids = ids('Gid');
  if (
    uids.length !== 4 ||
    gids.length !== 4 ||
    uids.some(value => value !== runtimeUid) ||
    gids.some(value => value !== runtimeGid)
  ) {
    throw new Error('Final runtime process identity drifted');
  }
  if ((values.get('Groups') ?? '').trim() !== '') {
    throw new Error('Final runtime process retains supplementary groups');
  }
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    if (!/^0+$/.test(values.get(name) ?? '')) throw new Error('Final runtime process retains Linux capabilities');
  }
  const bounding = values.get('CapBnd') ?? '';
  if (!/^[0-9a-fA-F]+$/.test(bounding) || BigInt(`0x${bounding}`) !== 0xc4n) {
    throw new Error('Runtime capability bound differs from DAC_READ_SEARCH, SETGID and SETUID');
  }
  if (values.get('NoNewPrivs') !== '1') {
    throw new Error('Final runtime process is missing no-new-privileges');
  }
}

export function consumePreparedRuntimeInput(filename: string): Buffer {
  const input = preparedRuntimeInputs.get(filename);
  if (!input) throw new Error('Root initializer did not prepare the required runtime input');
  preparedRuntimeInputs.delete(filename);
  return input;
}

export function hasPreparedRuntimeInput(filename: string): boolean {
  return preparedRuntimeInputs.has(filename);
}

export function consumePreparedInheritedBundle(descriptor: number): Buffer {
  const input = preparedInheritedBundles.get(descriptor);
  if (!input) throw new Error('Root initializer did not prepare the inherited approval bundle');
  preparedInheritedBundles.delete(descriptor);
  return input;
}

export function closeRetainedSecretDescriptors(): void {
  for (const input of preparedRuntimeInputs.values()) input.fill(0);
  for (const input of preparedInheritedBundles.values()) input.fill(0);
  preparedRuntimeInputs.clear();
  preparedInheritedBundles.clear();
}

function parseProcessStatus(status: string): Map<string, string> {
  return new Map(
    status
      .split('\n')
      .filter(line => line.includes(':'))
      .map(line => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
      }),
  );
}

export function prepareRootOnlyRuntimeInputs(
  profile: RuntimeProfile,
  readInput: (filename: string) => Buffer = readRootOnlyFile,
): void {
  if (preparedRuntimeInputs.size > 0) throw new Error('Runtime inputs were already prepared');
  try {
    for (const filename of PROFILE_FILES[profile]) {
      const input = readInput(filename);
      if (input.length === 0 || input.length > MAX_RUNTIME_INPUT_BYTES) {
        input.fill(0);
        throw new Error('Root-owned runtime input is empty or oversized');
      }
      preparedRuntimeInputs.set(filename, input);
    }
  } catch (cause) {
    closeRetainedSecretDescriptors();
    throw cause;
  }
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

function readRootOnlyFile(filename: string): Buffer {
  const before = statSync(filename, { bigint: true });
  if (
    !before.isFile() ||
    before.uid !== 0n ||
    before.gid !== 0n ||
    (before.mode & 0o777n) !== 0o400n ||
    before.nlink !== 1n ||
    before.size === 0n ||
    before.size > BigInt(MAX_RUNTIME_INPUT_BYTES)
  ) {
    throw new Error('Approved runtime inputs must be one root-owned mode-0400 regular file');
  }
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile() ||
      after.uid !== 0n ||
      after.gid !== 0n ||
      (after.mode & 0o777n) !== 0o400n ||
      after.nlink !== 1n ||
      after.size === 0n ||
      after.size > BigInt(MAX_RUNTIME_INPUT_BYTES) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    ) {
      throw new Error('Approved runtime input changed while opening');
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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
