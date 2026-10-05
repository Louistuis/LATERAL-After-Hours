/** Deterministic compatibility key, not a cryptographic integrity or security hash. */
export function compatibilityId(canonicalIdentity: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonicalIdentity)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `tune-fnv1a64-v1:${hash.toString(16).padStart(16, '0')}`;
}
