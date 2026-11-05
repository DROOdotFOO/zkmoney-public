import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

const STATE_SET_DOMAIN = Buffer.from('oxide-relayer-state-set-v1\0', 'utf8');

export async function exactStateSetDigest(dataDirectory: string): Promise<`sha256:${string}`> {
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  const stateEntries = entries.filter(entry => isGenericStateFile(entry.name));
  const invalid = stateEntries.find(entry => !entry.isFile() || entry.isSymbolicLink());
  if (invalid) {
    throw new Error(`Generic state entry ${invalid.name} is not a regular file`);
  }
  const names = stateEntries.map(entry => entry.name).sort();
  if (!names.some(name => name.endsWith('.sqlite3'))) {
    throw new Error('No generic Oxide relayer SQLite state exists');
  }

  const digest = createHash('sha256').update(STATE_SET_DOMAIN);
  for (const name of names) {
    const filename = path.join(dataDirectory, name);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`Generic state entry ${name} is not one regular file`);
      }
      const contents = await handle.readFile();
      const nameBytes = Buffer.from(name, 'utf8');
      const nameLength = Buffer.alloc(4);
      nameLength.writeUInt32BE(nameBytes.length);
      const contentLength = Buffer.alloc(8);
      contentLength.writeBigUInt64BE(BigInt(contents.length));
      digest
        .update(nameLength)
        .update(nameBytes)
        .update(contentLength)
        .update(createHash('sha256').update(contents).digest());
    } finally {
      await handle.close();
    }
  }
  return `sha256:${digest.digest('hex')}`;
}

function isGenericStateFile(name: string): boolean {
  return (
    name.startsWith('oxide-relayer-') &&
    !name.includes('.runtime-lease.sqlite3') &&
    (name.endsWith('.sqlite3') || name.endsWith('.sqlite3-wal') || name.endsWith('.sqlite3-shm'))
  );
}
