/**
 * Multirepo-diff guest service (TICKET-HARNESS-40).
 *
 * Runs under the host Node runtime on 127.0.0.1 and is only reachable through
 * the OpenChamber service proxy (CONTRACT_MULTIREPO §2). Public surface:
 *
 *   GET  /health
 *   GET  /api/multirepo/rooms?status=active|archived|all&refresh=1
 *   GET  /api/multirepo/diff?room=&repo=&file=&view=&context=
 *   POST /api/multirepo/revert   { room, scope?, repo?, file? }
 *
 * Every path is validated against the room ledger and resolved inside a real
 * git repository before it is read or mutated. Nothing outside a repository
 * touched by the room can be reached through this service.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type {
  DiffResponse,
  DiffView,
  FileStatus,
  RepoCounts,
  RepoEntry,
  RepoFileEntry,
  RevertResponse,
  RevertScope,
  RevertSkip,
  RevertTargetResult,
  RoomEntry,
  RoomFileError,
  RoomsResponse,
} from './contract.ts';
import {
  buildPatch,
  isInside,
  languageFor,
  normalizeStatus,
  parseUnifiedDiff,
  readHead,
  readBranch,
  readNumStat,
  readStatus,
  readTextFileCapped,
  resolveRepoRoot,
  revertFile,
  synthesizeUntrackedPatch,
  toPosix,
  hasHead,
  type StatusEntry,
} from './git.ts';
import { LedgerUnavailableError, readLedger, type LedgerRoom, type RoomStatusFilter } from './ledger.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '');
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROOM_ERRORS = 20;
const MAX_FILES_PER_REPO = 5_000;
const ROOMS_CACHE_TTL_MS = 2_000;

/* ------------------------------------------------------------------ *
 * HTTP primitives
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

// Explicit function type so TypeScript narrows code after guard clauses.
const fail: (status: number, code: string, message: string) => never = (status, code, message) => {
  throw new HttpError(status, code, message);
};

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
  });
  res.end(payload);
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, 'invalid-payload', 'request body exceeds the size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });

const requiredQuery = (url: URL, name: string): string => {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    fail(400, `missing-${name}`, `query parameter "${name}" is required`);
  }
  return value;
};

const isoFromMs = (value: number): string => new Date(value > 0 ? value : 0).toISOString();

/* ------------------------------------------------------------------ *
 * Repository snapshot (per request, memoized by root)
 * ------------------------------------------------------------------ */

interface RepoContext {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  headExists: boolean;
  status: Map<string, StatusEntry>;
  error: string | null;
}

const loadRepoContext = async (root: string): Promise<RepoContext> => {
  const name = path.basename(root);
  try {
    const [branch, head, headExists, status] = await Promise.all([
      readBranch(root),
      readHead(root),
      hasHead(root),
      readStatus(root),
    ]);
    return { root, name, branch, head, headExists, status, error: null };
  } catch (error) {
    return {
      root,
      name,
      branch: null,
      head: null,
      headExists: false,
      status: new Map(),
      error: `cannot read git status: ${(error as Error).message}`,
    };
  }
};

const createContextCache = (): ((root: string) => Promise<RepoContext>) => {
  const cache = new Map<string, Promise<RepoContext>>();
  return (root) => {
    const cached = cache.get(root);
    if (cached) return cached;
    const pending = loadRepoContext(root);
    cache.set(root, pending);
    return pending;
  };
};

/* ------------------------------------------------------------------ *
 * Room ledger -> hierarchical repository tree
 * ------------------------------------------------------------------ */

const emptyCounts = (): RepoCounts => ({
  files: 0,
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
  untracked: 0,
  clean: 0,
});

const countStatus = (counts: RepoCounts, status: FileStatus): void => {
  counts.files += 1;
  switch (status) {
    case 'added':
      counts.added += 1;
      break;
    case 'modified':
      counts.modified += 1;
      break;
    case 'deleted':
      counts.deleted += 1;
      break;
    case 'renamed':
    case 'copied':
      counts.renamed += 1;
      break;
    case 'untracked':
      counts.untracked += 1;
      break;
    default:
      counts.clean += 1;
  }
};

