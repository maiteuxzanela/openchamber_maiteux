/**
 * Read-only access to the Ensemble ledger (TICKET-HARNESS-40).
 *
 * The ledger lives in the plugin SQLite database (`team`, `team_member`,
 * `team_modified_file`). The service opens it strictly read-only and never
 * writes: the diff panel is an observer of what the team touched, not an
 * authority over it.
 *
 * The brief points at `~/.local/share/opencode/opencode.db`, but the real team
 * tables belong to the Ensemble plugin database (`~/.config/opencode/ensemble.db`,
 * see `ensemble-room-lowcost/src/db.ts:getDbPath`). We therefore resolve the
 * database by capability — first candidate that actually exposes the `team`
 * and `team_modified_file` tables — instead of trusting a single hardcoded
 * path. `OPENCHAMBER_MULTIREPO_DB` wins unconditionally when set.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RoomStatusFilter = 'active' | 'archived' | 'all';

export interface LedgerRoom {
  id: string;
  name: string;
  status: 'active' | 'archived';
  leadAgent: string | null;
  /** Session that leads the room, or null when the ledger has none. */
  leadSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}

/** A worktree recorded for a room member (`team_member.worktree_dir`). */
export interface LedgerWorktree {
  path: string;
  branch: string | null;
  member: string;
  sessionId: string | null;
}

export interface LedgerSnapshot {
  database: string;
  rooms: LedgerRoom[];
  /** Absolute file paths recorded for each team, newest first. */
  filesByRoom: Map<string, string[]>;
  /** Active worktrees per team, sorted by path (TICKET-HARNESS-76). */
  worktreesByRoom: Map<string, LedgerWorktree[]>;
}

export class LedgerUnavailableError extends Error {
  readonly code: string;
  readonly candidates: string[];

  constructor(message: string, candidates: string[]) {
    super(message);
    this.name = 'LedgerUnavailableError';
    this.code = 'database-unavailable';
    this.candidates = candidates;
  }
}

const home = (): string => process.env.HOME ?? os.homedir();

/** Candidate database paths, in priority order. */
export const databaseCandidates = (): string[] => {
  const explicit = process.env.OPENCHAMBER_MULTIREPO_DB?.trim();
  if (explicit) return [path.resolve(explicit)];
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || path.join(home(), '.config');
  const xdgData = process.env.XDG_DATA_HOME?.trim() || path.join(home(), '.local', 'share');
  return [
    path.join(xdgConfig, 'opencode', 'ensemble.db'),
    path.join(xdgData, 'opencode', 'ensemble.db'),
    path.join(xdgData, 'opencode', 'opencode.db'),
  ];
};

const REQUIRED_TABLES = ['team', 'team_modified_file'] as const;

const inspectDatabase = (database: string): boolean => {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('team', 'team_modified_file')")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    return REQUIRED_TABLES.every((table) => names.has(table));
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

/** Picks the first candidate that exposes the team ledger schema. */
export const resolveDatabasePath = (): { database: string; candidates: string[] } => {
  const candidates = databaseCandidates();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (inspectDatabase(candidate)) return { database: candidate, candidates };
  }
  throw new LedgerUnavailableError(
    `no SQLite database with the team ledger schema was found (candidates: ${candidates.join(', ')})`,
    candidates,
  );
};

const normalizeFilter = (filter: RoomStatusFilter): RoomStatusFilter => filter;

/** Column names exposed by a table, used to stay compatible with older ledgers. */
const tableColumns = (db: DatabaseSync, table: string): Set<string> => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

