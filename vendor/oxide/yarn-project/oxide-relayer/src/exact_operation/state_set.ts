import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const STATE_SET_DOMAIN = Buffer.from('oxide-relayer-state-set-v1\0', 'utf8');

export async function exactStateSetDigest(dataDirectory: string): Promise<`sha256:${string}`> {
  const entries = await readdir(dataDirectory, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile() && isGenericStateFile(entry.name))
    .map(entry => entry.name)
    .sort();
  if (!names.some(name => name.endsWith('.sqlite3'))) {
    throw new Error('No generic Oxide relayer SQLite state exists');
  }

  const digest = createHash('sha256').update(STATE_SET_DOMAIN);
  for (const name of names) {
    const contents = await readFile(path.join(dataDirectory, name));
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