interface FileTarget {
  absolutePath: string;
  relativePath: string;
}

const buildFileEntry = async (
  target: FileTarget,
  context: RepoContext,
  numStat: Awaited<ReturnType<typeof readNumStat>>,
): Promise<RepoFileEntry> => {
  const entry = context.status.get(target.relativePath) ?? null;
  const status = normalizeStatus(entry?.code ?? null);
  const code = entry?.code ?? null;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  if (status === 'untracked') {
    try {
      const info = await readTextFileCapped(target.absolutePath);
      binary = info.binary;
      additions = info.binary ? 0 : info.lines;
    } catch {
      additions = 0;
    }
  } else {
    const stat = numStat.get(target.relativePath);
    if (stat) {
      additions = stat.additions ?? 0;
      deletions = stat.deletions ?? 0;
      binary = stat.binary;
    }
  }
  return {
    path: target.relativePath,
    absolutePath: target.absolutePath,
    status,
    code,
    staged: code !== null && code !== '??' && code[0] !== ' ',
    unstaged: code === '??' || (code !== null && code[1] !== ' '),
    additions: binary ? null : additions,
    deletions: binary ? null : deletions,
    binary,
    previousPath: entry?.previousPath ?? null,
  };
};

const buildRepoEntry = async (
  root: string,
  targets: readonly FileTarget[],
  context: RepoContext,
): Promise<RepoEntry> => {
  if (context.error !== null) {
    return {
      root,
      name: context.name,
      branch: null,
      head: null,
      dirty: false,
      files: [],
      counts: emptyCounts(),
      truncatedFiles: 0,
      error: context.error,
    };
  }
  const limited = targets.slice(0, MAX_FILES_PER_REPO);
  const numStat = await readNumStat(
    root,
    limited.map((target) => target.relativePath),
    context.headExists,
  );
  const files: RepoFileEntry[] = [];
  const counts = emptyCounts();
  for (const target of limited) {
    const file = await buildFileEntry(target, context, numStat);
    countStatus(counts, file.status);
    files.push(file);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const dirty = counts.files - counts.clean > 0;
  return {
    root,
    name: context.name,
    branch: context.branch,
    head: context.head,
    dirty,
    files,
    counts,
    truncatedFiles: Math.max(0, targets.length - limited.length),
    error: null,
  };
};

const buildRoom = async (
  ledgerRoom: LedgerRoom,
  ledgerFiles: readonly string[],
  getContext: (root: string) => Promise<RepoContext>,
): Promise<RoomEntry> => {
  const grouped = new Map<string, FileTarget[]>();
  const errors: RoomFileError[] = [];
  let droppedErrors = 0;
  const seen = new Set<string>();

  for (const recorded of ledgerFiles) {
    const absolutePath = path.resolve(recorded);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    const root = await resolveRepoRoot(absolutePath);
    if (!root) {
      if (errors.length < MAX_ROOM_ERRORS) errors.push({ path: absolutePath, reason: 'not-a-git-repository' });
      else droppedErrors += 1;
      continue;
    }
    const relativePath = toPosix(path.relative(root, absolutePath));
    if (relativePath === '' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
      if (errors.length < MAX_ROOM_ERRORS) errors.push({ path: absolutePath, reason: 'outside-repository' });
      else droppedErrors += 1;
      continue;
    }
    const list = grouped.get(root);
    const target: FileTarget = { absolutePath, relativePath };
    if (list) list.push(target);
    else grouped.set(root, [target]);
  }

  const repos = await Promise.all(
    [...grouped].map(async ([root, targets]) => buildRepoEntry(root, targets, await getContext(root))),
  );
  repos.sort((left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root));

  if (droppedErrors > 0) {
    errors.push({ path: '', reason: `${droppedErrors} additional paths omitted` });
  }

  const totals = { repos: repos.length, files: 0, dirtyFiles: 0 };
  for (const repo of repos) {
    totals.files += repo.counts.files;
    totals.dirtyFiles += repo.counts.files - repo.counts.clean;
  }

  return {
    id: ledgerRoom.id,
    name: ledgerRoom.name,
    status: ledgerRoom.status,
    leadAgent: ledgerRoom.leadAgent,
    createdAt: isoFromMs(ledgerRoom.createdAt),
    updatedAt: isoFromMs(ledgerRoom.updatedAt),
    memberCount: ledgerRoom.memberCount,
    repos,
    totals,
    errors,
  };
};

const parseStatusFilter = (raw: string | null): RoomStatusFilter => {
  if (raw === null || raw === '' || raw === 'active') return 'active';
  if (raw === 'archived') return 'archived';
  if (raw === 'all') return 'all';
  fail(400, 'invalid-status', 'query parameter "status" must be active, archived or all');
};

interface RoomsCacheEntry {
  key: string;
  at: number;
  value: RoomsResponse;
}

let roomsCache: RoomsCacheEntry | null = null;

const invalidateRoomsCache = (): void => {
  roomsCache = null;
};

const listRooms = async (url: URL): Promise<RoomsResponse> => {
  const filter = parseStatusFilter(url.searchParams.get('status'));
  const refresh = url.searchParams.get('refresh') === '1';
  if (!refresh && roomsCache && roomsCache.key === filter && Date.now() - roomsCache.at < ROOMS_CACHE_TTL_MS) {
    return roomsCache.value;
  }
  const ledger = readLedger(filter);
  const getContext = createContextCache();
  const rooms: RoomEntry[] = [];
  for (const room of ledger.rooms) {
    rooms.push(await buildRoom(room, ledger.filesByRoom.get(room.id) ?? [], getContext));
  }
  const response: RoomsResponse = {
    rooms,
    generatedAt: new Date().toISOString(),
    database: ledger.database,
  };
  roomsCache = { key: filter, at: Date.now(), value: response };
  return response;
};

/* ------------------------------------------------------------------ *
 * Path resolution helpers
 * ------------------------------------------------------------------ */

const assertNoNullByte = (value: string, field: string): void => {
  if (value.includes('\0')) fail(400, 'invalid-payload', `"${field}" must not contain NUL bytes`);
};

const resolveInsideRepo = (root: string, raw: string): string => {
  assertNoNullByte(raw, 'file');
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isInside(root, absolute) || absolute === path.resolve(root)) {
    fail(403, 'path-outside-repo', `path escapes the repository root: ${raw}`);
  }
  // realpath guards against symlinks pointing outside the repository. A deleted
  // file has no realpath, so we validate its parent directory instead.
  const realRoot = fs.realpathSync(root);
  try {
    const real = fs.realpathSync(absolute);
    if (!isInside(realRoot, real)) fail(403, 'path-outside-repo', `path resolves outside the repository: ${raw}`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const parent = path.dirname(absolute);
    try {
      const realParent = fs.realpathSync(parent);
      if (!isInside(realRoot, realParent)) fail(403, 'path-outside-repo', `path resolves outside the repository: ${raw}`);
    } catch (nested) {
      if (nested instanceof HttpError) throw nested;
      fail(404, 'file-not-found', `cannot resolve path: ${raw}`);
    }
  }
  return absolute;
};

const findRoom = (teamId: string): { ledger: ReturnType<typeof readLedger>; room: LedgerRoom } => {
  const ledger = readLedger('all');
  const room = ledger.rooms.find((candidate) => candidate.id === teamId);
  if (!room) fail(404, 'unknown-room', `unknown room: ${teamId}`);
  return { ledger, room };
};

/** True when at least one ledger path of the room lives inside `root`. */
const roomTouchesRoot = (files: readonly string[], root: string): boolean =>
  files.some((file) => isInside(root, path.resolve(file)));

/* ------------------------------------------------------------------ *
 * GET /api/multirepo/diff
 * ------------------------------------------------------------------ */

const parseView = (raw: string | null): DiffView => {
  if (raw === null || raw === '' || raw === 'combined') return 'combined';
  if (raw === 'staged' || raw === 'worktree') return raw;
  fail(400, 'invalid-view', 'query parameter "view" must be combined, staged or worktree');
};

const parseContext = (raw: string | null): number => {
  if (raw === null || raw === '') return 3;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    fail(400, 'invalid-context', 'query parameter "context" must be an integer between 0 and 50');
  }
  return value;
};

