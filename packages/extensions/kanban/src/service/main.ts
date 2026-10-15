// Kanban guest service. Runs under the host Node runtime on 127.0.0.1 and is
// only reachable through the OpenChamber service proxy (CONTRACT_KANBAN §2).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { dirname } from 'node:path';

import { PROJECTS, findProject, kanbanFilePath, type ProjectDefinition } from './projects.ts';
import { emptyDoc, kanbanSchema, nowIso, type KanbanDoc, type KanbanTicket } from './schema.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '');
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const MAX_BODY_BYTES = 64 * 1024;

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

// Explicit function type so TypeScript treats calls as never-returning and
// narrows the code after guard clauses.
const fail: (status: number, code: string, message: string) => never = (status, code, message) => {
  throw new HttpError(status, code, message);
};

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
};

interface CacheEntry {
  readonly doc: KanbanDoc;
  readonly mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
const locks = new Map<string, Promise<unknown>>();

/** Serialize writes per project so concurrent toggles cannot interleave. */
const withLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
};

const parseKanban = (raw: string, project: ProjectDefinition): KanbanDoc => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(500, 'schema-invalid', `${project.id}/kanban.json is not valid JSON`);
  }
  const result = kanbanSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues[0]?.message ?? 'schema validation failed';
    fail(500, 'schema-invalid', `${project.id}/kanban.json: ${detail}`);
  }
  return result.data;
};

/** Reads and validates kanban.json. A missing file yields the empty template. */
const readKanban = async (project: ProjectDefinition): Promise<KanbanDoc> => {
  const file = kanbanFilePath(project);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache.delete(project.id);
      return emptyDoc(project.id, project.title);
    }
    fail(500, 'io-error', `cannot stat ${project.id}/kanban.json: ${(error as Error).message}`);
  }
  const cached = cache.get(project.id);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.doc;
  }
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    fail(500, 'io-error', `cannot read ${project.id}/kanban.json: ${(error as Error).message}`);
  }
  const doc = parseKanban(raw, project);
  cache.set(project.id, { doc, mtimeMs: stat.mtimeMs });
  return doc;
};

/** Atomic write: temp file in the target directory, fsync, then rename. */
const writeAtomic = async (file: string, contents: string): Promise<void> => {
  const temp = `${dirname(file)}/.kanban.json.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

const countTickets = (doc: KanbanDoc): { total: number; open: number; done: number } => {
  let open = 0;
  for (const ticket of doc.tickets) {
    if (ticket.status === 'open') open += 1;
  }
  return { total: doc.tickets.length, open, done: doc.tickets.length - open };
};

const listProjects = async (): Promise<{ projects: unknown[] }> => {
  const projects = [];
  for (const project of PROJECTS) {
    let counts = { total: 0, open: 0, done: 0 };
    try {
      counts = countTickets(await readKanban(project));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      console.error(`kanban projects: ${project.id} -> ${error.code}: ${error.message}`);
    }
    projects.push({
      id: project.id,
      title: project.title,
      path: project.path,
      totalTickets: counts.total,
      openTickets: counts.open,
      doneTickets: counts.done,
    });
  }
  return { projects };
};

const getKanban = async (url: URL): Promise<{ project: string; meta: KanbanDoc['meta']; tickets: KanbanTicket[] }> => {
  const requested = url.searchParams.get('project');
  if (requested === null || requested === '') {
    fail(400, 'missing-project', 'query parameter "project" is required');
  }
  const project = findProject(requested);
  if (!project) {
    fail(404, 'unknown-project', `unknown project: ${requested}`);
  }
  const doc = await readKanban(project);
  return { project: project.id, meta: doc.meta, tickets: doc.tickets };
};

interface TogglePayload {
  project: string;
  ticketId: string;
  done: boolean;
}

const parseTogglePayload = (body: string): TogglePayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(400, 'invalid-payload', 'request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    fail(400, 'invalid-payload', 'request body must be a JSON object');
  }
  const candidate = parsed as Record<string, unknown>;
  const project = candidate.project;
  const ticketId = candidate.ticketId;
  const done = candidate.done;
  if (typeof project !== 'string' || project === '') {
    fail(400, 'invalid-payload', '"project" must be a non-empty string');
  }
  if (typeof ticketId !== 'string' || ticketId === '') {
    fail(400, 'invalid-payload', '"ticketId" must be a non-empty string');
  }
  if (typeof done !== 'boolean') {
    fail(400, 'invalid-payload', '"done" must be a boolean');
  }
  return { project, ticketId, done };
};

interface ToggleResult {
  ok: true;
  ticket: { id: string; status: KanbanTicket['status']; completed_at: string | null };
  updated_at: string;
}

const toggleTicket = async (payload: TogglePayload): Promise<ToggleResult> => {
  const project = findProject(payload.project);
  if (!project) {
    fail(404, 'unknown-project', `unknown project: ${payload.project}`);
  }
  return withLock(project.id, async () => {
    const doc = await readKanban(project);
    const index = doc.tickets.findIndex((ticket) => ticket.id === payload.ticketId);
    if (index === -1) {
      fail(404, 'unknown-ticket', `unknown ticket: ${payload.ticketId}`);
    }
    const current = doc.tickets[index];
    const updated: KanbanTicket = {
      ...current,
      status: payload.done ? 'done' : 'open',
      completed_at: payload.done ? nowIso() : null,
    };
    const next: KanbanDoc = {
      meta: { ...doc.meta, updated_at: nowIso() },
      tickets: doc.tickets.map((ticket, position) => (position === index ? updated : ticket)),
    };
    const file = kanbanFilePath(project);
    try {
      await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      fail(500, 'io-error', `cannot write ${project.id}/kanban.json: ${(error as Error).message}`);
    }
    const stat = await fsp.stat(file).catch(() => null);
    cache.set(project.id, { doc: next, mtimeMs: stat?.mtimeMs ?? 0 });
    return {
      ok: true,
      ticket: { id: updated.id, status: updated.status, completed_at: updated.completed_at },
      updated_at: next.meta.updated_at,
    };
  });
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
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
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    json(res, 200, await listProjects());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/kanban') {
    json(res, 200, await getKanban(url));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/toggle') {
    const body = await readBody(req);
    json(res, 200, await toggleTicket(parseTogglePayload(body)));
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
  console.error('kanban service: unexpected error', error);
  json(res, 500, { error: { code: 'internal-error', message: 'unexpected service error' } });
};

/** Watch each repo directory and drop the cache when kanban.json changes. */
const watchProjects = (): void => {
  for (const project of PROJECTS) {
    try {
      const watcher = fs.watch(project.path, { persistent: false }, (_event, filename) => {
        if (filename === null || String(filename) === 'kanban.json') {
          cache.delete(project.id);
        }
      });
      watcher.on('error', (error) => {
        console.error(`kanban watch: ${project.id} -> ${(error as Error).message}`);
      });
    } catch (error) {
      console.error(`kanban watch: cannot watch ${project.id}: ${(error as Error).message}`);
    }
  }
};

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => sendError(res, error));
});

watchProjects();
server.listen(port, '127.0.0.1');
