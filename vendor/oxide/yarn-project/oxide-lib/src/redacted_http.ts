import { type HttpTransport, type HttpTransportConfig, http } from 'viem';

/**
 * A viem `http` transport that keeps the secret parts of `url` out of the errors that it throws. An RPC URL can
 * hold a provider API key in its path, query, or userinfo, and viem writes the full URL into its error text.
 *
 * When a request fails, the transport replaces the URL with its origin and `/<redacted>` in each string field of
 * the error and of each error in its `cause` chain. It rethrows the same error object, so the class, `status`, and
 * `code` do not change.
 */
export function redactedHttp(url: string, config?: HttpTransportConfig): HttpTransport {
  const transport = http(url, config);
  const secrets = secretForms(url);
  if (secrets.length === 0) {
    return transport;
  }
  const redacted = `${new URL(url).origin}/<redacted>`;
  return params => {
    const inner = transport(params);
    const request: typeof inner.request = async (args, options) => {
      try {
        return await inner.request(args, options);
      } catch (err) {
        redactErrorChain(err, secrets, redacted);
        throw err;
      }
    };
    return { ...inner, request };
  };
}

/** The spellings of `url` to replace, or none when the URL has nothing after its origin. */
function secretForms(url: string): string[] {
  const parsed = new URL(url);
  if (parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.pathname === '/') {
    return [];
  }
  // The longest form goes first, so a shorter form does not replace part of a longer one.
  return [...new Set([url, parsed.href])].sort((a, b) => b.length - a.length);
}

function redactErrorChain(err: unknown, secrets: string[], redacted: string): void {
  const seen = new Set<unknown>();
  let current = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const fields = current as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.getOwnPropertyNames(current), 'message', 'stack'])) {
      const value = fields[key];
      if (typeof value === 'string') {
        fields[key] = redact(value, secrets, redacted);
      } else if (Array.isArray(value)) {
        fields[key] = value.map(item => (typeof item === 'string' ? redact(item, secrets, redacted) : item));
      }
    }
    current = current.cause;
  }
}

function redact(text: string, secrets: string[], redacted: string): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join(redacted), text);
}
