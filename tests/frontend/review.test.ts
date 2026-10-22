import { describe, expect, it } from 'vitest';
import { cleanOverrides, counterState, effectiveOverride, MAX_MANUAL_LENGTH } from '../../src/lib/review';
import { failureSummary, failureKey } from '../../src/lib/failures';

describe('manual translations', () => {
  it('trims, treats whitespace as no override and caps the length', () => {
    expect(effectiveOverride('  안녕  ')).toBe('안녕');
    expect(effectiveOverride(' \n\t ')).toBe('');
    expect(effectiveOverride(undefined)).toBe('');
    expect(effectiveOverride('가'.repeat(MAX_MANUAL_LENGTH + 5)).length).toBe(MAX_MANUAL_LENGTH);
  });

  it('drops blank overrides from what is sent', () => {
    expect(cleanOverrides({ a: ' x ', b: '   ', c: '' })).toEqual({ a: 'x' });
  });

  it('warns near the limit', () => {
    expect(counterState(10)).toBe('ok');
    expect(counterState(MAX_MANUAL_LENGTH * 0.95)).toBe('near');
    expect(counterState(MAX_MANUAL_LENGTH)).toBe('full');
  });
});

describe('failure codes', () => {
  it('summarises in display order and folds unknown codes into other', () => {
    expect(failureSummary({ rate_limit: 2, timeout: 1, brand_new: 3 } as never)).toEqual([
      { code: 'timeout', count: 1 }, { code: 'rate_limit', count: 2 }, { code: 'other', count: 3 }
    ]);
    expect(failureSummary(undefined)).toEqual([]);
    expect(failureKey('nonsense')).toBe('result.failure.other');
  });
});
