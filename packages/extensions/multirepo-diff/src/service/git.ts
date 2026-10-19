/**
 * Git plumbing for the multirepo-diff guest service (TICKET-HARNESS-40).
 *
 * Every call is a real `git` child process (`execFile`, never a shell) bound to
 * an explicit `cwd`, with a hard timeout and SIGKILL so a wedged repository can
 * never leave an orphan process behind (POSIX discipline: no zombie children).
 * Reads set `GIT_OPTIONAL_LOCKS=0` so we never take optional locks on
 * repositories another agent is actively writing to.
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { DiffHunk, DiffLine, FileStatus } from './contract.ts';

const GIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OPENCHAMBER_MULTIREPO_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Patch materialization caps (per file). */
export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 20_000;
/** Untracked files are read from disk up to this size to synthesize a diff. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(args: readonly string[], cwd: string, message: string, exitCode: number | null, stderr = '', timedOut = false) {
    super(message);
    this.name = 'GitCommandError';
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  LC_ALL: 'C',
  LANG: 'C',
});

/** Runs git and always resolves with the exit code; rejects only on spawn failure/timeout. */
export const runGit = (args: readonly string[], cwd: string): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_MAX_BUFFER,
        env: gitEnv(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (failure.killed === true) {
            reject(
              new GitCommandError(
                args,
                cwd,
                `git ${args[0] ?? ''} timed out after ${GIT_TIMEOUT_MS}ms`,
                null,
                err,
                true,
              ),
            );
            return;
          }
          if (typeof failure.code === 'number') {
            resolve({ stdout: out, stderr: err, code: failure.code });
            return;
          }
          reject(
            new GitCommandError(args, cwd, `git ${args.join(' ')}: ${failure.message}`, null, err),
          );
          return;
        }
        resolve({ stdout: out, stderr: err, code: 0 });
      },
    );
  });

const mustGit = async (args: readonly string[], cwd: string): Promise<GitResult> => {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new GitCommandError(
      args,
      cwd,
      `git ${args.join(' ')} exited with ${result.code}: ${result.stderr.trim() || 'no stderr'}`,
      result.code,
      result.stderr,
    );
  }
  return result;
};

const firstLine = (value: string): string => value.split('\n', 1)[0]?.trim() ?? '';

/* ------------------------------------------------------------------ *
 * Repository discovery
 * ------------------------------------------------------------------ */

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
};

