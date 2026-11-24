// mend — one command line tool that applies AI-written edits to a tree of
// text files, in the four formats SPEC.md describes: unified diffs,
// SEARCH/REPLACE blocks, V4A patches and JSON tool calls. Every file is
// changed or nothing is. Node 22, standard library only; nothing here calls
// a model, the network, the clock or a random source, so a run is
// deterministic: same patch, same exit code, same stdout, same files.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with
// the working directory as the root of the tree. When MAKEFUN_ENV_URL is
// set, this file hands the run over to runner.ts instead (see the bottom).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse-level failure: exit 2, one line, nothing written. */
class ParseError extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: exit 1, one `error: <code> <path>` line per failure. */
class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (line: string): boolean => line.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, and the empty
 * piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start
 * with `/`, holds no `\`, and none of its `/`-separated segments is empty,
 * `.` or `..`. */
function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileShape {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileShape {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(shape: FileShape): string {
  if (shape.lines.length === 0) return '';
  return shape.lines.join(shape.br) + (shape.finalBreak ? shape.br : '');
}

/** The tree as the edits leave it. `current` reads the tree the edits have
 * made so far; `before` reads what was on disk when the patch started. A
 * path maps to null in `now` when an edit deleted it. */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  before(path: string): string | null {
    if (!this.disk.has(path)) {
      let value: string | null = null;
      try {
        if (statSync(path).isFile()) value = readFileSync(path, 'utf8');
      } catch {
        value = null;
      }
      this.disk.set(path, value);
    }
    return this.disk.get(path)!;
  }

  current(path: string): string | null {
    return this.now.has(path) ? this.now.get(path)! : this.before(path);
  }

  recordMove(from: string, to: string): void {
    this.moves.push({ from, to });
  }
}

/** The file at `path` must exist; its path is checked for safety first. */
function needFile(tree: WorkTree, path: string): string {
  if (!isSafePath(path)) throw new EditError('unsafe', path);
  const text = tree.current(path);
  if (text === null) throw new EditError('missing', path);
  return text;
}

/** One edit: a closure that changes the tree or throws an EditError. */
type Edit = (tree: WorkTree) => void;

/** How a line compares at a tier: 0 exact, 1 trailing spaces/tabs off,
 * 2 leading and trailing spaces/tabs off. */
function tierText(line: string, tier: number): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/, '');
  return tier === 1 ? trimmed : trimmed.replace(/^[ \t]+/, '');
}

function leadingWs(line: string): string {
  const found = /^[ \t]*/.exec(line);
  return found === null ? '' : found[0];
}

/** Every position where `old` occurs in `lines` at `tier`, at or after
 * `from`. Occurrences may overlap. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const spots: number[] = [];
  const last = lines.length - old.length;
  for (let at = from; at <= last; at += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierText(lines[at + j]!, tier) !== tierText(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) spots.push(at);
  }
  return spots;
}

/** The first tier (0, then 1, then 2; only 0 with `--strict`) at which `old`
 * occurs at or after `from`, and every such position — or null. */
function locate(lines: string[], old: string[], from: number, strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots = occurrencesAt(lines, old, tier, from);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** One line of an old/new pair: a context line belongs to both sides, a
 * `+` line only to the new side, a `-` line only to the old side. */
interface Piece {
  text: string;
  context: boolean;
}

/** The lines that replace a matched span. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line
 * is re-indented: the leading spaces/tabs of the old block's first line are
 * swapped for those of the file's first matched line. */
function replacementLines(
  fileLines: string[],
  at: number,
  oldPieces: Piece[],
  newPieces: Piece[],
  tier: number,
): string[] {
  const out: string[] = [];
  const ctxAt: number[] = [];
  oldPieces.forEach((piece, i) => {
    if (piece.context) ctxAt.push(i);
  });
  const oldPad = oldPieces.length > 0 ? leadingWs(oldPieces[0]!.text) : '';
  const filePad = leadingWs(fileLines[at] ?? '');
  let ctxSeen = 0;
  for (const piece of newPieces) {
    if (piece.context) {
      out.push(fileLines[at + ctxAt[ctxSeen]!]!);
      ctxSeen += 1;
      continue;
    }
    if (tier !== 2) {
      out.push(piece.text);
      continue;
    }
    const text = piece.text;
    const onlyWs = /^[ \t]*$/.test(text);
    if (text !== '' && !onlyWs && text.startsWith(oldPad)) out.push(filePad + text.slice(oldPad.length));
    else out.push(text);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not a valid edit. */
function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    const text = obj.file_text;
    return (tree) => {
      if (!isSafePath(path)) throw new EditError('unsafe', path);
      if (tree.current(path) !== null) throw new EditError('exists', path);
      tree.now.set(path, text);
    };
  }

  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, path);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = fold(before);
      const old = fold(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', path);
      if (count > 1) throw new EditError('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + fold(newStr) + text.slice(at + old.length);
      tree.now.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    const lineNo = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return (tree) => {
      const before = needFile(tree, path);
      const shape = parseFile(before);
      if (lineNo < 0 || lineNo > shape.lines.length) throw new EditError('no-match', path);
      shape.lines.splice(lineNo, 0, ...added);
      tree.now.set(path, renderFile(shape));
    };
  }

  return null;
}

/** The JSON edits of a patch: either one array of edit objects, or JSON
 * Lines with one edit object a line. */
function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new ParseError(`error: parse ${first + 1}`);
    for (const item of value) {
      const edit = jsonEdit(item);
      if (edit === null) throw new ParseError(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let edit: Edit | null = null;
    try {
      edit = jsonEdit(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(edit);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditError('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditError('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = needFile(tree, path);
    const shape = parseFile(before);
    const found = locate(shape.lines, oldLines, 0, strict);
    if (found === null) throw new EditError('no-match', path);
    if (found.spots.length > 1) throw new EditError('ambiguous', path);
    const at = found.spots[0]!;
    const oldPieces: Piece[] = oldLines.map((text) => ({ text, context: false }));
    const newPieces: Piece[] = newLines.map((text) => ({ text, context: false }));
    const replacement = replacementLines(shape.lines, at, oldPieces, newPieces, found.tier);
    shape.lines.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, renderFile(shape));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j -= 1) {
      const line = lines[j]!;
      if (isBlank(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseError(`error: parse ${searchAt + 1}`);
    }
    let eqAt = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eqAt = k;
        break;
      }
    }
    if (eqAt < 0) throw new ParseError(`error: parse ${searchAt + 1}`);
    let repAt = -1;
    for (let k = eqAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repAt = k;
        break;
      }
    }
    if (repAt < 0) throw new ParseError(`error: parse ${searchAt + 1}`);
    edits.push(
      searchReplaceEdit(path, lines.slice(searchAt + 1, eqAt), lines.slice(eqAt + 1, repAt), strict),
    );
    prevPath = path;
    prevEnd = repAt + 1;
    i = repAt + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldPieces: Piece[];
  newPieces: Piece[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  headerLine: number;
  /** Add File: the file's lines, `+` already stripped. */
  content: string[];
  /** Update File: the section's chunks, parsed now so a bad line fails
   * the patch before any file is looked at. */
  chunks: V4aChunk[];
}

/** A V4A body line: ` ` context, `-` old, `+` new, or an empty line, which
 * is a context line with empty text. Anything else is not a body line. */
function v4aBodyPiece(line: string): Piece | null {
  if (line === '') return { text: '', context: true };
  if (line[0] === ' ') return { text: line.slice(1), context: true };
  if (line[0] === '-') return { text: line.slice(1), context: false };
  if (line[0] === '+') return { text: line.slice(1), context: false };
  return null;
}

/** Split one Update File section's lines into its chunks. */
function v4aChunks(lines: Array<{ text: string; no: number }>): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  const push = (): void => {
    if (cur !== null) chunks.push(cur);
    cur = null;
  };
  for (const { text, no } of lines) {
    if (text.startsWith('@@')) {
      push();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldPieces: [], newPieces: [] };
      started = true;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new ParseError(`error: parse ${no}`);
      cur.eof = true;
      push();
      continue;
    }
    const piece = v4aBodyPiece(text);
    if (piece === null) throw new ParseError(`error: parse ${no}`);
    if (cur === null) {
      if (started) throw new ParseError(`error: parse ${no}`);
      cur = { anchor: null, eof: false, oldPieces: [], newPieces: [] };
      started = true;
    }
    if (piece.context) {
      cur.oldPieces.push(piece);
      cur.newPieces.push(piece);
    } else if (text[0] === '-') {
      cur.oldPieces.push(piece);
    } else {
      cur.newPieces.push(piece);
    }
  }
  push();
  return chunks;
}

/** Apply one chunk to a file shape; returns the cursor after the lines it
 * wrote. */
function applyV4aChunk(shape: FileShape, chunk: V4aChunk, cursor: number, strict: boolean, path: string): number {
  if (chunk.anchor !== null) {
    const found = locate(shape.lines, [chunk.anchor], cursor, strict);
    if (found === null) throw new EditError('no-match', path);
    cursor = found.spots[0]! + 1;
  }
  const oldTexts = chunk.oldPieces.map((p) => p.text);
  if (oldTexts.length > 0) {
    const found = locate(shape.lines, oldTexts, cursor, strict);
    if (found === null) throw new EditError('no-match', path);
    let spots = found.spots;
    if (chunk.eof) spots = spots.filter((s) => s + oldTexts.length === shape.lines.length);
    if (spots.length === 0) throw new EditError('no-match', path);
    const at = spots[0]!;
    const replacement = replacementLines(shape.lines, at, chunk.oldPieces, chunk.newPieces, found.tier);
    shape.lines.splice(at, oldTexts.length, ...replacement);
    return at + replacement.length;
  }
  const at = chunk.eof ? shape.lines.length : cursor;
  const replacement = replacementLines(shape.lines, at, [], chunk.newPieces, 0);
  shape.lines.splice(at, 0, ...replacement);
  return at + replacement.length;
}

function v4aEdit(section: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const path = section.path;
    if (!isSafePath(path)) throw new EditError('unsafe', path);
    if (section.kind === 'add') {
      if (tree.current(path) !== null) throw new EditError('exists', path);
      const content = section.content;
      tree.now.set(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      return;
    }
    if (section.kind === 'delete') {
      if (tree.current(path) === null) throw new EditError('missing', path);
      tree.now.set(path, null);
      return;
    }
    // Update File.
    const moveTo = section.moveTo;
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditError('unsafe', moveTo);
    const before = needFile(tree, path);
    if (moveTo !== null && tree.current(moveTo) !== null) throw new EditError('exists', moveTo);
    const shape = parseFile(before);
    let cursor = 0;
    for (const chunk of section.chunks) cursor = applyV4aChunk(shape, chunk, cursor, strict, path);
    const out = renderFile(shape);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new ParseError(`error: parse ${lines.length + 1}`);
  }
  const headerOf = (line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    for (const [prefix, kind] of [
      ['*** Add File: ', 'add'],
      ['*** Delete File: ', 'delete'],
      ['*** Update File: ', 'update'],
    ] as const) {
      if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length).trim() };
    }
    return null;
  };
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const header = headerOf(line);
    if (header === null) throw new ParseError(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const body: Array<{ text: string; no: number }> = [];
    i += 1;
    while (i < last && headerOf(lines[i]!) === null) {
      body.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
    let moveTo: string | null = null;
    let content = body;
    if (header.kind === 'update' && body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = body[0]!.text.slice('*** Move to: '.length).trim();
      content = body.slice(1);
    }
    if (header.kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, no } of content) {
        if (text === '') fileLines.push('');
        else if (text[0] === '+') fileLines.push(text.slice(1));
        else throw new ParseError(`error: parse ${no}`);
      }
      sections.push({ kind: 'add', path: header.path, moveTo: null, headerLine, content: fileLines, chunks: [] });
    } else if (header.kind === 'delete') {
      for (const { text, no } of content) {
        if (!isBlank(text)) throw new ParseError(`error: parse ${no}`);
      }
      sections.push({ kind: 'delete', path: header.path, moveTo: null, headerLine, content: [], chunks: [] });
    } else {
      const chunks = v4aChunks(content);
      if (chunks.length === 0 && moveTo === null) throw new ParseError(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path: header.path, moveTo, headerLine, content: [], chunks });
    }
  }
  return sections.map((section) => v4aEdit(section, strict));
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type RawKind = 'ctx' | 'old' | 'new' | 'slash';
interface RawLine {
  kind: RawKind;
  text: string;
}

interface UniHunk {
  start: number;
  oldPieces: Piece[];
  newPieces: Piece[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line; null when it has none. */
  lastPlusNoEol: boolean | null;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  pairSeen: boolean;
  hunks: UniHunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEAD = /^diff --git a\/(.+) b\/(.+)$/;

/** A hunk body line, or null when the line is not one. */
function bodyLine(line: string): RawLine | null {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0];
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  if (c === '\\') return { kind: 'slash', text: '' };
  return null;
}

/** Finish a hunk body: drop its trailing empty lines, split it into old
 * and new pieces, and note where a `\` line follows the last context or
 * `+` line (and where one follows the last `+` line). */
function finishHunk(body: RawLine[], start: number): UniHunk {
  let end = body.length;
  while (end > 0 && body[end - 1]!.kind === 'ctx' && body[end - 1]!.text === '') end -= 1;
  const kept = body.slice(0, end);
  const oldPieces: Piece[] = [];
  const newPieces: Piece[] = [];
  for (const raw of kept) {
    if (raw.kind === 'ctx') {
      oldPieces.push({ text: raw.text, context: true });
      newPieces.push({ text: raw.text, context: true });
    } else if (raw.kind === 'old') {
      oldPieces.push({ text: raw.text, context: false });
    } else if (raw.kind === 'new') {
      newPieces.push({ text: raw.text, context: false });
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  kept.forEach((raw, idx) => {
    if (raw.kind === 'ctx' || raw.kind === 'new') lastCtxPlus = idx;
    if (raw.kind === 'new') lastPlus = idx;
  });
  return {
    start,
    oldPieces,
    newPieces,
    noEol: lastCtxPlus >= 0 && kept[lastCtxPlus + 1]?.kind === 'slash',
    lastPlusNoEol: lastPlus < 0 ? null : kept[lastPlus + 1]?.kind === 'slash',
  };
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or null when the line is
 * not of that form. */
function gitHeadPaths(line: string): { old: string; next: string } | null {
  const found = GIT_HEAD.exec(line.trimEnd());
  if (found === null) return null;
  return { old: found[1]!, next: found[2]! };
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed, a
 * leading `a/` or `b/` removed, `/dev/null` meaning no file. */
function headerPath(line: string): string | null {
  const cut = line.slice(4).split('\t')[0]!;
  const p = cut.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Apply one section's hunks, in order, to a file's text. */
function applyHunks(before: string, hunks: UniHunk[], strict: boolean, path: string): FileShape {
  const shape = parseFile(before);
  let d = 0;
  for (const hunk of hunks) {
    const oldTexts = hunk.oldPieces.map((p) => p.text);
    if (oldTexts.length > 0) {
      const found = locate(shape.lines, oldTexts, 0, strict);
      if (found === null) throw new EditError('no-match', path);
      const target = hunk.start - 1 + d;
      let best = found.spots[0]!;
      for (const spot of found.spots) {
        if (Math.abs(spot - target) < Math.abs(best - target)) best = spot;
      }
      const replacement = replacementLines(shape.lines, best, hunk.oldPieces, hunk.newPieces, found.tier);
      const touchesEnd = best + oldTexts.length === shape.lines.length;
      shape.lines.splice(best, oldTexts.length, ...replacement);
      if (touchesEnd) shape.finalBreak = !hunk.noEol;
    } else {
      const at = Math.max(0, Math.min(hunk.start + d, shape.lines.length));
      const atEnd = at === shape.lines.length;
      const replacement = replacementLines(shape.lines, at, hunk.oldPieces, hunk.newPieces, 0);
      shape.lines.splice(at, 0, ...replacement);
      if (atEnd) shape.finalBreak = !hunk.noEol;
    }
    d += hunk.newPieces.length - hunk.oldPieces.length;
  }
  return shape;
}

function unifiedEdit(section: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    const create = section.createFlag || oldP === null;
    const remove = section.deleteFlag || newP === null;
    if (create) {
      if (newP === null) return;
      if (!isSafePath(newP)) throw new EditError('unsafe', newP);
      if (tree.current(newP) !== null) throw new EditError('exists', newP);
      const content: string[] = [];
      let lastNoEol: boolean | null = null;
      for (const hunk of section.hunks) {
        for (const piece of hunk.newPieces) {
          if (!piece.context) content.push(piece.text);
        }
        if (hunk.lastPlusNoEol !== null) lastNoEol = hunk.lastPlusNoEol;
      }
      tree.now.set(newP, content.length === 0 ? '' : content.join('\n') + (lastNoEol === true ? '' : '\n'));
      return;
    }
    if (remove) {
      if (oldP === null) return;
      if (!isSafePath(oldP)) throw new EditError('unsafe', oldP);
      if (tree.current(oldP) === null) throw new EditError('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!isSafePath(oldP!)) throw new EditError('unsafe', oldP!);
      if (!isSafePath(newP!)) throw new EditError('unsafe', newP!);
      const before = needFile(tree, oldP!);
      if (tree.current(newP!) !== null) throw new EditError('exists', newP!);
      const shape = applyHunks(before, section.hunks, strict, oldP!);
      tree.now.set(newP!, renderFile(shape));
      tree.now.set(oldP!, null);
      tree.recordMove(oldP!, newP!);
      return;
    }
    const before = needFile(tree, oldP!);
    const shape = applyHunks(before, section.hunks, strict, oldP!);
    tree.now.set(oldP!, renderFile(shape));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunkBody: RawLine[] = [];
  let hunkStart = 0;
  let inHunk = false;
  let state: 'out' | 'head' | 'body' | 'after' = 'out';

  const freshSection = (oldPath: string | null, newPath: string | null): UniSection => ({
    oldPath,
    newPath,
    createFlag: false,
    deleteFlag: false,
    pairSeen: false,
    hunks: [],
  });
  const closeHunk = (): void => {
    if (sec !== null && inHunk) sec.hunks.push(finishHunk(hunkBody, hunkStart));
    hunkBody = [];
    inHunk = false;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const startHunk = (line: string, no: number): void => {
    const found = HUNK_HEAD.exec(line);
    if (found === null) throw new ParseError(`error: parse ${no}`);
    hunkStart = Number(found[1]);
    hunkBody = [];
    inHunk = true;
    state = 'body';
  };
  const startGitSection = (line: string, no: number): void => {
    const git = gitHeadPaths(line);
    if (git === null) throw new ParseError(`error: parse ${no}`);
    closeSection();
    sec = freshSection(git.old, git.next);
    state = 'head';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (state === 'out') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, no);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = freshSection(headerPath(line), headerPath(lines[i + 1]!));
        sec.pairSeen = true;
        state = 'head';
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseError(`error: parse ${no}`);
      i += 1;
      continue;
    }
    if (state === 'head') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, no);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec!.pairSeen) {
            closeSection();
            sec = freshSection(headerPath(line), headerPath(lines[i + 1]!));
            sec.pairSeen = true;
          } else {
            sec!.oldPath = headerPath(line);
            sec!.newPath = headerPath(lines[i + 1]!);
            sec!.pairSeen = true;
          }
          i += 2;
          continue;
        }
        throw new ParseError(`error: parse ${no + 1}`);
      }
      if (line.startsWith('rename from ')) {
        if (!sec!.pairSeen) sec!.oldPath = line.slice('rename from '.length).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!sec!.pairSeen) sec!.newPath = line.slice('rename to '.length).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec!.createFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec!.deleteFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, no);
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        startGitSection(line, no);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeSection();
        sec = freshSection(headerPath(line), headerPath(lines[i + 1]!));
        sec.pairSeen = true;
        state = 'head';
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        closeHunk();
        startHunk(line, no);
        i += 1;
        continue;
      }
      const raw = bodyLine(line);
      if (raw !== null) {
        hunkBody.push(raw);
        i += 1;
        continue;
      }
      closeHunk();
      state = 'after';
      continue;
    }
    // state === 'after': between hunks of a section.
    if (line.startsWith('diff --git ')) {
      startGitSection(line, no);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      closeSection();
      sec = freshSection(headerPath(line), headerPath(lines[i + 1]!));
      sec.pairSeen = true;
      state = 'head';
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      startHunk(line, no);
      i += 1;
      continue;
    }
    i += 1;
  }
  closeSection();
  return sections.map((section) => unifiedEdit(section, strict));
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4), the run, and the trial    */
/* hand-over                                                           */
/* ------------------------------------------------------------------ */

/** With `--format=auto` the format is the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return parseJsonEdits(text, lines);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines, strict);
  return parseUnified(lines, strict);
}

interface RunResult {
  code: number;
  out: string[];
}

function usageResult(): RunResult {
  return { code: 2, out: ['error: usage'] };
}

function runCli(args: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const value = arg.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(value)) return usageResult();
        format = value;
      } else if (arg === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (arg === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return usageResult();

  const patchArg = positional.length === 0 ? null : positional[0]!;
  const fromStdin = patchArg === null || patchArg === '-';
  let patchText = '';
  try {
    patchText = readFileSync(fromStdin ? 0 : patchArg, 'utf8');
  } catch {
    if (!fromStdin) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = splitPatch(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = parsePatch(kind, patchText, lines, strict);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new WorkTree();
  const failures: EditError[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesKept = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = movesKept;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }

  // What changed, one line per path in byte order of the paths; a move
  // sorts by its new path and replaces that pair's `D` and `A` lines.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const move of tree.moves) {
    const wasFrom = tree.before(move.from);
    const nowFrom = tree.current(move.from);
    const wasTo = tree.before(move.to);
    const nowTo = tree.current(move.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: move.to, text: `R ${move.from} -> ${move.to}` });
      movedFrom.add(move.from);
      movedTo.add(move.to);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
  for (const path of changed) {
    const was = tree.before(path);
    const now = tree.now.get(path)!;
    if (was === now) continue;
    if (movedFrom.has(path) || movedTo.has(path)) continue;
    rows.push({ key: path, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    for (const path of changed) {
      const was = tree.before(path);
      const now = tree.now.get(path)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, now, 'utf8');
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((line) => `${line}\n`).join(''));
  process.exitCode = result.code;
}
