// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, in four
// formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE
// blocks, V4A patches, and text-editor tool calls as JSON. Every file is
// changed or nothing is. This file implements SPEC.md (version 1) in full:
// the command line, the output and exit codes, safe paths, format
// detection, line matching at three tiers, all four readers, and the
// all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and
 *  without the empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 *  and none of its /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file as lines: its line break, its lines, and whether it ends with
 *  a line break. A file's line break is CRLF when its first line feed
 *  follows a carriage return, and LF otherwise. */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Moves are recorded so the output can print
 *  an R line for a file a move edit moved. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

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

/** One edit: a function of the tree, throwing Fail when it fails. */
type Edit = (tree: Tree) => void;

/** A line compared at one matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The occurrences of O in the file's lines at the first tier where one
 *  occurs, from position `from` on. Occurrences may overlap. */
function findOccurrences(
  file: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(file[i + j]!, t) !== normLine(o[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line at the first
 *  tier where one is, or null. */
function findSingleLine(file: string[], target: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < file.length; i++) {
      if (normLine(file[i]!, t) === normLine(target, t)) return i;
    }
  }
  return null;
}

/** A line of N re-indented at tier 2: F is the leading spaces and tabs of
 *  the file's first matched line, P those of O's first line. */
function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: a context line (in both
 *  O and N), an old line (in O only) or a new line (in N only). */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** The replacement lines for a matched O, from the ops in body order: a
 *  context line is written as the file's own matched line, never the
 *  patch's; at tier 2 every other line of N is re-indented. */
function buildReplacement(ops: Op[], file: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const oLines = ops.filter((o) => o.kind !== 'add').map((o) => o.text);
  const f = leadingWs(file[pos] ?? '');
  const p = leadingWs(oLines[0] ?? '');
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[pos + oIdx]!);
      oIdx++;
    } else if (op.kind === 'del') {
      oIdx++;
    } else if (tier === 2) {
      out.push(reindent(op.text, f, p));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

/** The new lines of a SEARCH/REPLACE block or a JSON str_replace, with
 *  tier-2 re-indentation applied to each. */
function reindentLines(lines: string[], file: string[], pos: number, oFirst: string, tier: number): string[] {
  if (tier !== 2) return [...lines];
  const f = leadingWs(file[pos] ?? '');
  const p = leadingWs(oFirst);
  return lines.map((l) => reindent(l, f, p));
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fs = splitFile(before);
      if (line < 0 || line > fs.lines.length) throw new Fail('no-match', p);
      const lines = [...fs.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, fs.br, fs.ends));
    };
  }
  return null;
}

/** The edits of a JSON patch: one JSON array of edit objects, or JSON
 *  Lines with one edit object a line, blank lines ignored. */
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

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UHunk {
  /** The old-file start line from the hunk header. */
  a: number;
  ops: Op[];
  /** A \ line follows the hunk's last context or + line. */
  noNL: boolean;
  /** A \ line follows the hunk's last + line. */
  addNoNL: boolean;
}

interface USection {
  /** The old path: a string, null for /dev/null, undefined when unnamed. */
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string | null;
  renameNew?: string | null;
  gitOld?: string;
  gitNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** A path from a --- or +++ header line: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed, and
 *  a leading a/ or b/ removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** A hunk's ops and its no-newline flags, from its body lines. */
function parseHunkBody(a: number, body: string[]): UHunk {
  const ops: Op[] = [];
  for (const b of body) {
    if (b === '') ops.push({ kind: 'ctx', text: '' });
    else if (b[0] === ' ') ops.push({ kind: 'ctx', text: b.slice(1) });
    else if (b[0] === '-') ops.push({ kind: 'del', text: b.slice(1) });
    else if (b[0] === '+') ops.push({ kind: 'add', text: b.slice(1) });
  }
  let lastCtxAdd = -1;
  let lastAdd = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') lastCtxAdd = k;
    if (b[0] === '+') lastAdd = k;
  }
  const follows = (idx: number): boolean =>
    idx >= 0 && idx + 1 < body.length && body[idx + 1]![0] === '\\';
  return { a, ops, noNL: follows(lastCtxAdd), addNoNL: follows(lastAdd) };
}

/** The hunks of a section, applied in order to a file's lines. Each hunk
 *  applies to the result of the ones before it. */
