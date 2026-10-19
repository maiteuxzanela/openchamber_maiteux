// Canonical Zod schema for kanban.json (CONTRACT_KANBAN §1.5).
//
// Two layers live here on purpose (TICKET-HARNESS-46):
//
//   1. STRICT CONTRACT — `ticketSchema` / `kanbanSchema` / `STATUS` / `PRIORITY`.
//      They encode the immutable on-disk contract (CONTRACT_KANBAN §1.5) and
//      reject any document that violates it. External consumers and the
//      contract suites keep validating against this layer.
//
//   2. RESILIENT READ PATH — `normalizeStatus` / `normalizeTicketForRead` /
//      `parseKanbanDocument` / `canonicalizeDoc`. Manual edits are frequent and
//      usually leave the status/date invariant broken (`status: "Concluído"`
//      with `completed_at: null`, or `status: "open"` with a stale date) or one
//      ticket malformed. The read path repairs what it can, logs a structured
//      `console.warn` per ticket and never lets a single bad ticket take down
//      the whole file. `canonicalizeDoc` re-applies the invariant right before
//      the service writes the document back to disk (auto-heal on write).
import { z } from 'zod';

import { PROJECT_IDS, type ProjectId } from './projects.ts';

export const ISO = z.iso.datetime({ offset: true });

const cleanToken = (val: string): string =>
  val.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const DONE_ALIASES = ['done', 'concluido', 'completed', 'closed', 'finished', 'finalizado'];
const OPEN_ALIASES = ['open', 'aberto', 'pending', 'in_progress', 'todo', 'active', 'em_andamento', 'em_progresso'];

/**
 * Lenient status normalizer used by the resilient read path.
 *
 * Any unrecognizable (or non-string) value degrades to the safe `"open"`
 * default instead of aborting the whole document, and every known synonym
 * (accented, capitalized, legacy) maps to the canonical `"open" | "done"`.
 */
export const normalizeStatus = (val: unknown): unknown => {
  if (typeof val !== 'string') return 'open';
  const clean = cleanToken(val);
  if (DONE_ALIASES.includes(clean)) return 'done';
  if (OPEN_ALIASES.includes(clean)) return 'open';
  return 'open';
};

export const normalizePriority = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const clean = cleanToken(val);
  if (['alta', 'alto', 'high', 'h', 'critica', 'urgente'].includes(clean)) return 'alta';
  if (['media', 'medio', 'medium', 'med', 'mid', 'm'].includes(clean)) return 'media';
  if (['baixa', 'baixo', 'low', 'l'].includes(clean)) return 'baixa';
  return clean;
};

/**
 * Strict contract normalizer (kept byte-compatible with the published
 * CONTRACT_KANBAN §1.5). It only accepts the historically documented
 * synonyms, so invalid values still surface as schema errors to strict
 * consumers instead of being silently coerced.
 */
const normalizeStatusStrict = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const clean = cleanToken(val);
  if (['done', 'concluido', 'completed', 'finalizado'].includes(clean)) return 'done';
  if (['open', 'aberto', 'pending', 'in_progress', 'todo'].includes(clean)) return 'open';
  return clean;
};

const normalizePriorityStrict = (val: unknown): unknown => normalizePriority(val);

export const STATUS = z.preprocess(normalizeStatusStrict, z.enum(['open', 'done']));
export const PRIORITY = z.preprocess(normalizePriorityStrict, z.enum(['alta', 'media', 'baixa']));
export const projectIdSchema = z.enum(PROJECT_IDS);

export const ticketSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: STATUS,
  priority: PRIORITY,
  summary: z.string(),
  body: z.string(),
  order: z.number().int().nonnegative(),
  created_at: ISO,
  completed_at: ISO.nullable(),
}).superRefine((ticket, context) => {
  if (ticket.status === 'open' && ticket.completed_at !== null) {
    context.addIssue({ code: 'custom', message: 'open ticket must have completed_at === null' });
  }
  if (ticket.status === 'done' && ticket.completed_at === null) {
    context.addIssue({ code: 'custom', message: 'done ticket must have completed_at' });
  }
});