/** Reads rooms and their modified-file ledger. Read-only, no writes, no cache. */
export const readLedger = (filter: RoomStatusFilter = 'active'): LedgerSnapshot => {
  const { database } = resolveDatabasePath();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    const teamColumns = tableColumns(db, 'team');
    const leadSessionExpr = teamColumns.has('lead_session_id') ? 't.lead_session_id' : 'NULL';
    const where =
      normalizeFilter(filter) === 'all' ? '' : 'WHERE t.status = ?';
    const params = filter === 'all' ? [] : [filter];
    const roomRows = db
      .prepare(
        `SELECT t.id, t.name, t.status, t.lead_agent, ${leadSessionExpr} AS lead_session_id,
                t.time_created, t.time_updated,
                (SELECT COUNT(*) FROM team_member m WHERE m.team_id = t.id) AS member_count
           FROM team t
           ${where}
          ORDER BY t.time_created DESC`,
      )
      .all(...params) as Array<{
        id: string;
        name: string;
        status: string;
        lead_agent: string | null;
        lead_session_id: string | null;
        time_created: number;
        time_updated: number;
        member_count: number;
      }>;

    const rooms: LedgerRoom[] = roomRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status === 'archived' ? 'archived' : 'active',
      leadAgent: row.lead_agent ?? null,
      leadSessionId: typeof row.lead_session_id === 'string' && row.lead_session_id !== '' ? row.lead_session_id : null,
      createdAt: Number(row.time_created) || 0,
      updatedAt: Number(row.time_updated) || 0,
      memberCount: Number(row.member_count) || 0,
    }));

    const filesByRoom = new Map<string, string[]>();
    const fileRows = db
      .prepare(
        `SELECT m.team_id, m.file_path
           FROM team_modified_file m
           JOIN team t ON t.id = m.team_id
          ${filter === 'all' ? '' : 'WHERE t.status = ?'}
          ORDER BY m.time_created DESC`,
      )
      .all(...params) as Array<{ team_id: string; file_path: string }>;
    for (const row of fileRows) {
      const list = filesByRoom.get(row.team_id);
      if (list) list.push(row.file_path);
      else filesByRoom.set(row.team_id, [row.file_path]);
    }

    return { database, rooms, filesByRoom, worktreesByRoom: readWorktreesByRoom(db, filter, params) };
  } catch (error) {
    if (error instanceof LedgerUnavailableError) throw error;
    throw new LedgerUnavailableError(
      `cannot read the team ledger at ${database}: ${(error as Error).message}`,
      [database],
    );
  } finally {
    db?.close();
  }
};

/**
 * Worktrees recorded for the members of each room (TICKET-HARNESS-76).
 *
 * Older ledgers do not have the `worktree_dir` column (or the branch/session
 * companions); the query degrades to an empty map instead of failing, so the
 * panel simply has no worktree affinity to rank on.
 */
const readWorktreesByRoom = (
  db: DatabaseSync,
  filter: RoomStatusFilter,
  params: readonly (string | number)[],
): Map<string, LedgerWorktree[]> => {
  const worktreesByRoom = new Map<string, LedgerWorktree[]>();
  const memberColumns = tableColumns(db, 'team_member');
  if (!memberColumns.has('worktree_dir')) return worktreesByRoom;

  const branchExpr = memberColumns.has('worktree_branch') ? 'm.worktree_branch' : 'NULL';
  const sessionExpr = memberColumns.has('session_id') ? 'm.session_id' : 'NULL';
  const conditions = ["m.worktree_dir IS NOT NULL", "m.worktree_dir <> ''"];
  if (filter !== 'all') conditions.push('t.status = ?');
  const rows = db
    .prepare(
      `SELECT m.team_id, m.name, ${sessionExpr} AS session_id,
              m.worktree_dir, ${branchExpr} AS worktree_branch
         FROM team_member m
         JOIN team t ON t.id = m.team_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.worktree_dir ASC, m.name ASC`,
    )
    .all(...params) as Array<{
      team_id: string;
      name: string;
      session_id: string | null;
      worktree_dir: string | null;
      worktree_branch: string | null;
    }>;

  const seen = new Set<string>();
  for (const row of rows) {
    const raw = typeof row.worktree_dir === 'string' ? row.worktree_dir.trim() : '';
    if (raw === '') continue;
    const resolved = path.resolve(raw);
    const dedupeKey = `${row.team_id}\u0000${resolved}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const worktree: LedgerWorktree = {
      path: resolved,
      branch: typeof row.worktree_branch === 'string' && row.worktree_branch !== '' ? row.worktree_branch : null,
      member: row.name,
      sessionId: typeof row.session_id === 'string' && row.session_id !== '' ? row.session_id : null,
    };
    const list = worktreesByRoom.get(row.team_id);
    if (list) list.push(worktree);
    else worktreesByRoom.set(row.team_id, [worktree]);
  }
  for (const list of worktreesByRoom.values()) {
    list.sort((left, right) => left.path.localeCompare(right.path) || left.member.localeCompare(right.member));
  }
  return worktreesByRoom;
};

