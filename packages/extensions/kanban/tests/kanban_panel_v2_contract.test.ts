/**
 * Deterministic, mock-free suite for the Kanban panel contract v2
 * (TICKET-HARNESS-88 · F5/F6/F7/F4).
 *
 * It exercises the REAL shipped panel bundle produced by
 * `bun run extensions:build` (packages/web/server/built-in-extensions/kanban/
 * panel/main.js) inside a REAL DOM (happy-dom) and drives it through the REAL
 * SDK `service-request` transport. The parent frame is a faithful emulation that
 * answers with the exact payload shapes the shipped service emits:
 *
 *   · `GET /api/kanban?project=<id>` → sliced list WITHOUT `body`
 *     (`contractVersion: 2`), matching `service/main.ts`;
 *   · `GET /api/kanban/ticket?project=&ticketId=` → full ticket WITH `body`;
 *   · failure paths answer with real HTTP-style error bodies (500 / 413).
 *
 * Proves:
 *   F5 — the list renders without bodies and the body is fetched on demand,
 *        exactly once per card (cached across collapse/expand);
 *   F6 — a project that fails in the aggregate "Todos" tab is announced by
 *        name and never dressed as `0 abertos · 0 concluídos`;
 *   F7 — a lockstep mismatch (`contractVersion` other than 2) fails with an
 *        explicit version error instead of an empty board;
 *   F4 — a `413 response-too-large` surfaces the service message with an
 *        actionable retry, never `invalid-json`.
 *
 * Run: bun test packages/extensions/kanban/tests/kanban_panel_v2_contract.test.ts
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_PANEL = path.join(
  REPO_ROOT,
  'packages',
  'web',
  'server',
  'built-in-extensions',
  'kanban',
  'panel',
  'main.js',
);

const PANEL_SOURCE = fs.readFileSync(BUILT_PANEL, 'utf8');

/** Frozen wall-clock so every served payload is byte-stable. */
const NOW = '2026-10-22T12:00:00-03:00';
const CONTRACT_V2 = 2;

type TicketStatus = 'open' | 'done';
type TicketPriority = 'alta' | 'media' | 'baixa';

type Ticket = {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  summary: string;
  body?: string;
  order: number;
  created_at: string;
  completed_at: string | null;
};

type Project = {
  id: string;
  title: string;
  path: string;
  totalTickets: number;
  openTickets: number;
  doneTickets: number;
};

type ServiceRequest = { method: string; path: string; query?: Record<string, string>; body?: string };

type PanelConfig = {
  projects: Project[];
  tickets: Record<string, Ticket[]>;
  /** Advertised contract version; `undefined` = pre-TICKET-HARNESS-88 host. */
  contractVersion?: number;
  /** Projects whose list request answers 500. */
  failingProjects?: string[];
  /** Ticket ids whose body request answers 413. */
  tooLargeTickets?: string[];
};

type HappyDomWindow = { document: any; [key: string]: any };

const loadHappyDom = async (): Promise<{ Window: new (options?: unknown) => HappyDomWindow }> => {
  const requireFromUi = createRequire(path.join(REPO_ROOT, 'packages', 'ui', 'package.json'));
  const entry = requireFromUi.resolve('happy-dom');
  return (await import(pathToFileURL(entry).href)) as { Window: new (options?: unknown) => HappyDomWindow };
};

const READY_THEME_TOKENS = {
  background: '#111', elevated: '#1a1a1a', foreground: '#eee', muted: '#666', subtle: '#222', border: '#333',
  hover: '#2a2a2a', selection: '#334', focus: '#4af', primary: '#4af', mutedSurface: '#f4f4f5',
  elevatedForeground: '#111', active: '#e5e5e5', selectionForeground: '#111', primaryForeground: '#fff',
  primaryText: '#123456', successText: '#244433', warningText: '#664422', errorText: '#882233', infoText: '#334488',
  success: '#16a34a', warning: '#d97706', error: '#dc2626', info: '#2563eb',
  font: 'SF Pro Text, sans-serif', mono: 'Menlo, monospace', radius: '9px',
};