/** Nearest existing ancestor (deleted files still have a live parent directory). */
export const findExistingAncestor = async (target: string): Promise<string | null> => {
  let current = path.resolve(target);
  for (let depth = 0; depth < 256; depth += 1) {
    if (await pathExists(current)) {
      const stat = await fsp.stat(current).catch(() => null);
      if (stat?.isDirectory()) return current;
      return path.dirname(current);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
};

const rootCache = new Map<string, string | null>();

/**
 * Positive results are cached per directory. A cached *positive* root is also
 * valid for any descendant directory (walk up the chain before spawning git).
 * Negative results are not propagated: a nested repository can live under a
 * directory that itself is not one, so only exact lookups may reuse a null.
 */
const cachedRootForAncestor = (ancestor: string): string | null | undefined => {
  let current = path.resolve(ancestor);
  for (let depth = 0; depth < 64; depth += 1) {
    const cached = rootCache.get(current);
    if (typeof cached === 'string') return cached;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

/** Resolves the enclosing git repository root for an absolute path, or null. */
export const resolveRepoRoot = async (absolutePath: string): Promise<string | null> => {
  const ancestor = await findExistingAncestor(path.resolve(absolutePath));
  if (!ancestor) return null;
  if (rootCache.has(ancestor)) return rootCache.get(ancestor) ?? null;
  const inherited = cachedRootForAncestor(ancestor);
  if (inherited !== undefined) {
    rootCache.set(ancestor, inherited);
    return inherited;
  }
  let root: string | null = null;
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], ancestor);
    if (result.code === 0) {
      const candidate = result.stdout.trim();
      root = candidate === '' ? null : path.resolve(candidate);
    }
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    root = null;
  }
  rootCache.set(ancestor, root);
  return root;
};

/** Converts a repo-relative path to POSIX separators. */
export const toPosix = (value: string): string => value.split(path.sep).join('/');

export const isInside = (root: string, candidate: string): boolean => {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(candidate);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}${path.sep}`);
};

/* ------------------------------------------------------------------ *
 * Status / HEAD / branch
 * ------------------------------------------------------------------ */

export interface StatusEntry {
  path: string;
  previousPath: string | null;
  code: string;
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * In `-z` mode a rename/copy record is `"XY <new>"` followed by a separate
 * NUL-terminated field holding the original path (verified against git 2.43).
 */
export const parseStatusZ = (raw: string): StatusEntry[] => {
  const tokens = raw.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    let previousPath: string | null = null;
    if (code[0] === 'R' || code[0] === 'C') {
      const origin = tokens[index + 1];
      if (origin !== undefined) {
        previousPath = origin;
        index += 1;
      }
    }
    entries.push({ path: filePath, previousPath, code });
  }
  return entries;
};

export const readStatus = async (root: string): Promise<Map<string, StatusEntry>> => {
  const result = await mustGit(
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    root,
  );
  const map = new Map<string, StatusEntry>();
  for (const entry of parseStatusZ(result.stdout)) map.set(entry.path, entry);
  return map;
};

export const readStatusOf = async (root: string, relativePath: string): Promise<StatusEntry | null> => {
  const result = await mustGit(
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', relativePath],
    root,
  );
  return parseStatusZ(result.stdout)[0] ?? null;
};

export const normalizeStatus = (code: string | null): FileStatus => {
  if (!code) return 'clean';
  if (code === '??') return 'untracked';
  const index = code[0] ?? ' ';
  const worktree = code[1] ?? ' ';
  if (index === 'U' || worktree === 'U' || code === 'AA' || code === 'DD') return 'unmerged';
  if (index === 'R' || worktree === 'R') return 'renamed';
  if (index === 'C' || worktree === 'C') return 'copied';
  if (index === 'A' || worktree === 'A') return 'added';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'M' || worktree === 'M' || index === 'T' || worktree === 'T') return 'modified';
  return 'clean';
};

export const hasHead = async (root: string): Promise<boolean> => {
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  return result.code === 0;
};

export const readHead = async (root: string): Promise<string | null> => {
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  return result.code === 0 ? firstLine(result.stdout) || null : null;
};

export const readBranch = async (root: string): Promise<string | null> => {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (result.code !== 0) return null;
  const branch = firstLine(result.stdout);
  return branch === '' || branch === 'HEAD' ? null : branch;
};

/* ------------------------------------------------------------------ *
 * numstat (line counts) and untracked files
 * ------------------------------------------------------------------ */

export interface NumStat {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

const parseNumStat = (raw: string): Map<string, NumStat> => {
  const map = new Map<string, NumStat>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const added = line.slice(0, firstTab);
    const removed = line.slice(firstTab + 1, secondTab);
    const filePath = line.slice(secondTab + 1);
    if (added === '-' || removed === '-') {
      map.set(filePath, { additions: null, deletions: null, binary: true });
      continue;
    }
    const additions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(removed, 10);
    map.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: false,
    });
  }
  return map;
};

/**
 * Line counts vs HEAD for a set of repo-relative paths.
 * `--no-renames` keeps one line per path (renames become delete+add), which is
 * exactly what a per-file diff view needs.
 */
export const readNumStat = async (
  root: string,
  relativePaths: readonly string[],
  headExists: boolean,
): Promise<Map<string, NumStat>> => {
  if (relativePaths.length === 0) return new Map();
  const pathspec = ['--', ...relativePaths];
  if (headExists) {
    const result = await runGit(['diff', '--numstat', '--no-renames', 'HEAD', ...pathspec], root);
    if (result.code === 0) return parseNumStat(result.stdout);
    return new Map();
  }
  const staged = await runGit(['diff', '--numstat', '--no-renames', '--cached', ...pathspec], root);
  const worktree = await runGit(['diff', '--numstat', '--no-renames', ...pathspec], root);
  const merged = parseNumStat(staged.stdout);
  for (const [filePath, stat] of parseNumStat(worktree.stdout)) {
    const existing = merged.get(filePath);
    if (!existing) {
      merged.set(filePath, stat);
      continue;
    }
    merged.set(filePath, {
      additions: existing.additions === null || stat.additions === null ? null : existing.additions + stat.additions,
      deletions: existing.deletions === null || stat.deletions === null ? null : existing.deletions + stat.deletions,
      binary: existing.binary || stat.binary,
    });
  }
  return merged;
};

export interface TextFileInfo {
  binary: boolean;
  lines: number;
  text: string | null;
  truncated: boolean;
}

/** Reads a file (capped) and classifies it as text or binary. */
export const readTextFileCapped = async (
  absolutePath: string,
  maxBytes = MAX_TEXT_FILE_BYTES,
): Promise<TextFileInfo> => {
  const handle = await fsp.open(absolutePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const binary = buffer.includes(0);
    if (binary) return { binary: true, lines: 0, text: null, truncated: stat.size > maxBytes };
    let text = buffer.toString('utf8');
    if (stat.size > maxBytes) text = text.replace(/\uFFFD$/, '');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { binary: false, lines, text, truncated: stat.size > maxBytes };
  } finally {
    await handle.close();
  }
};

/** Builds a plausible unified diff for an untracked file (git has none). */
export const synthesizeUntrackedPatch = (relativePath: string, text: string): string => {
  if (text === '') return '';
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  return `${[...header, ...lines.map((line) => `+${line}`)].join('\n')}\n`;
};

/* ------------------------------------------------------------------ *
 * Patch materialization
 * ------------------------------------------------------------------ */

const truncateUtf8 = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const slice = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
  const cut = slice.lastIndexOf('\n');
  return { text: cut > 0 ? slice.slice(0, cut + 1) : slice, truncated: true };
};

export interface PatchResult {
  patch: string;
  truncated: boolean;
}

/** Unified patch for one path, honoring the requested view. */
export const buildPatch = async (
  root: string,
  relativePath: string,
  view: 'combined' | 'staged' | 'worktree',
  contextLines: number,
): Promise<PatchResult> => {
  const base = ['diff', '--no-color', '--no-ext-diff', `-U${contextLines}`];
  const pathspec = ['--', relativePath];
  let patch = '';
  if (view === 'staged') {
    const result = await runGit([...base, '--cached', ...pathspec], root);
    patch = result.code === 0 ? result.stdout : '';
  } else if (view === 'worktree') {
    const result = await runGit([...base, ...pathspec], root);
    patch = result.code === 0 ? result.stdout : '';
  } else if (await hasHead(root)) {
    const result = await runGit([...base, 'HEAD', ...pathspec], root);
    patch = result.code === 0 ? result.stdout : '';
  } else {
    // Unborn HEAD: staged additions plus worktree edits, concatenated.
    const staged = await runGit([...base, '--cached', ...pathspec], root);
    const worktree = await runGit([...base, ...pathspec], root);
    patch = `${staged.code === 0 ? staged.stdout : ''}${worktree.code === 0 ? worktree.stdout : ''}`;
  }
  const capped = truncateUtf8(patch, MAX_PATCH_BYTES);
  return { patch: capped.text, truncated: capped.truncated };
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parses a unified diff into structured hunks for the panel. */
export const parseUnifiedDiff = (
  patch: string,
  maxLines = MAX_DIFF_LINES,
): { hunks: DiffHunk[]; truncated: boolean } => {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  let emitted = 0;
  let truncated = false;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = {
        header: raw,
        oldStart: Number.parseInt(header[1] ?? '0', 10),
        oldLines: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart: Number.parseInt(header[3] ?? '0', 10),
        newLines: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        lines: [],
      };
      oldNumber = current.oldStart;
      newNumber = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    if (raw === '') continue;
    if (marker === '\\') {
      current.lines.push({ type: 'meta', text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
    if (emitted >= maxLines) {
      truncated = true;
      break;
    }
    const text = raw.slice(1);
    let line: DiffLine;
    if (marker === '+') {
      line = { type: 'add', text, oldNumber: null, newNumber };
      newNumber += 1;
    } else if (marker === '-') {
      line = { type: 'del', text, oldNumber, newNumber: null };
      oldNumber += 1;
    } else {
      line = { type: 'context', text, oldNumber, newNumber };
      oldNumber += 1;
      newNumber += 1;
    }
    current.lines.push(line);
    emitted += 1;
  }
  return { hunks, truncated };
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  xml: 'xml',
  svg: 'xml',
  txt: 'text',
  lock: 'text',
};

export const languageFor = (relativePath: string): string => {
  const base = path.basename(relativePath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const extension = path.extname(base).replace(/^\./, '');
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text';
};

/* ------------------------------------------------------------------ *
 * Revert
 * ------------------------------------------------------------------ */

const isTrackedInHead = async (root: string, relativePath: string): Promise<boolean> => {
  const result = await runGit(['ls-tree', '-z', '--name-only', 'HEAD', '--', relativePath], root);
  if (result.code !== 0) return false;
  return result.stdout.split('\0').includes(relativePath);
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
};

const unstage = async (root: string, relativePath: string, headExists: boolean): Promise<void> => {
  if (headExists) {
    await runGit(['reset', '-q', 'HEAD', '--', relativePath], root);
    return;
  }
  await runGit(['rm', '-q', '--cached', '--ignore-unmatch', '--', relativePath], root);
};

const restoreFromHead = async (root: string, relativePath: string): Promise<RevertOutcomeKind> => {
  if (await isTrackedInHead(root, relativePath)) {
    const result = await runGit(['restore', '--source=HEAD', '--worktree', '--', relativePath], root);
    if (result.code !== 0) {
      throw new GitCommandError(
        ['restore', '--source=HEAD', '--worktree', '--', relativePath],
        root,
        `cannot restore ${relativePath}: ${result.stderr.trim() || 'git restore failed'}`,
        result.code,
        result.stderr,
      );
    }
    return 'restored';
  }
  const absolute = path.join(root, relativePath);
  if (await exists(absolute)) {
    await fsp.rm(absolute, { force: true });
    return 'deleted';
  }
  return 'unchanged';
};

export type RevertOutcomeKind = 'restored' | 'deleted' | 'unchanged';

/**
 * Reverts one path to HEAD in three deterministic steps:
 *   1. unstage (reset HEAD, or `rm --cached` on an unborn branch);
 *   2. tracked in HEAD -> `git restore --source=HEAD --worktree`;
 *      otherwise -> delete the on-disk file (it only existed as an addition);
 *   3. verify with `git status` that the path is clean again.
 *
 * A rename is reverted as a pair: the new path plus its recorded origin.
 */
export const revertFile = async (
  root: string,
  relativePath: string,
  previousPath: string | null,
  headExists: boolean,
): Promise<RevertOutcomeKind> => {
  await unstage(root, relativePath, headExists);
  let action = await restoreFromHead(root, relativePath);

  if (previousPath && previousPath !== relativePath) {
    await unstage(root, previousPath, headExists);
    const originAction = await restoreFromHead(root, previousPath);
    if (action === 'unchanged') action = originAction;
  }

  const remaining = await readStatusOf(root, relativePath);
  if (remaining) {
    throw new GitCommandError(
      ['status', '--porcelain', '--', relativePath],
      root,
      `path still dirty after revert: ${relativePath} (${remaining.code})`,
      1,
    );
  }
  if (previousPath && previousPath !== relativePath) {
    const originRemaining = await readStatusOf(root, previousPath);
    if (originRemaining) {
      throw new GitCommandError(
        ['status', '--porcelain', '--', previousPath],
        root,
        `rename origin still dirty after revert: ${previousPath} (${originRemaining.code})`,
        1,
      );
    }
  }
  return action;
};

/** Clears the repository-root cache (tests and long-lived services). */
export const resetRepoRootCache = (): void => {
  rootCache.clear();
};
