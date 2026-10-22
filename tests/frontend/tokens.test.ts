import { describe, expect, it } from 'vitest';
import { compareTokens, tokensPreserved } from '../../src/lib/tokens';

// The same cases as tests/test_text_tokens.py: original, a translation that keeps it, ones that do not.
const CASES: [string, string, string[]][] = [
  ['Hi %s', '안녕 %s', ['안녕', '안녕 %d', '안녕 %s %s']],
  ['Level %02d', '레벨 %02d', ['레벨', '레벨 %d', '레벨 %03d', '레벨 %2d']],
  ['Gold: %.2f', '금: %.2f', ['금', '금: %f', '금: %.1f', '금: %.3f']],
  ['Gold: %1$.2f', '금: %1$.2f', ['금', '금: %1$.1f', '금: %.2f', '금: %2$.2f']],
  ['Hex %x', '16진 %x', ['16진', '16진 %X', '16진 %d']],
  ['Hex %08X', '16진 %08X', ['16진 %8X', '16진']],
  ['NAME %S', '이름 %S', ['이름 %s', '이름']],
  ['Done 100%%', '완료 100%%', ['완료 100%', '완료 100']],
  ['Time %tY-%tm', '시간 %tY-%tm', ['시간 %tY', '시간 %tY-%td']],
  ['%-10s|', '%-10s|', ['%10s|', '%s|']],
  ['%+d points', '%+d 점', ['%d 점']],
  ['%b flag', '%b 깃발', ['깃발']],
  ['Hello {player}', '안녕 {player}', ['안녕', '안녕 {name}']],
  ['§6Gold §rcoin', '§6금 §r동전', ['금 동전', '§c금 §r동전']]
];

describe('formatting tokens', () => {
  it('accepts every translation that keeps the tokens and flags every one that does not', () => {
    for (const [original, kept, broken] of CASES) {
      expect(tokensPreserved(original, kept), `${original} -> ${kept}`).toBe(true);
      for (const answer of broken) expect(tokensPreserved(original, answer), `${original} -> ${answer}`).toBe(false);
    }
  });

  it('lets indexed arguments swap places but not change', () => {
    const original = '%1$s killed %2$s with %3$d hits';
    expect(tokensPreserved(original, '%2$s 처치 %1$s, %3$d 회')).toBe(true);
    expect(tokensPreserved(original, '%1$s 처치 %2$s')).toBe(false);
    expect(tokensPreserved(original, '%1$s %2$s %3$s')).toBe(false);
  });

  it('does not treat a percentage in prose as a placeholder', () => {
    expect(tokensPreserved('Save 50% now', '지금 50% 절약')).toBe(true);
    expect(tokensPreserved('15%off today', '오늘 15%할인')).toBe(true);
    expect(tokensPreserved('%shp', 'hp')).toBe(false);
  });

  it('names what was dropped and what was invented', () => {
    expect(compareTokens('§6Merchant §rof %s', 'Merchant §6of')).toMatchObject({ ok: false, lost: ['§r', '%s'], added: [] });
    expect(compareTokens('Hello', '§6안녕')).toMatchObject({ ok: false, lost: [], added: ['§6'] });
  });

  it('ignores a reset the model appended after the last character', () => {
    expect(tokensPreserved('§6Gold', '§6금§r')).toBe(true);
    expect(tokensPreserved('§6Gold §rcoin', '§6금 §r동전 §r')).toBe(true);
    expect(tokensPreserved('§6Gold §rcoin', '§6금 §r동전 §r§r')).toBe(true);
    expect(tokensPreserved('§6Gold', '§6금 §r동전')).toBe(false);
  });
});
