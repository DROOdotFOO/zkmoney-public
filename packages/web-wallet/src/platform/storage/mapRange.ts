import type { RangeOptions } from "@obsidion/front-core"

/**
 * The part of kv-store's map the wallet database ranges over. Its bounds flip with direction:
 * `[start, end)` going forward, `(start, end]` in reverse.
 */
export interface StateMap {
  getAsync(key: string): Promise<string | undefined>
  entriesAsync(range?: {
    start?: string
    end?: string
    limit?: number
    reverse?: boolean
  }): AsyncIterableIterator<[string, string]>
}

/** The first key past every key that starts with `prefix`. */
const pastPrefix = (prefix: string) =>
  prefix && prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)

/** `DatabaseBackend.range` over `map`: keys under `prefix`, both bounds exclusive. */
export async function mapRange(
  map: StateMap,
  prefix: string,
  { after, before, limit, reverse }: RangeOptions = {},
): Promise<[string, string][]> {
  if (limit === 0) return []
  const start = after !== undefined && after >= prefix ? after : prefix
  const past = pastPrefix(prefix)
  const end = before !== undefined && (!past || before < past) ? before : past
  const inside = (key: string) =>
    key.startsWith(prefix) &&
    (after === undefined || key > after) &&
    (before === undefined || key < before)
  // The map may return one bound it includes; one extra entry makes up for it.
  const found: [string, string][] = []
  for await (const entry of map.entriesAsync({
    start: start || undefined,
    end: end || undefined,
    limit: limit === undefined ? undefined : limit + 1,
    reverse,
  })) {
    if (inside(entry[0])) found.push(entry)
  }
  const page = limit === undefined ? found : found.slice(0, limit)
  // In reverse the map's start is exclusive, so a key equal to the prefix is read alone.
  if (reverse && start === prefix && prefix && (limit === undefined || page.length < limit)) {
    const own = await map.getAsync(prefix)
    if (own !== undefined && inside(prefix)) page.push([prefix, own])
  }
  return page
}