export const kanbanSchema = z.object({
  meta: z.object({
    version: z.literal(1),
    project: projectIdSchema,
    title: z.string().min(1),
    instructions: z.string().optional(),
    updated_at: ISO,
  }),
  tickets: z.array(ticketSchema),
}).superRefine((doc, context) => {
  const seen = new Set<string>();
  for (const ticket of doc.tickets) {
    if (seen.has(ticket.id)) {
      context.addIssue({ code: 'custom', message: `duplicate ticket id: ${ticket.id}` });
    }
    seen.add(ticket.id);
  }
});

export type KanbanTicket = z.infer<typeof ticketSchema>;
export type KanbanDoc = z.infer<typeof kanbanSchema>;

export const nowIso = (): string => new Date().toISOString();

export const emptyDoc = (project: ProjectId, title: string): KanbanDoc => ({
  meta: { version: 1, project, title, updated_at: nowIso() },
  tickets: [],
});

/* ====================================================================== *
 * Resilient read path (TICKET-HARNESS-46)
 * ====================================================================== */

export interface KanbanWarning {
  readonly code: 'meta-recovered' | 'ticket-recovered' | 'ticket-discarded' | 'duplicate-ticket-id';
  readonly message: string;
  readonly index?: number;
  readonly ticketId?: string;
}

export type KanbanWarn = (warning: KanbanWarning) => void;

