// Canonical Zod schema for kanban.json (CONTRACT_KANBAN §1.5).
import { z } from 'zod';

import { PROJECT_IDS, type ProjectId } from './projects.ts';

export const ISO = z.iso.datetime({ offset: true });

export const normalizePriority = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const clean = val.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['alta', 'alto', 'high', 'h', 'critica', 'urgente'].includes(clean)) return 'alta';
  if (['media', 'medio', 'medium', 'med', 'mid', 'm'].includes(clean)) return 'media';
  if (['baixa', 'baixo', 'low', 'l'].includes(clean)) return 'baixa';
  return clean;
};

export const normalizeStatus = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const clean = val.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['done', 'concluido', 'completed', 'closed', 'finalizado'].includes(clean)) return 'done';
  if (['open', 'aberto', 'pending', 'in_progress', 'todo'].includes(clean)) return 'open';
  return clean;
};

export const STATUS = z.preprocess(normalizeStatus, z.enum(['open', 'done']));
export const PRIORITY = z.preprocess(normalizePriority, z.enum(['alta', 'media', 'baixa']));
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
