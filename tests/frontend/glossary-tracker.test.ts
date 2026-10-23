import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
  blankDraft, DraftTracker, filterDrafts, matchesQuery, matchingKeys, savableDrafts, snapshot, toDraft, type DraftEntry
} from '../../src/lib/glossary';

// The glossary page asks "is anything unsaved" and "how many rows are saved" after every keystroke. The
// tracker answers from the edited row alone; these tests hold it to the old answers, which walked the
// whole list: `snapshot(drafts) !== base` and `savableDrafts(drafts).length`.

const entry = (n: number, over: Partial<ReturnType<typeof toDraft>> = {}) =>
  toDraft({ id: n.toString(16).padStart(20, '0'), source: `Term ${n}`, target: `번역 ${n}`, mode: 'translate', caseSensitive: false, note: n % 3 ? '' : `note ${n}`, ...over });

/** What the page does: the tracker is told after each change; the old functions are the reference. */
function harness(count: number) {
  let drafts: DraftEntry[] = Array.from({ length: count }, (_, i) => entry(i));
  const tracker = new DraftTracker();
  tracker.reset(drafts);
  let base = snapshot(drafts);
  const check = (label = '') => {
    expect(tracker.dirty, `dirty ${label}`).toBe(snapshot(drafts) !== base);
    expect(tracker.count, `count ${label}`).toBe(savableDrafts(drafts).length);
  };
  return {
    tracker,
    get drafts() { return drafts; },
    check,
    edit(key: string, patch: Partial<DraftEntry>) {
      const row = tracker.draft(key)!;
      Object.assign(row, patch);
      tracker.edit(key);
    },
    replace(next: DraftEntry[]) { drafts = next; tracker.structure(drafts); },
    save() { base = snapshot(drafts); tracker.reset(drafts); }
  };
}

