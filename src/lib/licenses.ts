// Reads public/licenses/THIRD_PARTY_LICENSES.txt as written by scripts/generate-licenses.mjs:
//
//   <preamble>
//   ====== / Section title / ======
//   name version — license [(only on …)]      one per package, then "  source url"
//   ------ / Applies to: a 1.0, b 2.0 / ------  followed by the license text those packages share
//   ------ / No license file in the published package; …:  followed by the packages without one
//
// The dialog shows it as a package list with the selected package's text. A line the parser does not
// understand never throws: the package is listed without a text rather than dropping the file.

export type LicensePackage = {
  id: number;
  name: string;
  version: string;
  license: string;
  /** Where the package ships ("only on x86_64-…"), empty when it ships everywhere. */
  note: string;
  source: string;
  section: string;
  /** The license texts that apply to this package, in file order. */
  texts: string[];
};

export type ParsedLicenses = { overview: string; packages: LicensePackage[] };

const BANNER = /^={78}$/;
const RULE = /^-{78}$/;
const VERSIONED = /^(.*?) (not installed here|build tool|v?\d\S*)$/;

function isBlockStart(lines: string[], index: number): boolean {
  if (!RULE.test(lines[index] ?? '')) return false;
  const next = lines[index + 1] ?? '';
  return next.startsWith('Applies to: ') || next.startsWith('No license file');
}

export function parseThirdPartyLicenses(raw: string): ParsedLicenses {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const packages: LicensePackage[] = [];
  let overview = '';
  let i = 0;

  // Everything before the first banner is the file's own introduction.
  const firstBanner = lines.findIndex((line) => BANNER.test(line));
  overview = lines.slice(0, firstBanner < 0 ? lines.length : firstBanner).join('\n').trim();
  i = firstBanner < 0 ? lines.length : firstBanner;

  while (i < lines.length) {
    if (!BANNER.test(lines[i])) { i += 1; continue; }
    const section = (lines[i + 1] ?? '').trim();
    i += 3; // banner, title, banner
    const byKey = new Map<string, LicensePackage[]>();
    // The package list runs until the first license block of the section.
    while (i < lines.length && !BANNER.test(lines[i]) && !isBlockStart(lines, i)) {
      const line = lines[i];
      if (line.trim() === '') { i += 1; continue; }
      if (line.startsWith('  ')) {
        const last = packages[packages.length - 1];
        if (last && !last.source) last.source = line.trim();
        i += 1;
        continue;
      }
      const dash = line.indexOf(' — ');
      const head = dash < 0 ? line : line.slice(0, dash);
      let license = dash < 0 ? '' : line.slice(dash + 3).trim();
      let note = '';
      const only = /^(.*?) \((only on [^)]*)\)$/.exec(license);
      if (only) { license = only[1]; note = only[2]; }
      const split = VERSIONED.exec(head);
      const pkg: LicensePackage = {
        id: packages.length, name: split ? split[1] : head, version: split ? split[2] : '', license, note, source: '', section, texts: []
      };
      packages.push(pkg);
      byKey.set(head, [...(byKey.get(head) ?? []), pkg]);
      i += 1;
    }
    // License blocks: the packages a text applies to, then the text itself.
    while (i < lines.length && !BANNER.test(lines[i])) {
      if (!isBlockStart(lines, i)) { i += 1; continue; }
      const title = lines[i + 1];
      if (!title.startsWith('Applies to: ')) { i += 2; continue; } // the "no license file" list needs no text
      i += 3; // rule, title, rule
      const owners = title.slice('Applies to: '.length).split(', ');
      const body: string[] = [];
      while (i < lines.length && !BANNER.test(lines[i]) && !isBlockStart(lines, i)) { body.push(lines[i]); i += 1; }
      const text = body.join('\n').trim();
      if (!text) continue;
      for (const owner of owners) for (const pkg of byKey.get(owner) ?? []) if (!pkg.texts.includes(text)) pkg.texts.push(text);
    }
  }
  return { overview, packages };
}

/** Case-insensitive match on name, version and license; an empty query keeps everything. */
export function filterPackages(packages: LicensePackage[], query: string): LicensePackage[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return packages;
  return packages.filter((pkg) => `${pkg.name} ${pkg.version} ${pkg.license}`.toLowerCase().includes(needle));
}
