/**
 * Canonical wire contract for the multirepo-diff guest service
 * (TICKET-HARNESS-40).
 *
 * This module is the single source of truth shared by the service and the
 * panel: every JSON payload documented in `CONTRACT_MULTIREPO.md` is typed
 * here and nothing reaches the wire without passing through these shapes.
 *
 * The service never touches the filesystem from the iframe: the panel talks to
 * the host over `host.serviceRequest()` and the host proxies to this service
 * (CONTRACT_MULTIREPO §2, mirroring CONTRACT_KANBAN §2).
 */

/** Normalized state of a working-tree path, derived from `git status`. */
export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unmerged'
  | 'clean';

/** Which diff the caller wants to see. */
export type DiffView = 'combined' | 'staged' | 'worktree';

/** Scope of a revert request. */
export type RevertScope = 'file' | 'repo' | 'room';

/** What the revert actually did to one path. */
export type RevertAction = 'restored' | 'deleted' | 'unchanged';

export interface RepoFileEntry {
  /** Path relative to the repository root (POSIX separators). */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  status: FileStatus;
  /** Raw two-letter porcelain code (`" M"`, `"??"`, `"RM"`, …) or null when clean. */
  code: string | null;
  /** Index (staged) portion is dirty. */
  staged: boolean;
  /** Working-tree (unstaged) portion is dirty. */
  unstaged: boolean;
  /** Lines added vs HEAD; null for binary files. */
  additions: number | null;
  /** Lines removed vs HEAD; null for binary files. */
  deletions: number | null;
  binary: boolean;
  /** Original path when `status === 'renamed' | 'copied'`. */
  previousPath: string | null;
}

export interface RepoCounts {
  files: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  clean: number;
}

export interface RepoEntry {
  /** Absolute repository root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Basename of the root, for display. */
  name: string;
  /** Current branch, or null when detached/unborn. */
  branch: string | null;
  /** HEAD commit sha, or null when the repository has no commits yet. */
  head: string | null;
  dirty: boolean;
  files: RepoFileEntry[];
  counts: RepoCounts;
  /** Files omitted because the repository exceeded the per-repo safety cap. */
  truncatedFiles: number;
  /** Populated when status/numstat for this repository could not be computed. */
  error: string | null;
}

export interface RoomFileError {
  path: string;
  reason: string;
}

/**
 * Active worktree linked to a room member (TICKET-HARNESS-76).
 *
 * The panel uses these paths and session ids to rank the room that owns the
 * active session/worktree first. `path` is absolute and POSIX-normalized;
 * `sessionId` is the member session recorded in `team_member.session_id`.
 */
export interface RoomWorktree {
  /** Absolute worktree directory (`team_member.worktree_dir`). */
  path: string;
  /** Branch checked out in the worktree, when the ledger records one. */
  branch: string | null;
  /** Member name that owns the worktree. */
  member: string;
  /** Session bound to that member, or null when the ledger has no session. */
  sessionId: string | null;
}

export interface RoomEntry {
  id: string;
  name: string;
  status: 'active' | 'archived';
  leadAgent: string | null;
  /** Session that leads the room; used to detect "the current room". */
  leadSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  /** Active worktrees linked to the room members (deduplicated, sorted by path). */
  worktrees: RoomWorktree[];
  repos: RepoEntry[];
  totals: { repos: number; files: number; dirtyFiles: number };
  /** Ledger paths that could not be mapped to a git repository (capped at 20). */
  errors: RoomFileError[];
}

export interface RoomsResponse {
  rooms: RoomEntry[];
  generatedAt: string;
  /** Absolute path of the SQLite database that produced the ledger. */
  database: string;
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta';
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffResponse {
  room: string;
  repo: string;
  file: string;
  status: FileStatus;
  view: DiffView;
  staged: boolean;
  unstaged: boolean;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** A byte/line cap was hit while materializing the patch. */
  truncated: boolean;
  /** Best-effort language hint for the panel highlighter. */
  language: string;
  hunks: DiffHunk[];
  /** Raw unified diff (already capped when `truncated`). */
  patch: string;
}

export interface RevertTargetResult {
  repo: string;
  path: string;
  status: FileStatus;
  action: RevertAction;
}

export interface RevertSkip {
  repo: string | null;
  path: string;
  reason: string;
}

export interface RevertResponse {
  ok: true;
  room: string;
  scope: RevertScope;
  reverted: RevertTargetResult[];
  skipped: RevertSkip[];
  counts: { reverted: number; skipped: number };
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