const getDiff = async (url: URL): Promise<DiffResponse> => {
  const roomId = requiredQuery(url, 'room');
  const repoParam = requiredQuery(url, 'repo');
  const fileParam = requiredQuery(url, 'file');
  const view = parseView(url.searchParams.get('view'));
  const contextLines = parseContext(url.searchParams.get('context'));

  const { ledger, room } = findRoom(roomId);
  const roomFiles = ledger.filesByRoom.get(room.id) ?? [];
  const root = await resolveRepoRoot(repoParam);
  if (!root || !roomTouchesRoot(roomFiles, root)) {
    fail(404, 'repo-not-in-room', `repository "${repoParam}" is not part of room "${room.name}"`);
  }

  const absolutePath = resolveInsideRepo(root, fileParam);
  const relativePath = toPosix(path.relative(root, absolutePath));
  const context = await loadRepoContext(root);
  if (context.error !== null) {
    fail(500, 'git-error', context.error);
  }

  const entry = context.status.get(relativePath) ?? null;
  const status = normalizeStatus(entry?.code ?? null);
  const staged = entry !== null && entry.code !== '??' && entry.code[0] !== ' ';
  const unstaged = entry !== null && (entry.code === '??' || entry.code[1] !== ' ');
  const language = languageFor(relativePath);

  if (status === 'untracked') {
    let info;
    try {
      info = await readTextFileCapped(absolutePath);
    } catch (error) {
      fail(404, 'file-not-found', `cannot read ${relativePath}: ${(error as Error).message}`);
    }
    if (info.binary) {
      return {
        room: room.id,
        repo: root,
        file: relativePath,
        status,
        view,
        staged,
        unstaged,
        additions: null,
        deletions: null,
        binary: true,
        truncated: info.truncated,
        language,
        hunks: [],
        patch: '',
      };
    }
    const patch = synthesizeUntrackedPatch(relativePath, info.text ?? '');
    const parsed = parseUnifiedDiff(patch);
    return {
      room: room.id,
      repo: root,
      file: relativePath,
      status,
      view,
      staged,
      unstaged,
      additions: info.lines,
      deletions: 0,
      binary: false,
      truncated: info.truncated || parsed.truncated,
      language,
      hunks: parsed.hunks,
      patch,
    };
  }

  if (status === 'clean') {
    // `resolveInsideRepo` tolerates missing paths on purpose (deleted files are
    // legitimate), so a clean status only means "clean" when the file exists.
    if (!fs.existsSync(absolutePath)) {
      fail(404, 'file-not-found', `cannot resolve path: ${relativePath}`);
    }
    return {
      room: room.id,
      repo: root,
      file: relativePath,
      status,
      view,
      staged,
      unstaged,
      additions: 0,
      deletions: 0,
      binary: false,
      truncated: false,
      language,
      hunks: [],
      patch: '',
    };
  }

  const numStat = await readNumStat(root, [relativePath], context.headExists);
  const stat = numStat.get(relativePath);
  if (stat?.binary === true) {
    return {
      room: room.id,
      repo: root,
      file: relativePath,
      status,
      view,
      staged,
      unstaged,
      additions: null,
      deletions: null,
      binary: true,
      truncated: false,
      language,
      hunks: [],
      patch: '',
    };
  }

  const built = await buildPatch(root, relativePath, view, contextLines);
  const parsed = parseUnifiedDiff(built.patch);
  return {
    room: room.id,
    repo: root,
    file: relativePath,
    status,
    view,
    staged,
    unstaged,
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    binary: false,
    truncated: built.truncated || parsed.truncated,
    language,
    hunks: parsed.hunks,
    patch: built.patch,
  };
};

