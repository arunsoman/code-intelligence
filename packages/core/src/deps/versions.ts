// F04 WP-02: one version comparator per ecosystem — never a generic semver. npm/Cargo use semver with their own
// pre-release and range grammars; Go uses semver with a `v` prefix and pseudo-versions; PyPI uses PEP 440 (epochs,
// post/dev releases, local versions); Maven uses ComparableVersion ordering. A version the comparator cannot parse
// throws VersionError — the caller maps that to `applies: UNKNOWN`, never a silent comparison.
import type { PurlType } from "./purl.ts";

export class VersionError extends Error {}

export interface VersionComparator {
  readonly ecosystem: string;
  valid(v: string): boolean;
  /** -1 | 0 | 1; throws VersionError when either side is unparseable. */
  compare(a: string, b: string): number;
  /** Whether `version` is admitted by `range`, evaluated with the ecosystem's own range semantics; throws VersionError
   *  when the version is unparseable or the range grammar cannot be judged. */
  satisfies(version: string, range: string): boolean;
}

// ---------------------------------------------------------------- semver core (npm, Cargo, Go)

interface SemVer { major: number; minor: number; patch: number; pre: string[]; }

function parseSemVer(s: string): SemVer {
  const m = /^[v]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
  if (!m) throw new VersionError(`unparseable version: ${s.slice(0, 60)}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release outranks any pre-release
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = +x - +y; if (d) return sign(d); }
    else if (nx !== ny) return nx ? -1 : 1; // numeric identifiers sort below alphanumeric
    else { const d = x.localeCompare(y); if (d) return sign(d); }
  }
  return 0;
}

function compareSemVer(a: SemVer, b: SemVer): number {
  return sign(a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre));
}

// ---------------------------------------------------------------- npm

interface Partial { major: number | null; minor: number | null; patch: number | null; pre: string[] | null; }

function parsePartial(t: string): Partial | null {
  const m = /^[v]?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(t.trim());
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || /^(x|X|\*)$/.test(s) ? null : +s);
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ? m[4].split(".") : null };
}

interface NpmComparator { lo?: { v: SemVer; inclusive: boolean }; hi?: { v: SemVer; inclusive: boolean }; preBase: [number, number, number] | null; }

/** npm rule: a pre-release version satisfies a comparator tuple only when some comparator names a pre-release on the
 *  same [major, minor, patch]. */
function npmPreOk(version: SemVer, tupleHasPreOnBase: boolean): boolean {
  return !version.pre.length || tupleHasPreOnBase;
}

function npmTuple(version: SemVer, comparators: NpmComparator[]): boolean {
  if (!npmPreOk(version, comparators.some((c) => c.preBase !== null
    && c.preBase[0] === version.major && c.preBase[1] === version.minor && c.preBase[2] === version.patch))) return false;
  for (const c of comparators) {
    if (c.lo) { const d = compareSemVer(version, c.lo.v); if (c.lo.inclusive ? d < 0 : d <= 0) return false; }
    if (c.hi) { const d = compareSemVer(version, c.hi.v); if (c.hi.inclusive ? d > 0 : d >= 0) return false; }
  }
  return true;
}

function npmAtomToComparator(atom: string): NpmComparator[] | null {
  const hyph = /^(\S+)\s+-\s+(\S+)$/.exec(atom);
  if (hyph) {
    const lo = parsePartial(hyph[1]), hi = parsePartial(hyph[2]);
    if (!lo || !hi || lo.major === null || hi.major === null) return null;
    return [{
      lo: { v: { major: lo.major, minor: lo.minor ?? 0, patch: lo.patch ?? 0, pre: lo.pre ?? [] }, inclusive: true },
      hi: { v: { major: hi.major, minor: hi.minor ?? 0, patch: hi.patch === null ? Number.MAX_SAFE_INTEGER : hi.patch, pre: [] }, inclusive: true },
      preBase: lo.pre ? [lo.major, lo.minor ?? 0, lo.patch ?? 0] : null,
    }];
  }
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(\S+)$/.exec(atom);
  if (!m) return null;
  const op = m[1] ?? "", p = parsePartial(m[2]);
  if (!p) return null;
  const preBase: [number, number, number] | null = p.pre && p.major !== null ? [p.major, p.minor ?? 0, p.patch ?? 0] : null;
  if (op === "^" || op === "~") {
    if (p.major === null) return []; // ^* / ~* admit everything
    const lo: SemVer = { major: p.major, minor: p.minor ?? 0, patch: p.patch ?? 0, pre: p.pre ?? [] };
    let hi: SemVer;
    if (op === "^") {
      if (p.major > 0) hi = { major: p.major + 1, minor: 0, patch: 0, pre: [] };
      else if (p.minor !== null && p.minor > 0) hi = { major: 0, minor: p.minor + 1, patch: 0, pre: [] };
      else if (p.minor === null) hi = { major: 1, minor: 0, patch: 0, pre: [] };
      else hi = { major: 0, minor: 0, patch: (p.patch ?? 0) + 1, pre: [] };
    } else {
      if (p.minor !== null) hi = { major: p.major, minor: p.minor + 1, patch: 0, pre: [] };
      else hi = { major: p.major + 1, minor: 0, patch: 0, pre: [] };
    }
    return [{ lo: { v: lo, inclusive: true }, hi: { v: hi, inclusive: false }, preBase }];
  }
  if (["", "="].includes(op)) {
    if (p.major === null) return [];
    if (p.minor === null) return [{ lo: { v: { major: p.major, minor: 0, patch: 0, pre: [] }, inclusive: true }, hi: { v: { major: p.major + 1, minor: 0, patch: 0, pre: [] }, inclusive: false }, preBase }];
    if (p.patch === null) return [{ lo: { v: { major: p.major, minor: p.minor, patch: 0, pre: [] }, inclusive: true }, hi: { v: { major: p.major, minor: p.minor + 1, patch: 0, pre: [] }, inclusive: false }, preBase }];
    const v: SemVer = { major: p.major, minor: p.minor, patch: p.patch, pre: p.pre ?? [] };
    return [{ lo: { v, inclusive: true }, hi: { v, inclusive: true }, preBase }];
  }
  if (p.major === null) return null;
  const v: SemVer = { major: p.major, minor: p.minor ?? 0, patch: p.patch ?? 0, pre: p.pre ?? [] };
  const c: NpmComparator = { preBase };
  if (op === ">=") c.lo = { v, inclusive: true };
  if (op === ">") c.lo = { v, inclusive: false };
  if (op === "<=") c.hi = { v, inclusive: true };
  if (op === "<") c.hi = { v, inclusive: false };
  return [c];
}

function npmSatisfies(version: string, range: string): boolean {
  const v = parseSemVer(version);
  const alts = range.trim().split("||");
  let judged = false;
  for (const alt of alts) {
    const atoms = alt.trim() === "" ? ["*"] : alt.trim().split(/\s+/);
    // a hyphen range is three tokens "a - b"; rejoin before splitting on spaces
    const joined = atoms.join(" ");
    const hyph = /^(.+?)\s+-\s+(.+?)$/.exec(joined);
    const parts = hyph ? [joined] : atoms;
    const comparators: NpmComparator[] = [];
    let ok = true;
    for (const part of parts) {
      const cs = npmAtomToComparator(part);
      if (cs === null) { ok = false; break; }
      comparators.push(...cs);
    }
    if (!ok) continue; // an unjudgeable alternative is skipped; if none judge, we throw below
    judged = true;
    if (npmTuple(v, comparators)) return true;
  }
  if (!judged) throw new VersionError(`cannot judge npm range: ${range.slice(0, 80)}`);
  return false;
}

// ---------------------------------------------------------------- Cargo

function cargoSatisfies(version: string, range: string): boolean {
  const v = parseSemVer(version);
  const clauses = range.split(",").map((s) => s.trim()).filter(Boolean);
  if (!clauses.length) throw new VersionError(`cannot judge cargo range: ${range.slice(0, 80)}`);
  for (const clause of clauses) {
    const m = /^(\^|~|=|>=|<=|>|<)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|\d+\.\d+|\d+|\*)$/.exec(clause);
    if (!m) throw new VersionError(`cannot judge cargo range: ${range.slice(0, 80)}`);
    const op = m[1] ?? "";
    if (m[2] === "*") continue;
    if (["", "^"].includes(op)) {
      // caret semantics, the Cargo default: a bare "1.2" is ^1.2
      const segs = m[2].split("-");
      const nums = segs[0].split(".").map(Number);
      const pre = segs[1] ? segs[1].split(".") : [];
      const lo: SemVer = { major: nums[0], minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre };
      if (compareSemVer(v, lo) < 0) return false;
      const hi: SemVer = nums[0] > 0 ? { major: nums[0] + 1, minor: 0, patch: 0, pre: [] }
        : nums[1] !== undefined && nums[1] > 0 ? { major: 0, minor: nums[1] + 1, patch: 0, pre: [] }
        : { major: 0, minor: 0, patch: (nums[2] ?? 0) + 1, pre: [] };
      if (compareSemVer(v, hi) >= 0) return false;
      // pre-release rule: a pre-release matches only when the requirement names one on the same base version
      if (v.pre.length && (!pre.length || v.major !== lo.major || v.minor !== lo.minor || v.patch !== lo.patch)) return false;
      continue;
    }
    if (op === "~") {
      const nums = m[2].split("-")[0].split(".").map(Number);
      const lo: SemVer = { major: nums[0], minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre: m[2].includes("-") ? m[2].split("-")[1].split(".") : [] };
      if (compareSemVer(v, lo) < 0) return false;
      const hi: SemVer = nums[1] !== undefined ? { major: nums[0], minor: nums[1] + 1, patch: 0, pre: [] } : { major: nums[0] + 1, minor: 0, patch: 0, pre: [] };
      if (compareSemVer(v, hi) >= 0) return false;
      continue;
    }
    const req = parseSemVer(m[2].split(".").length === 3 || m[2].includes("-") ? m[2] : `${m[2]}${".0".repeat(3 - m[2].split(".").length)}`);
    const d = compareSemVer(v, req);
    if (op === "=" && d !== 0) return false;
    if (op === ">=" && d < 0) return false;
    if (op === "<=" && d > 0) return false;
    if (op === ">" && d <= 0) return false;
    if (op === "<" && d >= 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Go

function goValid(v: string): boolean {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+incompatible)?$/.test(v.trim());
}

function goSatisfies(version: string, range: string): boolean {
  const v = parseSemVer(version);
  const r = parseSemVer(range.trim().replace(/^v/, ""));
  // Go modules pin exact versions (MVS picks the minimum); a range admission means exact equality.
  return compareSemVer(v, r) === 0;
}

// ---------------------------------------------------------------- PyPI (PEP 440)

interface Pep440 { epoch: number; release: number[]; pre: { kind: number; n: number } | null; post: number | null; dev: number | null; }

function parsePep440(s: string): Pep440 {
  const m = /^(\d+!)?(\d+(?:\.\d+)*)(?:(a|b|rc|alpha|beta|pre|preview|c)(\d*))?(?:(?:\.|-|_)?post(\d*)|(?:\.|-|_)(\d+))?(?:(?:\.|-|_)?dev(\d*))?(?:\+[A-Za-z0-9.]+)?$/i.exec(s.trim());
  if (!m) throw new VersionError(`unparseable PEP 440 version: ${s.slice(0, 60)}`);
  const kindOf = (k: string) => ({ a: 1, alpha: 1, b: 2, beta: 2, rc: 3, c: 3, pre: 3, preview: 3 })[k.toLowerCase()] ?? 0;
  const post = m[5] !== undefined ? (m[5] === "" ? 0 : +m[5]) : m[6] !== undefined ? +m[6] : null;
  return { epoch: m[1] ? +m[1].slice(0, -1) : 0, release: m[2].split(".").map(Number), pre: m[3] ? { kind: kindOf(m[3]), n: m[4] === "" || m[4] === undefined ? 0 : +m[4] } : null, post, dev: m[7] !== undefined ? (m[7] === "" ? 0 : +m[7]) : null };
}

function pep440Key(v: Pep440): [number, number[], number, number, number, number] {
  // rank: 0 = dev-only (before any pre), 1 = pre (possibly with dev), 2 = release, 3 = post (possibly with dev)
  const rank = v.dev !== null && v.pre === null && v.post === null ? 0 : v.pre ? 1 : v.post !== null ? 3 : 2;
  const kind = v.pre?.kind ?? 0;
  const stageN = v.pre ? v.pre.n : v.post ?? 0;
  const devN = v.dev ?? Number.MAX_SAFE_INTEGER;
  return [v.epoch, v.release, rank, kind, stageN, devN];
}

function comparePep440(a: Pep440, b: Pep440): number {
  const ka = pep440Key(a), kb = pep440Key(b);
  if (ka[0] !== kb[0]) return sign(ka[0] - kb[0]);
  for (let i = 0; i < Math.max(ka[1].length, kb[1].length); i++) {
    const d = (ka[1][i] ?? 0) - (kb[1][i] ?? 0);
    if (d) return sign(d);
  }
  for (const i of [2, 3, 4, 5] as const) { if (ka[i] !== kb[i]) return sign(ka[i] - kb[i]); }
  return 0; // local versions do not affect precedence (PEP 440)
}

function pep440Satisfies(version: string, spec: string): boolean {
  const v = parsePep440(version);
  const clauses = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (!clauses.length) throw new VersionError(`cannot judge PEP 440 specifier: ${spec.slice(0, 80)}`);
  let allowsPre = false;
  for (const clause of clauses) if (/(?:^|[<>=!~\s])\d*(?:\.\d+)*(?:a|b|rc|alpha|beta|pre|preview|c)\d*/i.test(clause) || /dev/i.test(clause)) allowsPre = true;
  if (v.pre && !allowsPre) return false;
  for (const clause of clauses) {
    const m = /^(===|==|!=|>=|<=|~=|>|<)?\s*(\d+(?:\.\d+)*(?:(?:a|b|rc|alpha|beta|pre|preview|c)\d*)?(?:\.post\d*|\.dev\d*)?)(\.\*)?$/i.exec(clause);
    if (!m) throw new VersionError(`cannot judge PEP 440 specifier: ${spec.slice(0, 80)}`);
    const op = m[1] ?? "==";
    if (op === "===") { if (version.trim() !== clause.replace(/^===\s*/, "").trim()) return false; continue; }
    const ref = parsePep440(m[2]);
    if (m[3]) { // prefix match: compare only the segments the reference wrote
      const segs = ref.release.slice(0, m[2].split(/(?:a|b|rc|alpha|beta|pre|preview|c)/i)[0].split(".").length);
      const vsegs = v.release.slice(0, segs.length);
      const eq = segs.every((x, i) => x === vsegs[i]);
      if (op === "==" && !eq) return false;
      if (op === "!=" && eq) return false;
      continue;
    }
    const d = comparePep440(v, ref);
    if (op === "==" && d !== 0) return false;
    if (op === "!=" && d === 0) return false;
    if (op === ">=" && d < 0) return false;
    if (op === "<=" && d > 0) return false;
    if (op === ">" && d <= 0) return false;
    if (op === "<" && d >= 0) return false;
    if (op === "~=") {
      if (d < 0) return false;
      const keep = ref.release.length - 1;
      if (!ref.release.slice(0, keep).every((x, i) => x === (v.release[i] ?? 0))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- Maven (ComparableVersion ordering)

const MAVEN_QUALIFIERS: Record<string, number> = { alpha: 0, beta: 1, milestone: 2, rc: 3, cr: 3, snapshot: 4, "": 5, ga: 5, release: 5, final: 5, sp: 6 };

type MavenToken = { num: number | null; str: string | null };
function mavenTokens(v: string): MavenToken[] {
  const out: MavenToken[] = [];
  for (const m of v.trim().matchAll(/(\d+)|([A-Za-z]+)|([.-_])/g)) {
    if (m[3]) continue;
    if (m[1] !== undefined) out.push({ num: +m[1], str: null });
    else out.push({ num: null, str: m[2].toLowerCase() });
  }
  // A Maven version starts with a number; a string that does not is not a version, so the caller records `applies: UNKNOWN`.
  if (!out.length || out[0].num === null) throw new VersionError(`unparseable maven version: ${v.slice(0, 60)}`);
  // ComparableVersion.normalize: a run of numbers drops its trailing zeros (1.0 == 1.0.0 == 1; 1.0.0-alpha == 1.0-alpha).
  const normalized: MavenToken[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].num === null) { normalized.push(out[i]); continue; }
    const run: MavenToken[] = [out[i]];
    while (i + 1 < out.length && out[i + 1].num !== null) run.push(out[++i]);
    while (run.length > 1 && run[run.length - 1].num === 0) run.pop();
    normalized.push(...run);
  }
  return normalized;
}

function compareStrQualifiers(a: string, b: string): number {
  const qa = MAVEN_QUALIFIERS[a], qb = MAVEN_QUALIFIERS[b];
  if (qa !== undefined && qb !== undefined) return sign(qa - qb);
  if (qa !== undefined) return -1; // a known qualifier (integer rank) sorts below an unknown one (string rank)
  if (qb !== undefined) return 1;
  return sign(a.localeCompare(b));
}

/** ComparableVersion's compareTo(null): a numeric tail counts as greater (except 0, so 1.0 == 1.0.0); a qualifier tail
 *  is ranked against the implicit release (""). */
function compareItemToNull(t: MavenToken): number {
  if (t.num !== null) return t.num === 0 ? 0 : 1;
  return compareStrQualifiers(t.str!, "");
}

function compareMaven(a: string, b: string): number {
  const ta = mavenTokens(a), tb = mavenTokens(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    // A trailing item is compared against the implicit release. A zero means "the same version", so the loop continues
    // rather than stopping: 1.0-sp1 has an internal 0 that matches the end of 1.0, and the sp then decides.
    if (x === undefined) { const d = -compareItemToNull(y!); if (d) return d; continue; }
    if (y === undefined) { const d = compareItemToNull(x); if (d) return d; continue; }
    if (x.num !== null && y.num !== null) { if (x.num !== y.num) return sign(x.num - y.num); continue; }
    if (x.num !== null) return 1; // numbers sort above qualifier strings
    if (y.num !== null) return -1;
    const d = compareStrQualifiers(x.str!, y.str!);
    if (d) return d;
  }
  return 0;
}

function mavenSatisfies(version: string, range: string): boolean {
  const r = range.trim();
  const exact = /^([\[(])([^,)\]]*)([\])])$/.exec(r);
  if (exact) {
    const inner = exact[2].trim();
    if (!inner) throw new VersionError(`cannot judge maven range: ${r.slice(0, 80)}`);
    return compareMaven(version, inner) === 0; // [1.0] (or (1.0)) pins one version
  }
  const m = /^([\[(])([^,]*),([^)\]]*)([\])])$/.exec(r);
  if (m) {
    const dLo = m[2] === "" ? null : compareMaven(version, m[2]);
    const dHi = m[3] === "" ? null : compareMaven(version, m[3]);
    if (dLo !== null && (m[1] === "[" ? dLo < 0 : dLo <= 0)) return false;
    if (dHi !== null && (m[4] === "]" ? dHi > 0 : dHi >= 0)) return false;
    return true;
  }
  if (/^[\[(]/.test(r)) throw new VersionError(`cannot judge maven range: ${r.slice(0, 80)}`);
  return compareMaven(version, r) === 0; // soft requirement: exact match
}

// ---------------------------------------------------------------- registry

function semverComparator(ecosystem: string, opts: { goPrefix?: boolean; satisfies: (v: string, r: string) => boolean }): VersionComparator {
  return {
    ecosystem,
    valid: (v) => { try { parseSemVer(v); return true; } catch { return false; } },
    compare: (a, b) => compareSemVer(parseSemVer(a), parseSemVer(b)),
    satisfies: opts.satisfies,
  };
}

const COMPARATORS: Record<PurlType, VersionComparator> = {
  npm: semverComparator("npm", { satisfies: npmSatisfies }),
  cargo: semverComparator("cargo", { satisfies: cargoSatisfies }),
  golang: {
    ecosystem: "golang",
    valid: goValid,
    compare: (a, b) => {
      if (!goValid(a)) throw new VersionError(`unparseable go version: ${a.slice(0, 60)}`);
      if (!goValid(b)) throw new VersionError(`unparseable go version: ${b.slice(0, 60)}`);
      return compareSemVer(parseSemVer(a), parseSemVer(b));
    },
    satisfies: (v, r) => {
      if (!goValid(r.trim())) throw new VersionError(`cannot judge go version: ${r.slice(0, 60)}`);
      return goSatisfies(v, r);
    },
  },
  pypi: {
    ecosystem: "pypi",
    valid: (v) => { try { parsePep440(v); return true; } catch { return false; } },
    compare: (a, b) => comparePep440(parsePep440(a), parsePep440(b)),
    satisfies: pep440Satisfies,
  },
  maven: {
    ecosystem: "maven",
    valid: (v) => { try { mavenTokens(v); return true; } catch { return false; } },
    compare: compareMaven,
    satisfies: mavenSatisfies,
  },
};

export function comparatorFor(ecosystem: PurlType): VersionComparator {
  const c = COMPARATORS[ecosystem];
  if (!c) throw new VersionError(`no comparator for ecosystem: ${ecosystem}`);
  return c;
}