describe('DraftTracker', () => {
  it('starts clean and counts the saved rows', () => {
    const page = harness(5);
    page.check('start');
    expect(page.tracker.dirty).toBe(false);
    expect(page.tracker.count).toBe(5);
  });

  it('an edit that is typed and then undone is not a change', () => {
    const page = harness(6);
    const key = page.drafts[2].key;
    page.edit(key, { target: '번역 2!' });
    page.check('typed');
    expect(page.tracker.dirty).toBe(true);
    page.edit(key, { target: '번역 2' });
    page.check('undone');
    expect(page.tracker.dirty).toBe(false);
  });

  it('two edited rows stay a change until both are undone', () => {
    const page = harness(6);
    const [a, b] = [page.drafts[0].key, page.drafts[4].key];
    page.edit(a, { source: 'changed' });
    page.edit(b, { note: 'changed' });
    page.edit(a, { source: 'Term 0' });
    page.check('one undone');
    expect(page.tracker.dirty).toBe(true);
    page.edit(b, { note: '' });
    page.check('both undone');
    expect(page.tracker.dirty).toBe(false);
  });

  it('spaces around a field are not a change, and a keep entry ignores its target', () => {
    const page = harness(3);
    const key = page.drafts[1].key;
    page.edit(key, { source: '  Term 1  ' });
    page.check('trimmed');
    expect(page.tracker.dirty).toBe(false);
    page.edit(key, { mode: 'keep' });
    page.check('keep');
    expect(page.tracker.dirty).toBe(true);
    page.edit(key, { target: 'other' });
    page.check('keep with another target');
    page.edit(key, { mode: 'translate' });
    page.check('translate again');
    expect(page.tracker.dirty).toBe(true);
    page.edit(key, { target: '번역 1' });
    page.check('restored');
    expect(page.tracker.dirty).toBe(false);
  });

  it('an untouched blank row is no change; typing into it is, and emptying it again is not', () => {
    const page = harness(3);
    const row = blankDraft();
    page.replace([...page.drafts.slice(0, 1), row, ...page.drafts.slice(1)]);
    page.check('blank added');
    expect(page.tracker.dirty).toBe(false);
    expect(page.tracker.count).toBe(3);
    page.edit(row.key, { mode: 'keep' });
    page.check('mode of a blank row');
    page.edit(row.key, { source: 'New' });
    page.check('typed');
    expect(page.tracker.dirty).toBe(true);
    expect(page.tracker.count).toBe(4);
    page.edit(row.key, { source: '   ' });
    page.check('emptied');
    expect(page.tracker.dirty).toBe(false);
    expect(page.tracker.count).toBe(3);
  });

  it('removing a row, putting back an identical one with a new key, and moving rows follow the old comparison', () => {
    const page = harness(5);
    const [first, ...rest] = page.drafts;
    page.replace(rest);
    page.check('removed');
    expect(page.tracker.dirty).toBe(true);
    // The same entry under a new key: the saved text is what counts, not the key.
    const again = toDraft({ id: first.id, source: first.source, target: first.target, mode: first.mode, caseSensitive: first.caseSensitive, note: first.note });
    page.replace([again, ...rest]);
    page.check('same entry, new key');
    expect(page.tracker.dirty).toBe(false);
    page.replace([rest[0], again, ...rest.slice(1)]);
    page.check('two swapped');
    expect(page.tracker.dirty).toBe(true);
    page.replace([again, ...rest]);
    page.check('swapped back');
    expect(page.tracker.dirty).toBe(false);
  });

  it('saving makes the current list the one to compare against', () => {
    const page = harness(4);
    page.edit(page.drafts[0].key, { source: 'Saved' });
    expect(page.tracker.dirty).toBe(true);
    page.save();
    page.check('saved');
    expect(page.tracker.dirty).toBe(false);
    page.edit(page.drafts[0].key, { source: 'Term 0' });
    page.check('differs from the saved version');
    expect(page.tracker.dirty).toBe(true);
    expect(page.tracker.savedEntries()[0]).toMatchObject({ source: 'Saved' });
  });

  it('gives back the saved rows as the old base snapshot parsed', () => {
    const rows = [entry(1), blankDraft(), entry(2, { mode: 'keep' })];
    const tracker = new DraftTracker();
    tracker.reset(rows);
    expect(tracker.savedEntries()).toEqual(JSON.parse(snapshot(rows)));
    expect(tracker.count).toBe(2);
    expect(tracker.dirty).toBe(false);
  });

  it('ignores a key it does not know', () => {
    const page = harness(2);
    page.tracker.edit('missing');
    page.check('unknown key');
  });

  it('agrees with the old comparison after randomized edits, additions, removals, blanking and saves', () => {
    // A small seeded generator, so a failure repeats.
    let seed = 20261003;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const words = ['', ' ', 'Term 1', 'Term 2', '번역 1', 'note 3', ' padded ', 'x', 'Ünï', 'ß', '😀'];

    for (let round = 0; round < 60; round += 1) {
      const page = harness(Math.floor(random() * 8));
      for (let step = 0; step < 120; step += 1) {
        const rows = page.drafts;
        const op = Math.floor(random() * 10);
        const row = rows.length ? pick(rows) : undefined;
        if (op <= 3 && row) {
          const field = pick(['source', 'target', 'note'] as const);
          page.edit(row.key, { [field]: pick(words) });
        } else if (op === 4 && row) {
          page.edit(row.key, pick([{ mode: 'keep' }, { mode: 'translate' }, { caseSensitive: true }, { caseSensitive: false }] as Partial<DraftEntry>[]));
        } else if (op === 5) {
          const at = Math.floor(random() * (rows.length + 1));
          page.replace([...rows.slice(0, at), random() < 0.5 ? blankDraft() : blankDraft({ source: pick(words), target: pick(words) }), ...rows.slice(at)]);
        } else if (op === 6 && row) {
          page.replace(rows.filter((item) => item.key !== row.key));
        } else if (op === 7 && row) {
          // Blank a row completely, then often put its old text back: an edit made and undone.
          const old = { source: row.source, target: row.target, note: row.note };
          page.edit(row.key, { source: '', target: '', note: '' });
          page.check(`blanked (round ${round}, step ${step})`);
          if (random() < 0.7) page.edit(row.key, old);
        } else if (op === 8 && rows.length > 1) {
          const from = Math.floor(random() * rows.length);
          const to = Math.floor(random() * rows.length);
          const next = [...rows];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          page.replace(next);
        } else if (op === 9 && random() < 0.3) {
          page.save();
        }
        page.check(`round ${round}, step ${step}`);
      }
    }
  });
});

describe('the search keeps the rows the old filter kept', () => {
  it('matchingKeys is the key set of filterDrafts without pinned rows', () => {
    const rows = [entry(1), entry(2), blankDraft(), entry(13, { note: 'Needle in a note' }), entry(4, { source: 'NEEDLE' })];
    for (const query of ['', '  ', 'term 1', 'needle', 'NEEDLE ', '번역', 'zzz']) {
      expect([...matchingKeys(rows, query)].sort()).toEqual(filterDrafts(rows, query).map((row) => row.key).sort());
    }
    expect(matchesQuery(blankDraft(), 'zzz')).toBe(true);
    expect(matchesQuery(entry(1), 'zzz')).toBe(false);
  });
});
