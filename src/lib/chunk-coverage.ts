import type { ChunkCoverage, ChunkStatus } from './api';

/**
 * Reading the per-chunk coverage a scan reports. Everything here is derived from the core's numbers;
 * a scan from before the core sent them has none, and every function treats that as "nothing to say".
 */

export const CHUNK_STATUSES: readonly ChunkStatus[] = ['processed', 'skipped_unsupported', 'unreadable', 'not_inspected'];

/** Region compression ids (Java Edition). Anything else is shown as its number. */
export const COMPRESSION_NAMES: Record<number, string> = { 1: 'gzip', 2: 'zlib', 3: 'none', 4: 'LZ4' };

export type VersionSummary =
  /** Not one chunk was read, so no version is known. */
  | { kind: 'none' }
  /** Chunks were read and none has a DataVersion (a world saved before 15w32a). */
  | { kind: 'unversioned' }
  | { kind: 'single'; version: number }
  /** More than one version (a missing one counts), with the range of the numbers that exist. */
  | { kind: 'mixed'; min: number | null; max: number | null };

export function versionSummary(coverage: ChunkCoverage): VersionSummary {
  const { distribution, min, max } = coverage.chunkVersions;
  // The flags and the range are exact; the distribution may leave out the chunks of a file with too many combinations.
  if (coverage.flags.mixed || distribution.length > 1) return { kind: 'mixed', min, max };
  if (!distribution.length) {
    if (min !== null) return { kind: 'single', version: min };
    return coverage.flags.missing ? { kind: 'unversioned' } : { kind: 'none' };
  }
  const only = distribution[0];
  return only.state === 'known' && only.dataVersion !== null ? { kind: 'single', version: only.dataVersion } : { kind: 'unversioned' };
}

/** Chunks the distribution does not itemise (a file met more version/compression combinations than the report keeps). */
export function distributionOverflow(coverage: ChunkCoverage): number {
  return coverage.chunkVersions.truncated ? coverage.chunkVersions.overflow ?? 0 : 0;
}

/** Chunks the scan did not search for text, whatever the reason. */
export function leftOutChunks(coverage: ChunkCoverage): number {
  const { skipped_unsupported: skipped, unreadable, not_inspected: notInspected } = coverage.counts;
  return skipped + unreadable + notInspected;
}

/** Region files that were not read at all, or are of a kind the app does not read. */
export function leftOutFiles(coverage: ChunkCoverage): number {
  const { unreadable, notInspected, detectedUnsupported } = coverage.files;
  return unreadable + notInspected + Object.values(detectedUnsupported).reduce((sum, count) => sum + count, 0);
}

/**
 * True when part of the world was not searched, so "no text found" cannot be read as "no text here". A summary
 * marked `partial` (a scan continued from an older checkpoint, whose finished files were not searched again) counts too.
 */
export function hasUninspected(coverage: ChunkCoverage | null | undefined): boolean {
  return !!coverage && (leftOutChunks(coverage) > 0 || leftOutFiles(coverage) > 0 || coverage.partial === true);
}

/** The write gate: chunks newer than the newest version this build has a fixture for. */
export function needsNewerConfirmation(coverage: ChunkCoverage | null | undefined): boolean {
  return coverage?.flags?.newer === true;
}

export function compressionName(id: number | null): string {
  return id === null ? '–' : COMPRESSION_NAMES[id] ?? String(id);
}

export type Dimension = { id: string; known: 'overworld' | 'the_nether' | 'the_end' | null };

/** A dimension id the interface can name, or the raw id of a custom one (`mod:name`, `world/the_nether`). */
export function dimension(id: string): Dimension {
  return { id, known: id === 'overworld' || id === 'the_nether' || id === 'the_end' ? id : null };
}

export type FileNote = { kind: 'unreadable' | 'notInspected' } | { kind: 'detected'; format: string; count: number };

/** Region files the scan did not read, one note per reason, with the count where it is not one file. */
export function fileNotes(coverage: ChunkCoverage): (FileNote & { count: number })[] {
  const { unreadable, notInspected, detectedUnsupported } = coverage.files;
  return [
    ...(unreadable > 0 ? [{ kind: 'unreadable' as const, count: unreadable }] : []),
    ...(notInspected > 0 ? [{ kind: 'notInspected' as const, count: notInspected }] : []),
    ...Object.entries(detectedUnsupported).filter(([, count]) => count > 0).map(([format, count]) => ({ kind: 'detected' as const, format, count }))
  ];
}

/**
 * One line naming what was not searched ("Skipped (unsupported) 2, Unreadable 1, 3 region files…"),
 * with the words supplied by the caller so the interface language stays in the screens.
 */
export function leftOutText(
  coverage: ChunkCoverage,
  words: { status: (status: ChunkStatus) => string; file: (note: FileNote & { count: number }) => string; number: (value: number) => string }
): string {
  const chunks = (['skipped_unsupported', 'unreadable', 'not_inspected'] as const)
    .filter((status) => coverage.counts[status] > 0)
    .map((status) => `${words.status(status)} ${words.number(coverage.counts[status])}`);
  return [...chunks, ...fileNotes(coverage).map(words.file)].join(', ');
}