/* ------------------------------------------------------------------ *
 * POST /api/multirepo/revert
 * ------------------------------------------------------------------ */

interface RevertPayload {
  room: string;
  scope: RevertScope;
  repo: string | null;
  file: string | null;
}

const parseRevertPayload = (body: string): RevertPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(400, 'invalid-payload', 'request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(400, 'invalid-payload', 'request body must be a JSON object');
  }
  const candidate = parsed as Record<string, unknown>;
  const room = candidate.room;
  if (typeof room !== 'string' || room === '') {
    fail(400, 'invalid-payload', '"room" must be a non-empty string');
  }
  const repo = typeof candidate.repo === 'string' && candidate.repo !== '' ? candidate.repo : null;
  const file = typeof candidate.file === 'string' && candidate.file !== '' ? candidate.file : null;
  const requestedScope = typeof candidate.scope === 'string' ? candidate.scope : null;
  if (requestedScope !== null && requestedScope !== 'file' && requestedScope !== 'repo' && requestedScope !== 'room') {
    fail(400, 'invalid-payload', '"scope" must be file, repo or room');
  }
  const scope: RevertScope = (requestedScope as RevertScope | null) ?? (file ? 'file' : repo ? 'repo' : 'room');
  if (scope === 'file' && file === null) {
    fail(400, 'invalid-payload', '"file" is required when scope is "file"');
  }
  if (scope === 'repo' && repo === null) {
    fail(400, 'invalid-payload', '"repo" is required when scope is "repo"');
  }
  return { room, scope, repo, file };
};

