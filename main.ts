// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three line-matching tiers, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A move a successful edit performed, for the `R old -> new` output line. */
interface Move {
  from: string;
  to: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file split into lines: its own break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** One file line against one old line at a tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where O occurs in lines at a tier, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTiered(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One body line of a hunk, block or chunk: context, old, new, or a backslash line. `raw` is the patch line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

/**
 * The N lines that replace O's match at `pos` (SPEC.md section 5): context lines are written as the file's own
 * matched lines, never the patch's; at tier 2 every other line of N is re-indented from O's first line's leading
 * whitespace to the file's first matched line's. `items` holds O's and N's lines in body order (for SEARCH/REPLACE,
 * all of O's lines then all of N's).
 */
function buildNew(items: BodyItem[], oLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const f = oLines.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else if (it.kind === 'new') {
      if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) out.push(f + it.text.slice(p.length));
      else out.push(it.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the last body line of one of `kinds` (the final-break rule of section 6). */
function bsAfterLast(items: BodyItem[], kinds: Array<'ctx' | 'new'>): boolean {
  let j = -1;
  for (let k = 0; k < items.length; k++) {
    if (kinds.includes(items[k]!.kind as 'ctx' | 'new')) j = k;
  }
  if (j < 0) return false;
  return items[j + 1] !== undefined && items[j + 1]!.kind === 'bs';
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified-diff hunk (SPEC.md section 6). */
interface Hunk {
  a: number;
  items: BodyItem[];
}

/** One unified-diff section: one edit. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** Apply a section's hunks in order to a file's lines, tracking the per-section offset d. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oLines = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
    if (oLines.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const atEnd = idx === state.lines.length;
      const adds = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      state.lines.splice(idx, 0, ...adds);
      if (atEnd) state.final = !bsAfterLast(h.items, ['ctx', 'new']);
      d += adds.length;
      continue;
    }
    const found = findTiered(state.lines, oLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const toEnd = best + oLines.length === state.lines.length;
    const out = buildNew(h.items, oLines, state.lines, best, found.tier);
    state.lines.splice(best, oLines.length, ...out);
    if (toEnd) state.final = !bsAfterLast(h.items, ['ctx', 'new']);
    d += out.length - oLines.length;
  }
}

/** One unified-diff section as an edit. */
function uniEdit(sec: UniSection, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = newP === '/dev/null' || sec.deletedFile;
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      }
      let lastPlusBs = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.items.some((it) => it.kind === 'new')) {
          lastPlusBs = bsAfterLast(h.items, ['new']);
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const state = splitFile(before);
      applyHunks(state, sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(state));
      tree.now.set(oldP, null);
      moves.push({ from: oldP, to: newP });
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const state = splitFile(before);
    applyHunks(state, sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(state));
  };
}

/** Read a unified diff (SPEC.md section 6) as edits. */
function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const n = lines.length;
  const sections: UniSection[] = [];
  const isDiffGit = (l: string): boolean => l.startsWith('diff --git ');
  const isPairStart = (idx: number): boolean =>
    idx < n && lines[idx]!.startsWith('--- ') && idx + 1 < n && lines[idx + 1]!.startsWith('+++ ');
  const parseDiffGit = (l: string, ln: number): [string, string] => {
    const toks = l.slice('diff --git '.length).trimEnd().split(/\s+/);
    if (toks.length !== 2 || !toks[0]!.startsWith('a/') || !toks[1]!.startsWith('b/')) throw new Exit2(`error: parse ${ln}`);
    return [toks[0]!.slice(2), toks[1]!.slice(2)];
  };
  const headerPath = (l: string): string => {
    const t = l.slice(4).split('\t')[0]!;
    const p = t.trim();
    return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  };
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const parseSection = (start: number, gOld: string | null, gNew: string | null): number => {
    const sec: UniSection = { oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] };
    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    let j = start;
    while (j < n) {
      const h = lines[j]!;
      if (h.startsWith('@@')) break;
      if (isDiffGit(h)) break;
      if (h.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
        pairOld = headerPath(h);
        pairNew = headerPath(lines[j + 1]!);
        j += 2;
        continue;
      }
      if (h.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
      if (h.startsWith('rename from ')) {
        renOld = h.slice('rename from '.length).trim();
        j += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renNew = h.slice('rename to '.length).trim();
        j += 1;
        continue;
      }
      if (/^new file mode( |$)/.test(h)) {
        sec.newFile = true;
        j += 1;
        continue;
      }
      if (/^deleted file mode( |$)/.test(h)) {
        sec.deletedFile = true;
        j += 1;
        continue;
      }
      j += 1;
    }
    sec.oldPath = pairOld ?? renOld ?? gOld;
    sec.newPath = pairNew ?? renNew ?? gNew;
    while (j < n) {
      const h = lines[j]!;
      if (isDiffGit(h)) break;
      if (isPairStart(j)) break;
      if (h.startsWith('@@')) {
        const m = hunkHead.exec(h);
        if (m === null) throw new Exit2(`error: parse ${j + 1}`);
        const a = Number(m[1]);
        j += 1;
        const items: BodyItem[] = [];
        while (j < n) {
          const b = lines[j]!;
          if (isDiffGit(b)) break;
          if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            if (b === '') items.push({ kind: 'ctx', text: '', raw: '' });
            else if (b[0] === ' ') items.push({ kind: 'ctx', text: b.slice(1), raw: b });
            else if (b[0] === '-') items.push({ kind: 'old', text: b.slice(1), raw: b });
            else if (b[0] === '+') items.push({ kind: 'new', text: b.slice(1), raw: b });
            else items.push({ kind: 'bs', text: b.slice(1), raw: b });
            j += 1;
          } else break;
        }
        while (items.length > 0 && items[items.length - 1]!.raw === '') items.pop();
        sec.hunks.push({ a, items });
        continue;
      }
      j += 1;
    }
    sections.push(sec);
    return j;
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const [gOld, gNew] = parseDiffGit(l, i + 1);
      i = parseSection(i + 1, gOld, gNew);
      continue;
    }
    if (isPairStart(i)) {
      i = parseSection(i, null, null);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((sec) => uniEdit(sec, strict, moves));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const state = splitFile(before);
    const found = findTiered(state.lines, b.oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const items: BodyItem[] = [
      ...b.oldLines.map((t): BodyItem => ({ kind: 'old', text: t, raw: t })),
      ...b.newLines.map((t): BodyItem => ({ kind: 'new', text: t, raw: t })),
    ];
    const out = buildNew(items, b.oldLines, state.lines, pos, found.tier);
    state.lines.splice(pos, b.oldLines.length, ...out);
    tree.now.set(b.path, joinFile(state));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) as edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let j = -1;
    let k = -1;
    for (let t = i + 1; t < lines.length; t++) {
      if (lines[t]!.trimEnd() === '=======') {
        j = t;
        break;
      }
    }
    if (j >= 0) {
      for (let t = j + 1; t < lines.length; t++) {
        if (lines[t]!.trimEnd() === '>>>>>>> REPLACE') {
          k = t;
          break;
        }
      }
    }
    if (j < 0 || k < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = searchLine - 1; m >= prevEnd; m--) {
      const l = lines[m]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    blocks.push({ path, oldLines, newLines });
    prevEnd = k + 1;
    i = k + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

/** One V4A chunk (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(state.lines, ch.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const oLines = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
      if (oLines.length === 0) {
        const idx = ch.eof ? state.lines.length : cursor;
        const adds = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
        state.lines.splice(idx, 0, ...adds);
        cursor = idx + adds.length;
        continue;
      }
      const found = findTiered(state.lines, oLines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const out = buildNew(ch.items, oLines, state.lines, pos, found.tier);
      state.lines.splice(pos, oLines.length, ...out);
      cursor = pos + out.length;
    }
    const text = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Read a V4A patch (SPEC.md section 8) as edits. */
function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let kind: 'add' | 'delete' | 'update';
    let prefix = '';
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      prefix = '*** Add File:';
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'delete';
      prefix = '*** Delete File:';
    } else {
      kind = 'update';
      prefix = '*** Update File:';
    }
    const path = l.slice(prefix.length).trim();
    const secLineNo = i + 1;
    i += 1;
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let start = 0;
      let mIdx = 0;
      while (mIdx < raw.length && blank(raw[mIdx]!.text)) mIdx += 1;
      if (mIdx < raw.length && raw[mIdx]!.text.startsWith('*** Move to:')) {
        moveTo = raw[mIdx]!.text.slice('*** Move to:'.length).trim();
        start = mIdx + 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let needAt = false;
      for (let t = start; t < raw.length; t++) {
        const r = raw[t]!;
        const tx = r.text;
        if (tx.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = tx.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          needAt = false;
          continue;
        }
        if (tx.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          needAt = true;
          continue;
        }
        if (tx.startsWith('***')) throw new Exit2(`error: parse ${r.no}`);
        if (tx === '' || tx[0] === ' ' || tx[0] === '-' || tx[0] === '+') {
          if (cur === null) {
            if (needAt || chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, eof: false, items: [] };
          }
          if (tx === '') cur.items.push({ kind: 'ctx', text: '', raw: tx });
          else if (tx[0] === ' ') cur.items.push({ kind: 'ctx', text: tx.slice(1), raw: tx });
          else if (tx[0] === '-') cur.items.push({ kind: 'old', text: tx.slice(1), raw: tx });
          else cur.items.push({ kind: 'new', text: tx.slice(1), raw: tx });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLineNo}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict, moves));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const claimed = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const m of moves) {
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.get(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.get(m.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null && !claimed.has(m.from) && !claimed.has(m.to)) {
      claimed.add(m.from);
      claimed.add(m.to);
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
    }
  }
  for (const p of changed) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