/** Default sink: structured warning on the service stderr/stdout. */
export const consoleWarn: KanbanWarn = (warning): void => {
  console.warn(`[kanban] ${warning.message}`, warning);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validIso = (value: unknown): string | null =>
  typeof value === 'string' && ISO.safeParse(value).success ? value : null;

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const canonicalPriority = (value: unknown): KanbanTicket['priority'] => {
  const normalized = normalizePriority(value);
  return normalized === 'alta' || normalized === 'media' || normalized === 'baixa' ? normalized : 'media';
};

const fallbackTicketId = (index: number): string => `ticket-${index + 1}`;

/**
 * Repairs a single raw ticket. Returns `null` when the entry is not even an
 * object (nothing safe to recover), otherwise a canonical ticket that always
 * satisfies the status/date invariant. Every repair emits one structured
 * warning so operators can see exactly what was healed.
 */
export const normalizeTicketForRead = (
  raw: unknown,
  index: number,
  warn: KanbanWarn = consoleWarn,
): KanbanTicket | null => {
  if (!isRecord(raw)) {
    warn({ code: 'ticket-discarded', message: `ticket at index ${index} is not an object; discarded`, index });
    return null;
  }

  const repairs: string[] = [];
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = rawId === '' ? fallbackTicketId(index) : rawId;
  if (rawId === '') repairs.push(`missing id -> "${id}"`);

  const status = normalizeStatus(raw.status) === 'done' ? 'done' : 'open';
  if (raw.status !== status) repairs.push(`status ${JSON.stringify(raw.status)} -> "${status}"`);

  const priority = canonicalPriority(raw.priority);
  if (raw.priority !== priority) repairs.push(`priority ${JSON.stringify(raw.priority)} -> "${priority}"`);

  for (const field of ['title', 'summary', 'body'] as const) {
    if (typeof raw[field] !== 'string') repairs.push(`missing ${field} -> ""`);
  }
  const order = typeof raw.order === 'number' && Number.isInteger(raw.order) && raw.order >= 0
    ? raw.order
    : index;
  if (order !== raw.order) repairs.push(`order ${JSON.stringify(raw.order)} -> ${order}`);

  const createdAt = validIso(raw.created_at) ?? nowIso();
  if (createdAt !== raw.created_at) repairs.push('created_at missing/invalid -> now()');

  // Invariant repair: done always carries an ISO timestamp, open always null.
  let completedAt: string | null;
  if (status === 'done') {
    completedAt = validIso(raw.completed_at) ?? nowIso();
    if (completedAt !== raw.completed_at) repairs.push('done without completed_at -> now()');
  } else {
    completedAt = null;
    if (raw.completed_at !== null && raw.completed_at !== undefined) repairs.push('open with completed_at -> null');
  }

  const candidate: KanbanTicket = {
    id,
    title: asString(raw.title, ''),
    status,
    priority,
    summary: asString(raw.summary, ''),
    body: asString(raw.body, ''),
    order,
    created_at: createdAt,
    completed_at: completedAt,
  };

  const validated = ticketSchema.safeParse(candidate);
  if (!validated.success) {
    const detail = validated.error.issues[0]?.message ?? 'schema validation failed';
    warn({
      code: 'ticket-discarded',
      message: `ticket at index ${index} (${candidate.id}) is unrecoverable; discarded: ${detail}`,
      index,
      ticketId: candidate.id,
    });
    return null;
  }

  if (repairs.length > 0) {
    warn({
      code: 'ticket-recovered',
      message: `ticket ${candidate.id} repaired: ${repairs.join('; ')}`,
      index,
      ticketId: candidate.id,
    });
  }
  return validated.data;
};

/**
 * Resilient parser for the document served by the Kanban service.
 *
 * Meta-level corruption (missing/invalid `meta`, unknown project, unsupported
 * version, non-array `tickets`) still throws — the caller must answer 500 and
 * never overwrite the file. Ticket-level corruption is isolated: each ticket
 * is repaired when possible, duplicates keep the first occurrence and anything
 * unrecoverable is discarded with a structured warning, so the remaining valid
 * tickets stay available.
 */
export const parseKanbanDocument = (raw: unknown, warn: KanbanWarn = consoleWarn): KanbanDoc => {
  if (!isRecord(raw)) throw new Error('kanban document must be a JSON object');

  if (!isRecord(raw.meta)) throw new Error('kanban document is missing a valid meta object');
  const metaRaw = raw.meta;
  if (metaRaw.version !== 1) throw new Error(`unsupported meta.version: ${JSON.stringify(metaRaw.version)}`);
  const project = projectIdSchema.safeParse(metaRaw.project);
  if (!project.success) throw new Error(`unknown meta.project: ${JSON.stringify(metaRaw.project)}`);

  const metaRepairs: string[] = [];
  const rawTitle = typeof metaRaw.title === 'string' ? metaRaw.title : '';
  const title = rawTitle.trim() === '' ? project.data : rawTitle;
  if (title !== rawTitle) metaRepairs.push(`missing title -> "${title}"`);
  const updatedAt = validIso(metaRaw.updated_at) ?? nowIso();
  if (updatedAt !== metaRaw.updated_at) metaRepairs.push('updated_at missing/invalid -> now()');

  if (metaRepairs.length > 0) {
    warn({ code: 'meta-recovered', message: `meta repaired: ${metaRepairs.join('; ')}` });
  }

  if (!Array.isArray(raw.tickets)) throw new Error('kanban document "tickets" must be an array');

  const tickets: KanbanTicket[] = [];
  const seen = new Set<string>();
  raw.tickets.forEach((rawTicket, index) => {
    const ticket = normalizeTicketForRead(rawTicket, index, warn);
    if (ticket === null) return;
    if (seen.has(ticket.id)) {
      warn({
        code: 'duplicate-ticket-id',
        message: `duplicate ticket id "${ticket.id}" at index ${index}; duplicate discarded`,
        index,
        ticketId: ticket.id,
      });
      return;
    }
    seen.add(ticket.id);
    tickets.push(ticket);
  });

  const meta: KanbanDoc['meta'] = { version: 1, project: project.data, title, updated_at: updatedAt };
  if (typeof metaRaw.instructions === 'string') meta.instructions = metaRaw.instructions;

  return { meta, tickets };
};

/**
 * Auto-heal right before persistence: stamps canonical statuses, valid ISO
 * dates and clears/restores `completed_at` according to the invariant, so a
 * document that came from a legacy/healed read can never be written back dirty.
 */
export const canonicalizeTicket = (ticket: KanbanTicket): KanbanTicket => {
  const status = normalizeStatus(ticket.status) === 'done' ? 'done' : 'open';
  return {
    ...ticket,
    status,
    priority: canonicalPriority(ticket.priority),
    created_at: validIso(ticket.created_at) ?? nowIso(),
    completed_at: status === 'done' ? (validIso(ticket.completed_at) ?? nowIso()) : null,
  };
};

export const canonicalizeDoc = (doc: KanbanDoc): KanbanDoc => ({
  meta: { ...doc.meta, updated_at: validIso(doc.meta.updated_at) ?? nowIso() },
  tickets: doc.tickets.map(canonicalizeTicket),
});