interface ResolvedTarget extends FileTarget {
  root: string;
}

const withRepoLock = (() => {
  const locks = new Map<string, Promise<unknown>>();
  return <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    locks.set(key, run.then(() => undefined, () => undefined));
    return run;
  };
})();

const revertTargets = async (
  payload: RevertPayload,
): Promise<RevertResponse> => {
  const { ledger, room } = findRoom(payload.room);
  const roomFiles = ledger.filesByRoom.get(room.id) ?? [];
  if (roomFiles.length === 0) {
    fail(409, 'nothing-to-revert', `room "${room.name}" has no recorded files`);
  }

  const normalizedFiles = new Map<string, string>();
  for (const recorded of roomFiles) {
    const absolute = path.resolve(recorded);
    if (!normalizedFiles.has(absolute)) normalizedFiles.set(absolute, recorded);
  }

  const selected: string[] = [];
  if (payload.scope === 'file') {
    const raw = payload.file ?? '';
    assertNoNullByte(raw, 'file');
    const probe = path.isAbsolute(raw) ? path.resolve(raw) : null;
    // Accept an absolute recorded path or a repo-relative path qualified by `repo`.
    if (probe && normalizedFiles.has(probe)) {
      if (payload.repo !== null) {
        const declaredRoot = await resolveRepoRoot(payload.repo);
        if (!declaredRoot || !isInside(declaredRoot, probe)) {
          fail(403, 'path-outside-repo', 'file does not belong to the declared repository');
        }
      }
      selected.push(probe);
    } else if (payload.repo !== null) {
      const root = await resolveRepoRoot(payload.repo);
      if (!root) fail(404, 'unknown-repo', `not a git repository: ${payload.repo}`);
      const absolute = resolveInsideRepo(root, raw);
      const recorded = normalizedFiles.get(absolute);
      if (!recorded) fail(404, 'file-not-in-room', `file is not recorded for room "${room.name}": ${raw}`);
      selected.push(absolute);
    } else {
      fail(400, 'invalid-payload', '"file" must be an absolute recorded path or be qualified by "repo"');
    }
  } else if (payload.scope === 'repo') {
    const declaredRoot = await resolveRepoRoot(payload.repo ?? '');
    if (!declaredRoot) fail(404, 'unknown-repo', `not a git repository: ${payload.repo ?? ''}`);
    for (const [absolute] of normalizedFiles) {
      if (isInside(declaredRoot, absolute)) selected.push(absolute);
    }
    if (selected.length === 0) {
      fail(404, 'repo-not-in-room', `repository is not part of room "${room.name}": ${payload.repo ?? ''}`);
    }
  } else {
    selected.push(...normalizedFiles.keys());
  }

  if (selected.length === 0) {
    fail(409, 'nothing-to-revert', `no files matched scope "${payload.scope}"`);
  }

  // Group by repository root, then revert sequentially inside each repo lock.
  const grouped = new Map<string, string[]>();
  for (const absolute of selected) {
    const root = await resolveRepoRoot(absolute);
    if (!root) {
      // handled below as a skip
      continue;
    }
    const list = grouped.get(root);
    if (list) list.push(absolute);
    else grouped.set(root, [absolute]);
  }

  const reverted: RevertTargetResult[] = [];
  const skipped: RevertSkip[] = [];

  for (const absolute of selected) {
    const root = await resolveRepoRoot(absolute);
    if (!root) {
      skipped.push({ repo: null, path: absolute, reason: 'not-a-git-repository' });
    }
  }

  const contextCache = createContextCache();
  for (const [root, absolutes] of grouped) {
    const context = await contextCache(root);
    if (context.error !== null) {
      for (const absolute of absolutes) {
        skipped.push({ repo: root, path: toPosix(path.relative(root, absolute)), reason: context.error });
      }
      continue;
    }
    for (const absolute of absolutes) {
      const relativePath = toPosix(path.relative(root, absolute));
      const entry = context.status.get(relativePath) ?? null;
      const status = normalizeStatus(entry?.code ?? null);
      if (status === 'clean') {
        skipped.push({ repo: root, path: relativePath, reason: 'already-clean' });
        continue;
      }
      try {
        const action = await withRepoLock(root, () => revertFile(root, relativePath, entry?.previousPath ?? null, context.headExists));
        reverted.push({ repo: root, path: relativePath, status, action });
      } catch (error) {
        skipped.push({
          repo: root,
          path: relativePath,
          reason: (error as Error).message || 'revert failed',
        });
      }
    }
  }

  reverted.sort((left, right) => left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  skipped.sort((left, right) => (left.repo ?? '').localeCompare(right.repo ?? '') || left.path.localeCompare(right.path));
  invalidateRoomsCache();

  return {
    ok: true,
    room: room.id,
    scope: payload.scope,
    reverted,
    skipped,
    counts: { reverted: reverted.length, skipped: skipped.length },
  };
};

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid service token' } });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/multirepo/rooms') {
    json(res, 200, await listRooms(url));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/multirepo/diff') {
    json(res, 200, await getDiff(url));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/multirepo/revert') {
    const body = await readBody(req);
    json(res, 200, await revertTargets(parseRevertPayload(body)));
    return;
  }
  json(res, 404, { error: { code: 'not-found', message: `no route for ${req.method ?? 'UNKNOWN'} ${url.pathname}` } });
};

const sendError = (res: http.ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    json(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof LedgerUnavailableError) {
    json(res, 503, { error: { code: error.code, message: error.message } });
    return;
  }
  console.error('multirepo-diff service: unexpected error', error);
  json(res, 500, { error: { code: 'internal-error', message: 'unexpected service error' } });
};

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => sendError(res, error));
});

server.on('error', (error) => {
  console.error(`multirepo-diff service: server error: ${error.message}`);
});

/** Graceful shutdown: stop accepting connections, never leave the port bound. */
const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`multirepo-diff service: ${signal} received, shutting down`);
  server.close(() => {
    process.exit(0);
  });
  const force = setTimeout(() => {
    console.error('multirepo-diff service: forced shutdown after 3s');
    process.exit(1);
  }, 3_000);
  force.unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (error) => {
  console.error('multirepo-diff service: uncaught exception', error);
  shutdown('SIGTERM');
});
process.on('unhandledRejection', (reason) => {
  console.error('multirepo-diff service: unhandled rejection', reason);
});

server.listen(port, '127.0.0.1');