const buildReadyMessage = () => ({
  channel: 'openchamber.sdk',
  v: 1,
  type: 'ready',
  payload: {
    theme: { mode: 'dark', tokens: READY_THEME_TOKENS },
    locale: 'pt-BR',
    directory: '/repo',
    session: null,
    surface: 'panel',
    connection: { connected: false, account: '' },
    settings: {},
    item: null,
  },
});

type PanelHarness = {
  win: HappyDomWindow;
  hostDocument: any;
  guest: HappyDomWindow;
  requests: ServiceRequest[];
  bodyRequests: () => ServiceRequest[];
  cards: () => any[];
  cardFor: (id: string) => any;
  bannerText: () => string;
  bannerHidden: () => boolean;
  subtitle: () => string;
  projectErrors: () => any[];
  tabIds: () => string[];
  click: (node: any) => void;
};

const bootPanel = async (config: PanelConfig): Promise<PanelHarness> => {
  const { Window } = await loadHappyDom();
  const win = new Window({ url: 'http://localhost/' });
  const hostDocument = win.document;
  hostDocument.body.innerHTML = '<iframe id="guest-frame"></iframe>';
  const iframe = hostDocument.getElementById('guest-frame');
  const guest = iframe.contentWindow as HappyDomWindow;
  guest.document.body.innerHTML = '<div id="root" class="kb-root" aria-busy="true"></div>';

  const requests: ServiceRequest[] = [];
  const tooLarge = new Set(config.tooLargeTickets ?? []);

  const listPayload = (project: string) => {
    const full = config.tickets[project] ?? [];
    // v2 slices every ticket: the description lives behind the ticket endpoint.
    // A legacy host (no `contractVersion`) still ships the full document.
    const sliced =
      config.contractVersion === undefined
        ? full
        : full.map((entry) => ({ ...entry, body: undefined }));
    const payload: Record<string, unknown> = {
      project,
      meta: { version: 1, project, title: config.projects.find((p) => p.id === project)?.title ?? project, updated_at: NOW },
      tickets: sliced,
    };
    if (config.contractVersion !== undefined) payload['contractVersion'] = config.contractVersion;
    return payload;
  };

  const respond = (request: ServiceRequest): { status: number; body: string } => {
    const project = request.query?.['project'] ?? '';
    const ticketId = request.query?.['ticketId'] ?? '';

    if (request.path === '/api/projects') {
      return { status: 200, body: JSON.stringify({ projects: config.projects }) };
    }

    if (request.path === '/api/kanban') {
      if ((config.failingProjects ?? []).includes(project)) {
        return {
          status: 500,
          body: JSON.stringify({ error: { code: 'project-unavailable', message: `kanban.json de ${project} indisponível` } }),
        };
      }
      return { status: 200, body: JSON.stringify(listPayload(project)) };
    }

    if (request.path === '/api/kanban/ticket') {
      if (tooLarge.has(ticketId)) {
        return {
          status: 413,
          body: JSON.stringify({
            error: {
              code: 'response-too-large',
              message: 'Guest response is above the 2097152-character budget (2097153 characters read).',
              limit: 2097152,
              received: 2097153,
            },
          }),
        };
      }
      const ticket = (config.tickets[project] ?? []).find((entry) => entry.id === ticketId);
      if (!ticket) {
        return { status: 404, body: JSON.stringify({ error: { code: 'unknown-ticket', message: `sem ${ticketId}` } }) };
      }
      const payload: Record<string, unknown> = { project, ticket };
      if (config.contractVersion !== undefined) payload['contractVersion'] = config.contractVersion;
      return { status: 200, body: JSON.stringify(payload) };
    }

    return { status: 404, body: JSON.stringify({ error: { code: 'not-found', message: `no route ${request.path}` } }) };
  };

  win.addEventListener('message', (event: any) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.type !== 'service-request') return;
    const payload = message.payload as ServiceRequest;
    requests.push(payload);
    guest.postMessage(
      { channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload: respond(payload) },
      '*',
    );
  });

  guest.eval(PANEL_SOURCE);
  guest.postMessage(buildReadyMessage(), '*');

  const cards = () => Array.from(guest.document.querySelectorAll('.kb-card')) as any[];

  return {
    win,
    hostDocument,
    guest,
    requests,
    bodyRequests: () => requests.filter((request) => request.path === '/api/kanban/ticket'),
    cards,
    cardFor: (id: string) => cards().find((card) => card.querySelector('.kb-id')?.textContent === id),
    bannerText: () => guest.document.querySelector('.kb-banner-text')?.textContent ?? '',
    bannerHidden: () => guest.document.querySelector('.kb-banner')?.hidden === true,
    subtitle: () => guest.document.querySelector('.kb-heading-sub')?.textContent ?? '',
    projectErrors: () => Array.from(guest.document.querySelectorAll('.kb-project-error')) as any[],
    tabIds: () =>
      (Array.from(guest.document.querySelectorAll('.kb-tab')) as any[]).map(
        (node) => node.getAttribute('data-tab-id') as string,
      ),
    click: (node: any) => node.dispatchEvent(new guest.MouseEvent('click', { bubbles: true, cancelable: true })),
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ticket = (id: string, order = 0): Ticket => ({
  id,
  title: `Ticket ${id}`,
  status: 'open',
  priority: 'media',
  summary: `Resumo ${id}`,
  body: `# Corpo ${id}`,
  order,
  created_at: NOW,
  completed_at: null,
});

const project = (id: string, title: string): Project => ({
  id,
  title,
  path: `/repos/${id}`,
  totalTickets: 1,
  openTickets: 1,
  doneTickets: 0,
});

const TWO_PROJECTS: PanelConfig = {
  contractVersion: CONTRACT_V2,
  projects: [project('alpha', 'Alpha'), project('beta', 'Beta')],
  tickets: { alpha: [ticket('KB-1')], beta: [ticket('KB-2')] },
};

/* ================================================================== *
 * F5 — sliced list + body on demand
 * ================================================================== */

describe('panel v2: body is fetched on demand (TICKET-HARNESS-88 · F5)', () => {
  test('the list renders without descriptions and requests none up front', async () => {
    expect(fs.existsSync(BUILT_PANEL), `missing built bundle: ${BUILT_PANEL}`).toBe(true);
    const h = await bootPanel(TWO_PROJECTS);
    await waitFor(() => h.cards().length === 2);

    expect(h.bodyRequests().length).toBe(0);
    const card = h.cardFor('KB-1');
    expect(card).toBeDefined();
    expect(card.textContent).not.toContain('Corpo KB-1');
    // `summary` stays in the list: it is the collapsed preview.
    expect(card.textContent).toContain('Resumo KB-1');
  });

  test('expanding a card fetches the body exactly once and caches it', async () => {
    const h = await bootPanel(TWO_PROJECTS);
    await waitFor(() => h.cards().length === 2);

    h.click(h.cardFor('KB-1').querySelector('.kb-card-head'));
    await waitFor(() => (h.cardFor('KB-1')?.querySelector('.kb-body')?.textContent ?? '').includes('Corpo KB-1'));

    const sent = h.bodyRequests();
    expect(sent.length).toBe(1);
    expect(sent[0]?.query).toEqual({ project: 'alpha', ticketId: 'KB-1' });

    // Collapse and expand again: the cached body is reused, no second request.
    h.click(h.cardFor('KB-1').querySelector('.kb-card-head'));
    h.click(h.cardFor('KB-1').querySelector('.kb-card-head'));
    await waitFor(() => (h.cardFor('KB-1')?.querySelector('.kb-body')?.textContent ?? '').includes('Corpo KB-1'));
    expect(h.bodyRequests().length).toBe(1);
  });

  test('legacy host (no contractVersion, bodies inline) never hits the ticket route', async () => {
    const legacy: PanelConfig = {
      projects: [project('alpha', 'Alpha')],
      tickets: { alpha: [ticket('KB-1')] },
    };
    const h = await bootPanel(legacy);
    await waitFor(() => h.cards().length === 1);

    h.click(h.cardFor('KB-1').querySelector('.kb-card-head'));
    await waitFor(() => (h.cardFor('KB-1')?.querySelector('.kb-body')?.textContent ?? '').includes('Corpo KB-1'));
    expect(h.bodyRequests().length).toBe(0);
  });
});

/* ================================================================== *
 * F6 — the aggregate tab is honest about partial failure
 * ================================================================== */

describe('panel v2: "Todos" announces partial failures (TICKET-HARNESS-88 · F6)', () => {
  const partial: PanelConfig = {
    contractVersion: CONTRACT_V2,
    projects: [project('alpha', 'Alpha'), project('beta', 'Beta'), project('gamma', 'Gamma')],
    tickets: { alpha: [ticket('KB-1')], beta: [ticket('KB-2')], gamma: [ticket('KB-3')] },
    failingProjects: ['beta'],
  };

  test('a failed project keeps its tab, renders a named warning and is not counted as zero', async () => {
    const h = await bootPanel(partial);
    await waitFor(() => h.cards().length === 2);

    // No project disappears from the tab bar.
    expect(h.tabIds()).toContain('beta');

    const errors = h.projectErrors();
    expect(errors.length).toBe(1);
    expect(errors[0].textContent).toContain('Beta');
    expect(errors[0].textContent).toContain('indisponível');
    expect(errors[0].getAttribute('data-project')).toBe('beta');

    // Banner names the failing project instead of swallowing the rejection.
    expect(h.bannerHidden()).toBe(false);
    expect(h.bannerText()).toContain('Falha parcial');
    expect(h.bannerText()).toContain('Beta');

    // Subtitle is explicitly partial — never a clean, misleading zero.
    expect(h.subtitle()).toContain('parcial');
    expect(h.subtitle()).toContain('1 projeto com falha');
  });

  test('when every project fails the full-page error is used and no cards are invented', async () => {
    const total: PanelConfig = {
      contractVersion: CONTRACT_V2,
      projects: [project('alpha', 'Alpha'), project('beta', 'Beta')],
      tickets: { alpha: [ticket('KB-1')], beta: [ticket('KB-2')] },
      failingProjects: ['alpha', 'beta'],
    };
    const h = await bootPanel(total);
    await waitFor(() => h.bannerText().includes('indisponível'));
    expect(h.cards().length).toBe(0);
    expect(h.subtitle()).toContain('falha ao carregar');
    expect(h.subtitle()).not.toContain('aberto');
    expect(h.subtitle()).not.toContain('parcial');
  });
});

/* ================================================================== *
 * F7 — lockstep guard
 * ================================================================== */

describe('panel v2: explicit version error on lockstep mismatch (TICKET-HARNESS-88 · F7)', () => {
  test('contractVersion 3 fails loudly instead of rendering an empty board', async () => {
    const h = await bootPanel({ ...TWO_PROJECTS, contractVersion: 3 });
    await waitFor(() => h.bannerText().includes('Contrato incompatível'));

    expect(h.bannerHidden()).toBe(false);
    expect(h.bannerText()).toContain('v3');
    expect(h.bannerText()).toContain('v2');
    expect(h.bannerText()).toContain('lockstep');
    expect(h.cards().length).toBe(0);
    expect(h.bannerText()).not.toContain('invalid-json');
  });
});

/* ================================================================== *
 * F4 — 413 never reaches the panel as a silent truncation
 * ================================================================== */

describe('panel v2: 413 response-too-large is actionable (TICKET-HARNESS-88 · F4)', () => {
  test('the service message is shown on the card, with a working retry', async () => {
    const h = await bootPanel({
      contractVersion: CONTRACT_V2,
      projects: [project('alpha', 'Alpha')],
      tickets: { alpha: [ticket('KB-1')] },
      tooLargeTickets: ['KB-1'],
    });
    await waitFor(() => h.cards().length === 1);

    h.click(h.cardFor('KB-1').querySelector('.kb-card-head'));
    await waitFor(() => (h.cardFor('KB-1')?.querySelector('.kb-card-error')?.textContent ?? '').includes('2097152'));

    const alert = h.cardFor('KB-1').querySelector('.kb-card-error');
    expect(alert.textContent).toContain('budget');
    expect(h.cardFor('KB-1').querySelector('.kb-body-retry')).not.toBeNull();

    // Retry is a real re-fetch (the card is not stuck on the failure).
    h.click(h.cardFor('KB-1').querySelector('.kb-body-retry'));
    await waitFor(() => h.bodyRequests().length === 2);
    await waitFor(() => (h.cardFor('KB-1')?.querySelector('.kb-card-error')?.textContent ?? '').includes('2097152'));
  });
});
