import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));

import { exportDocument } from '../../src/lib/document-export';

/** A browser has no save dialog: the file is an ordinary download. Records what would be downloaded. */
function stubDownload(): { blobs: Blob[]; names: string[] } {
  const seen = { blobs: [] as Blob[], names: [] as string[] };
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { seen.blobs.push(blob); return 'blob:test'; }, revokeObjectURL: () => undefined });
  vi.stubGlobal('document', { createElement: () => ({ click() { seen.names.push(this.download); }, href: '', download: '' }) });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('exportDocument outside the app', () => {
  it('downloads glossary text as it is, byte-order mark included, under the suggested name', async () => {
    const seen = stubDownload();
    const text = '﻿source,target,mode,note,caseSensitive\r\n"a,b",,keep,"two\nlines",false\r\n';
    await expect(exportDocument('glossary_csv', text, 'pomi-glossary-global.csv')).resolves.toBe(true);
    expect(seen.names).toEqual(['pomi-glossary-global.csv']);
    expect(seen.blobs[0].type).toBe('text/csv;charset=utf-8');
    expect(new Uint8Array(await seen.blobs[0].arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(await seen.blobs[0].text()).toBe(text.slice(1));
  });

  it('keeps the plain default names, and reports and settings stay JSON', async () => {
    const seen = stubDownload();
    await exportDocument('glossary_tsv', 'a\tb');
    await exportDocument('scan_report', { ok: true });
    expect(seen.names).toEqual(['pomi-glossary.tsv', 'scan-report.json']);
    expect(seen.blobs[0].type).toBe('text/tab-separated-values;charset=utf-8');
    expect(await seen.blobs[1].text()).toBe(JSON.stringify({ ok: true }, null, 2));
  });
});