function applyHunks(fs: FileState, hunks: UHunk[], strict: boolean, path: string): FileState {
  let lines = [...fs.lines];
  let ends = fs.ends;
  let d = 0;
  for (const h of hunks) {
    const o = h.ops.filter((x) => x.kind !== 'add').map((x) => x.text);
    const n = h.ops.filter((x) => x.kind !== 'del').map((x) => x.text);
    if (o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = idx === lines.length;
      lines = [...lines.slice(0, idx), ...n, ...lines.slice(idx)];
      if (atEnd) ends = !h.noNL;
      d += n.length;
    } else {
      const found = findOccurrences(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(h.ops, lines, best, found.tier);
      const atEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
      if (atEnd) ends = !h.noNL;
      d += n.length - o.length;
    }
  }
  return { lines, br: fs.br, ends };
}

/** The sections of a unified diff, each one edit. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let pairSet = false;
  const startSection = (): USection => {
    const s: USection = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    pairSet = false;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        const s = startSection();
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        s.pairOld = oldP === '/dev/null' ? null : oldP;
        s.pairNew = newP === '/dev/null' ? null : newP;
        pairSet = true;
      } else if (!pairSet) {
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        cur.pairOld = oldP === '/dev/null' ? null : oldP;
        cur.pairNew = newP === '/dev/null' ? null : newP;
        pairSet = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          j++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(parseHunkBody(parseInt(m[1]!, 10), body));
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as one edit. */
function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldRaw = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.gitOld;
  const newRaw = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.gitNew;
  const oldNamed = oldRaw !== undefined;
  const newNamed = newRaw !== undefined;
  const oldP: string | null = oldNamed ? oldRaw! : null;
  const newP: string | null = newNamed ? newRaw! : oldNamed ? oldRaw! : null;
  const isCreate = (oldNamed && oldP === null) || s.newFile;
  const isDelete = (newNamed && newP === null) || s.delFile;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const add: string[] = [];
      for (const h of s.hunks) {
        for (const op of h.ops) if (op.kind === 'add') add.push(op.text);
      }
      let noNL = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.ops.some((o) => o.kind === 'add')) {
          noNL = h.addNoNL;
          break;
        }
      }
      tree.now.set(newP, add.length === 0 ? '' : add.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '/dev/null');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const res = applyHunks(splitFile(tree.get(oldP)!), s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(res.lines, res.br, res.ends));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) throw new Fail('unsafe', '');
    if (tree.get(p) === null) throw new Fail('missing', p);
    const res = applyHunks(splitFile(tree.get(p)!), s.hunks, strict, p);
    tree.now.set(p, joinFile(res.lines, res.br, res.ends));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let j = i + 1;
      while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
      if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      let k = j + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
      if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
      let path: string | null = null;
      for (let m = i - 1; m > prevEnd; m--) {
        const l = lines[m]!;
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      const oldLines = lines.slice(i + 1, j);
      const newLines = lines.slice(j + 1, k);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = k;
      i = k + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One SEARCH/REPLACE block as one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = splitFile(cur);
    const found = findOccurrences(fs.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const repl = reindentLines(newLines, fs.lines, pos, oldLines[0]!, found.tier);
    const lines = [...fs.lines.slice(0, pos), ...repl, ...fs.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(lines, fs.br, fs.ends));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  /** The anchor text after @@, or null for no anchor. */
  anchor: string | null;
  ops: Op[];
  /** A *** End of File line ended this chunk. */
  eof: boolean;
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const fl: string[] = [];
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (V4A_SECTION(x)) break;
        if (x === '') {
          fl.push('');
          i++;
          continue;
        }
        if (x.startsWith('+')) {
          fl.push(x.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fl.length > 0 && fl[fl.length - 1] === '') fl.pop();
      edits.push(v4aAdd(path, fl));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(16).trim();
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (V4A_SECTION(x)) break;
        if (blank(x)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDelete(path));
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice(16).trim();
      const updateLine = i + 1;
      i++;
      const raw: Array<{ text: string; num: number }> = [];
      while (i < last) {
        const x = lines[i]!;
        if (V4A_SECTION(x)) break;
        raw.push({ text: x, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(v4aUpdate(path, raw, updateLine, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAdd(path: string, fl: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fl.length === 0 ? '' : fl.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as one edit. */
function v4aUpdate(
  path: string,
  raw: Array<{ text: string; num: number }>,
  updateLine: number,
  strict: boolean,
): Edit {
  let idx = 0;
  while (idx < raw.length && blank(raw[idx]!.text)) idx++;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.text.slice(13).trim();
    idx++;
  } else if (idx < raw.length && !raw[idx]!.text.startsWith('@@')) {
    idx = 0;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = idx; k < raw.length; k++) {
    const item = raw[k]!;
    const x = item.text;
    if (x.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: x.slice(2).trim(), ops: [], eof: false };
    } else if (x === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${item.num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
      if (cur === null) cur = { anchor: null, ops: [], eof: false };
      if (x === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (x[0] === ' ') cur.ops.push({ kind: 'ctx', text: x.slice(1) });
      else if (x[0] === '-') cur.ops.push({ kind: 'del', text: x.slice(1) });
      else cur.ops.push({ kind: 'add', text: x.slice(1) });
    } else {
      throw new Exit2(`error: parse ${item.num}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fs = splitFile(curText);
    let lines = [...fs.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findSingleLine(lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = ch.ops.filter((x) => x.kind !== 'add').map((x) => x.text);
      const n = ch.ops.filter((x) => x.kind !== 'del').map((x) => x.text);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
        cursor = at + n.length;
      } else {
        const found = findOccurrences(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const p of found.pos) {
          if (!ch.eof || p + o.length === lines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', path);
        const repl = buildReplacement(ch.ops, lines, pos, found.tier);
        lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
        cursor = pos + repl.length;
      }
    }
    const text = joinFile(lines, fs.br, fs.ends);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC.md sections 1, 2 and 10)                     */
/* ------------------------------------------------------------------ */

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) {
        rmSync(p, { force: true });
        let d = dirname(p);
        while (d !== '.' && d !== '') {
          try {
            rmdirSync(d);
          } catch {
            break;
          }
          d = dirname(d);
        }
      }
    }
    for (const p of [...tree.now.keys()]) {
      const v = tree.now.get(p)!;
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
