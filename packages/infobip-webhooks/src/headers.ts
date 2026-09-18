/** Any shape a framework hands you request headers in. */
export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | Map<string, string>
  | { get(name: string): string | null };

/**
 * Read one header, case-insensitively, out of whatever the framework gave us.
 * Repeated headers collapse to the first value.
 */
export function getHeader(headers: HeadersLike, name: string): string | undefined {
  const lower = name.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(n: string): string | null }).get(lower);
    return value ?? undefined;
  }

  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value[0];
    return value ?? undefined;
  }
  return undefined;
}

/** The media type from `content-type`, lower-cased, without parameters. */
export function getContentType(headers: HeadersLike): string | undefined {
  const raw = getHeader(headers, 'content-type');
  if (raw === undefined) return undefined;
  const [mediaType] = raw.split(';');
  return mediaType?.trim().toLowerCase();
}
