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
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}

export interface LedgerSnapshot {
  database: string;
  rooms: LedgerRoom[];
  /** Absolute file paths recorded for each team, newest first. */
  filesByRoom: Map<string, string[]>;
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

/** Reads rooms and their modified-file ledger. Read-only, no writes, no cache. */
export const readLedger = (filter: RoomStatusFilter = 'active'): LedgerSnapshot => {
  const { database } = resolveDatabasePath();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    const where =
      normalizeFilter(filter) === 'all' ? '' : 'WHERE t.status = ?';
    const params = filter === 'all' ? [] : [filter];
    const roomRows = db
      .prepare(
        `SELECT t.id, t.name, t.status, t.lead_agent,
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
        time_created: number;
        time_updated: number;
        member_count: number;
      }>;

    const rooms: LedgerRoom[] = roomRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status === 'archived' ? 'archived' : 'active',
      leadAgent: row.lead_agent ?? null,
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

    return { database, rooms, filesByRoom };
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
