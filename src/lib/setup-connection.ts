export type SetupConnectionIdentity = {
  provider: string;
  endpoint: string;
  wireFormat: string;
  key: string;
  storedKey?: boolean;
};

// This volatile fingerprint is only used to compare inputs in the setup wizard. It is never a
// credential or persisted value; keeping a digest here avoids retaining another plaintext key copy.
function keyFingerprint(key: string): string {
  let first = 0x811c9dc5;
  let second = 0x9747b28c;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995) ^ (second >>> 13);
  }
  return `${key.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function setupConnectionIdentity(identity: SetupConnectionIdentity): string {
  return JSON.stringify([
    identity.provider,
    identity.endpoint.trim(),
    identity.wireFormat,
    identity.storedKey ? 'stored' : 'typed',
    keyFingerprint(identity.key)
  ]);
}
