import { describe, expect, it } from 'vitest';

import { setupConnectionIdentity } from '../../src/lib/setup-connection';

describe('setup connection identity', () => {
  const identity = (overrides: Partial<Parameters<typeof setupConnectionIdentity>[0]> = {}) => setupConnectionIdentity({
    provider: 'custom', endpoint: 'https://llm.example.test/v1', wireFormat: 'openai', key: 'synthetic-key', ...overrides
  });

  it('matches only the same provider, endpoint, wire format, and key', () => {
    const base = identity();
    expect(identity()).toBe(base);
    expect(identity({ provider: 'openai' })).not.toBe(base);
    expect(identity({ endpoint: 'https://other.example.test/v1' })).not.toBe(base);
    expect(identity({ wireFormat: 'anthropic' })).not.toBe(base);
    expect(identity({ key: 'different-synthetic-key' })).not.toBe(base);
    expect(identity({ key: '', storedKey: true })).not.toBe(identity({ key: '' }));
  });

  it('keeps a typed key out of the identity token', () => {
    const key = 'synthetic-secret-that-must-not-be-retained';
    expect(setupConnectionIdentity({ provider: 'openai', endpoint: 'https://api.example.test', wireFormat: 'openai', key })).not.toContain(key);
  });
});
