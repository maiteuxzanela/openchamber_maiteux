/**
 * Contextual room prioritisation for the Multirepo Diff panel
 * (TICKET-HARNESS-76).
 *
 * The panel receives the active project directory and the active session from
 * the host handshake (`ready` / `directory` / `session` pushes). The host
 * normalises the guest directory to the owning project root — a worktree
 * session still points at the parent project — so directory affinity alone is
 * not enough. The service therefore exposes the worktrees recorded for each
 * room member (`team_member.worktree_dir`, `team_member.session_id`) and the
 * room lead session (`team.lead_session_id`); this module turns that into a
 * deterministic ordering:
 *
 *   rank 0 — the room owns the current worktree or the current session;
 *   rank 1 — the room touches the git repository of the active directory;
 *   rank 2 — everything else, newest first.
 *
 * Everything here is pure: no DOM, no host access, no filesystem. That keeps
 * the ordering and the focus decision directly testable with real objects.
 */

import type { RoomEntry, RoomWorktree } from '../service/contract.ts';

export type RoomContextRank = 0 | 1 | 2;

export type RoomContextKind = 'worktree' | 'session' | 'repo' | null;

/** Host context that drives the ranking. */
export interface PanelContext {
  /** Active project directory from `ready.directory` / `directory` pushes. */
  directory: string | null;
  /** Active session id from `ready.session` / session pushes. */
  sessionId: string | null;
}

export interface RoomContextMatch {
  roomId: string;
  rank: RoomContextRank;
  kind: RoomContextKind;
  /** Normalised project directory the match was computed against. */
  directory: string | null;
  /** Worktree path that matched (worktree or session affinity). */
  worktreePath: string | null;
  /** Repository root that matched at rank 1. */
  repoRoot: string | null;
  /** Session id that produced the rank 0 match, when there is one. */
  sessionId: string | null;
}

const NO_MATCH: Omit<RoomContextMatch, 'roomId' | 'directory'> = {
  rank: 2,
  kind: null,
  worktreePath: null,
  repoRoot: null,
  sessionId: null,
};

/**
 * POSIX-normalises a directory for containment checks: backslashes become
 * slashes, duplicate/trailing separators are collapsed and empty input is
 * `null`. The filesystem root (`/`) is preserved.
 */
export const normalizeContextPath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let normalized = trimmed.replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

/** True when `child` is `parent` itself or lives underneath it. */
export const isPathWithin = (parent: string | null | undefined, child: string | null | undefined): boolean => {
  const normalizedParent = normalizeContextPath(parent);
  const normalizedChild = normalizeContextPath(child);
  if (normalizedParent === null || normalizedChild === null) return false;
  if (normalizedChild === normalizedParent) return true;
  const prefix = normalizedParent === '/' ? '/' : `${normalizedParent}/`;
  return normalizedChild.startsWith(prefix);
};

const roomWorktrees = (room: RoomEntry): RoomWorktree[] =>
  Array.isArray(room.worktrees) ? room.worktrees : [];

const cleanSessionId = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Computes the contextual rank of a single room. */
export const matchRoomContext = (room: RoomEntry, context: PanelContext): RoomContextMatch => {
  const directory = normalizeContextPath(context.directory);
  const sessionId = cleanSessionId(context.sessionId);
  const worktrees = roomWorktrees(room);

  let worktree: RoomWorktree | null = null;
  if (directory !== null) {
    for (const candidate of worktrees) {
      const candidatePath = normalizeContextPath(candidate?.path ?? null);
      if (candidatePath === null) continue;
      if (isPathWithin(candidatePath, directory)) {
        worktree = candidate;
        break;
      }
    }
  }

  const sessionWorktree =
    sessionId === null
      ? null
      : worktrees.find((candidate) => cleanSessionId(candidate?.sessionId) === sessionId) ?? null;
  const leadMatches = sessionId !== null && cleanSessionId(room.leadSessionId) === sessionId;

  if (worktree !== null || sessionWorktree !== null || leadMatches) {
    const matched = worktree ?? sessionWorktree;
    return {
      roomId: room.id,
      rank: 0,
      kind: worktree !== null ? 'worktree' : 'session',
      directory,
      worktreePath: normalizeContextPath(matched?.path ?? null),
      repoRoot: null,
      sessionId: sessionId,
    };
  }

  if (directory !== null) {
    const repos = Array.isArray(room.repos) ? room.repos : [];
    const repo = repos.find(
      (candidate) =>
        isPathWithin(candidate.root, directory) || isPathWithin(directory, candidate.root),
    );
    if (repo) {
      return {
        roomId: room.id,
        rank: 1,
        kind: 'repo',
        directory,
        worktreePath: null,
        repoRoot: normalizeContextPath(repo.root),
        sessionId: sessionId,
      };
    }
  }

  return { roomId: room.id, directory, ...NO_MATCH };
};

const updatedAtMs = (room: RoomEntry): number => {
  const parsed = Date.parse(room.updatedAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
};

const compareTemporalDesc = (left: RoomEntry, right: RoomEntry): number =>
  updatedAtMs(right) - updatedAtMs(left) || right.createdAt.localeCompare(left.createdAt);

/**
 * Orders rooms by contextual affinity, newest first inside each rank.
 *
 * The input order is preserved as the final tie-breaker, so two rooms with the
 * same rank and timestamps never swap between renders.
 */
export const sortRoomsByContext = (rooms: readonly RoomEntry[], context: PanelContext): RoomEntry[] => {
  return rooms
    .map((room, index) => ({ room, index, match: matchRoomContext(room, context) }))
    .sort(
      (left, right) =>
        left.match.rank - right.match.rank ||
        compareTemporalDesc(left.room, right.room) ||
        left.index - right.index,
    )
    .map((entry) => entry.room);
};

/** The room that owns the active worktree/session (rank 0), if any. */
export const findFocusedRoom = (rooms: readonly RoomEntry[], context: PanelContext): RoomEntry | null => {
  for (const room of rooms) {
    if (matchRoomContext(room, context).rank === 0) return room;
  }
  return null;
};
