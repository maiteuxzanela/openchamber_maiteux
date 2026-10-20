/**
 * Deterministic, mock-free suite for TICKET-HARNESS-70:
 * the Kanban panel must open on the tab that matches the workspace directory
 * reported by the host, follow later `directory` pushes, and never override a
 * tab the user picked by hand.
 *
 * Everything under test is the REAL shipped bundle produced by
 * `bun run extensions:build` (packages/web/server/built-in-extensions/kanban/
 * panel/main.js), evaluated in a REAL happy-dom guest frame and driven through
 * the REAL `@openchamber/sdk` transport (`ready` + `directory` pushes and
 * `service-request`/`result` round-trips). No module is stubbed, no timer is
 * faked and no internal function is monkey-patched: the only observable inputs
 * are the host messages and the service HTTP requests the panel really issues.
 *
 * Mutation-testing seam ONLY: `OPENCHAMBER_KANBAN_PANEL_BUNDLE` may point at a
 * mutated copy of the bundle to prove each assertion is sensitive (it must fail
 * when the fix is removed). Unset in normal runs, so the suite always exercises
 * the real shipped bundle.
 *
 * Run: bun test packages/extensions/kanban/tests/kanban_active_repo_tab.test.ts
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_PANEL = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions', 'kanban', 'panel', 'main.js');

const PANEL_BUNDLE = process.env['OPENCHAMBER_KANBAN_PANEL_BUNDLE']
  ? path.resolve(process.env['OPENCHAMBER_KANBAN_PANEL_BUNDLE'])
  : BUILT_PANEL;

const PANEL_SOURCE = fs.readFileSync(PANEL_BUNDLE, 'utf8');

/** Frozen wall-clock so every served payload is byte-stable. */
const NOW = '2026-10-20T09:00:00-03:00';

/* ------------------------------------------------------------------ *
 * Contract types (CONTRACT_KANBAN.md §1/§2)
 * ------------------------------------------------------------------ */

type TicketStatus = 'open' | 'done';
type TicketPriority = 'alta' | 'media' | 'baixa';

type Ticket = {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  summary: string;
  body: string;
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
  /** `directory` carried by the real `ready` handshake. */
  directory: string | null;
  /** Authoritative list served by `GET /api/projects`. */
  projects: Project[];
  tickets?: Record<string, Ticket[]>;
};

/* ------------------------------------------------------------------ *
 * happy-dom bootstrap
 * ------------------------------------------------------------------ */

type HappyDomWindow = {
  document: any;
  [key: string]: any;
};

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

const buildReadyMessage = (directory: string | null) => ({
  channel: 'openchamber.sdk',
  v: 1,
  type: 'ready',
  payload: {
    theme: { mode: 'dark', tokens: READY_THEME_TOKENS },
    locale: 'pt-BR',
    directory,
    session: null,
    surface: 'panel',
    connection: { connected: false, account: '' },
    settings: {},
    item: null,
  },
});

/* ------------------------------------------------------------------ *
 * Host transport (parent frame) + in-frame bundle execution
 * ------------------------------------------------------------------ */

type PanelHarness = {
  guest: HappyDomWindow;
  requests: ServiceRequest[];
  activeTabId: () => string | null;
  activeTabLabel: () => string;
  tabIds: () => string[];
  cards: () => any[];
  cardIds: () => string[];
  tabButton: (id: string) => any;
  click: (node: any) => void;
  sendDirectory: (directory: string | null) => void;
  kanbanRequests: () => ServiceRequest[];
  kanbanProjectsRequested: () => string[];
};

const projectTitle = (config: PanelConfig, id: string): string =>
  config.projects.find((project) => project.id === id)?.title ?? id;

const bootPanel = async (config: PanelConfig): Promise<PanelHarness> => {
  const { Window } = await loadHappyDom();
  const win = new Window({ url: 'http://localhost/' });
  const hostDocument = win.document;
  hostDocument.body.innerHTML = '<iframe id="guest-frame"></iframe>';
  const iframe = hostDocument.getElementById('guest-frame');
  const guest = iframe.contentWindow as HappyDomWindow;
  guest.document.body.innerHTML = '<div id="root" class="kb-root" aria-busy="true"></div>';

  const requests: ServiceRequest[] = [];

  const respond = (payload: ServiceRequest): { status: number; body: string } => {
    if (payload.path === '/api/projects') {
      return { status: 200, body: JSON.stringify({ projects: config.projects }) };
    }
    if (payload.path === '/api/kanban') {
      const project = payload.query?.['project'] ?? '';
      return {
        status: 200,
        body: JSON.stringify({
          project,
          meta: { version: 1, project, title: projectTitle(config, project), updated_at: NOW },
          tickets: config.tickets?.[project] ?? [],
        }),
      };
    }
    return { status: 404, body: JSON.stringify({ error: { code: 'not-found', message: `no route ${payload.path}` } }) };
  };

  // The parent frame's half of the SDK protocol: real `postMessage` traffic.
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

  // Execute the real IIFE bundle in the guest frame's own global scope.
  guest.eval(PANEL_SOURCE);
  // Real SDK handshake: the panel registers `onReady` at load, so replay it.
  guest.postMessage(buildReadyMessage(config.directory), '*');

  const tabButtons = (): any[] => Array.from(guest.document.querySelectorAll('.kb-tab')) as any[];
  const kanbanRequests = (): ServiceRequest[] => requests.filter((request) => request.path === '/api/kanban');
  const tabButton = (id: string): any => {
    const found = tabButtons().find((node) => node.getAttribute('data-tab-id') === id);
    if (!found) throw new Error(`tab ${id} not found; tabs=${tabButtons().map((node) => node.getAttribute('data-tab-id')).join(',')}`);
    return found;
  };

  return {
    guest,
    requests,
    activeTabId: () =>
      guest.document.querySelector('.kb-tab[aria-selected="true"]')?.getAttribute('data-tab-id') ?? null,
    activeTabLabel: () =>
      guest.document.querySelector('.kb-tab[aria-selected="true"] .kb-tab-label')?.textContent ?? '',
    tabIds: () => tabButtons().map((node) => node.getAttribute('data-tab-id') as string),
    cards: () => Array.from(guest.document.querySelectorAll('.kb-card')) as any[],
    cardIds: () =>
      (Array.from(guest.document.querySelectorAll('.kb-card .kb-id')) as any[]).map((node) => node.textContent as string),
    tabButton,
    click: (node: any) => {
      node.dispatchEvent(new guest.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    sendDirectory: (directory: string | null) => {
      // Exactly the push the SDK host sends when the workspace changes.
      guest.postMessage({ channel: 'openchamber.sdk', v: 1, type: 'directory', payload: { directory } }, '*');
    },
    kanbanRequests,
    kanbanProjectsRequested: () => kanbanRequests().map((request) => request.query?.['project'] ?? ''),
  };
};

/* ------------------------------------------------------------------ *
 * State-based waits (no arbitrary sleeps in positive assertions)
 * ------------------------------------------------------------------ */

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Bounded window used ONLY to prove that something does NOT happen. */
const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Fixtures — canonical checkout paths
 * ------------------------------------------------------------------ */

const HARNESS_PATH = '/mnt/94CCB337CCB3130A/opencode_chambers_harness';
const PREDICTERA_PATH = '/mnt/94CCB337CCB3130A/predictera';
const PANELA_PATH = '/home/maiteuxzanela/PanelaBuild';
const JEZ_PATH = '/mnt/94CCB337CCB3130A/JEZ collections';
const FATURAMENTO_PATH = '/mnt/94CCB337CCB3130A/Faturamento';

const openTicket = (id: string, order = 0): Ticket => ({
  id,
  title: `Ticket ${id}`,
  status: 'open',
  priority: 'alta',
  summary: `Resumo ${id}`,
  body: `# Corpo ${id}`,
  order,
  created_at: NOW,
  completed_at: null,
});

const project = (id: string, title: string, projectPath: string, open = 1): Project => ({
  id,
  title,
  path: projectPath,
  totalTickets: open,
  openTickets: open,
  doneTickets: 0,
});

const HARNESS_PROJECT = project('opencode_chambers_harness', 'OpenCode Chambers Harness', HARNESS_PATH);
const PREDICTERA_PROJECT = project('predictera', 'Predictera', PREDICTERA_PATH);
// Authoritative service path carries a trailing slash on purpose: the panel
// must normalise the service-side path too.
const PANELA_PROJECT = project('panela_sobra', 'Panela de Sobra', `${PANELA_PATH}/`);
const JEZ_PROJECT = project('jez_collections', 'JEZ Collections', JEZ_PATH);
const FATURAMENTO_PROJECT = project('faturamento_medico', 'Faturamento Médico', FATURAMENTO_PATH);

const CANONICAL_SUBSET: Project[] = [PREDICTERA_PROJECT, PANELA_PROJECT, JEZ_PROJECT, FATURAMENTO_PROJECT, HARNESS_PROJECT];

const CANONICAL_TICKETS: Record<string, Ticket[]> = {
  opencode_chambers_harness: [openTicket('H-70', 0)],
  predictera: [openTicket('P-1', 0)],
  panela_sobra: [openTicket('PA-1', 0)],
  jez_collections: [openTicket('J-1', 0)],
  faturamento_medico: [openTicket('F-1', 0)],
};

/* ================================================================== *
 * (1) Initial tab derived from the host workspace directory
 * ================================================================== */

describe('panel: initial tab follows the host workspace directory (TICKET-HARNESS-70)', () => {
  test('the shipped bundle exists and boots in the real DOM', () => {
    expect(fs.existsSync(PANEL_BUNDLE), `missing built bundle: ${PANEL_BUNDLE}`).toBe(true);
  });

  test('harness checkout (with trailing slash) opens on opencode_chambers_harness and loads its tickets', async () => {
    const h = await bootPanel({
      directory: `${HARNESS_PATH}/`,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.activeTabId() !== null);
    expect(h.activeTabId()).toBe('opencode_chambers_harness');
    expect(h.activeTabLabel()).toBe('OpenCode Chambers Harness');

    await waitFor(() => h.cardIds().includes('H-70'));
    expect(h.kanbanProjectsRequested()).toContain('opencode_chambers_harness');
    expect(h.cardIds()).toEqual(['H-70']);
    // Todos loads every project; the workspace tab loads exactly one.
    expect(h.kanbanRequests().length).toBe(1);
  });

  test('predictera checkout (trailing slash on both sides) opens on predictera', async () => {
    const h = await bootPanel({
      directory: `${PREDICTERA_PATH}/`,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().includes('P-1'));
    expect(h.activeTabId()).toBe('predictera');
    expect(h.activeTabLabel()).toBe('Predictera');
    expect(h.kanbanProjectsRequested()).toEqual(['predictera']);
  });

  test('a subdirectory of a project matches by path ancestry (PanelaAndroid -> panela_sobra)', async () => {
    const h = await bootPanel({
      directory: `${PANELA_PATH}/PanelaAndroid`,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().includes('PA-1'));
    expect(h.activeTabId()).toBe('panela_sobra');
    expect(h.activeTabLabel()).toBe('Panela de Sobra');
    expect(h.kanbanProjectsRequested()).toEqual(['panela_sobra']);
  });

  test('a sibling path that only shares a name prefix does not match (/PanelaBuildXYZ)', async () => {
    const h = await bootPanel({
      directory: `${PANELA_PATH}XYZ/nested`,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.tabIds().length > 1 && h.cards().length > 0);
    expect(h.activeTabId()).toBe('todos');
  });

  test('a null host directory opens on Todos and aggregates every project', async () => {
    const h = await bootPanel({ directory: null, projects: CANONICAL_SUBSET, tickets: CANONICAL_TICKETS });

    await waitFor(() => h.cardIds().length === CANONICAL_SUBSET.length);
    expect(h.activeTabId()).toBe('todos');
    expect(h.activeTabLabel()).toBe('Todos');
    expect(h.kanbanProjectsRequested().sort()).toEqual(CANONICAL_SUBSET.map((item) => item.id).sort());
  });

  test('an unknown checkout (/tmp/desconhecido) falls back to Todos', async () => {
    const h = await bootPanel({
      directory: '/tmp/desconhecido',
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().length === CANONICAL_SUBSET.length);
    expect(h.activeTabId()).toBe('todos');
  });
});

/* ================================================================== *
 * (2) Live directory pushes — follow the host, respect the user
 * ================================================================== */

describe('panel: host directory pushes update the active tab (TICKET-HARNESS-70)', () => {
  test('a directory push switches the active tab and reloads that project', async () => {
    const h = await bootPanel({
      directory: HARNESS_PATH,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().includes('H-70'));
    expect(h.activeTabId()).toBe('opencode_chambers_harness');

    h.sendDirectory(`${PANELA_PATH}/PanelaAndroid`);

    await waitFor(() => h.activeTabId() === 'panela_sobra');
    await waitFor(() => h.cardIds().includes('PA-1'));
    expect(h.kanbanProjectsRequested()).toContain('panela_sobra');
    expect(h.cardIds()).toEqual(['PA-1']);

    // Back to an unknown workspace: the aggregate tab again.
    h.sendDirectory('/tmp/outro-lugar');
    await waitFor(() => h.activeTabId() === 'todos');
    await waitFor(() => h.cardIds().length === CANONICAL_SUBSET.length);
  });

  test('every directory push is applied through the same mount (no remount / no tab reset)', async () => {
    const h = await bootPanel({
      directory: PREDICTERA_PATH,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().includes('P-1'));
    const tabs = h.guest.document.querySelector('.kb-tabs');
    const firstButton = h.tabButton('predictera');

    h.sendDirectory(HARNESS_PATH);
    await waitFor(() => h.activeTabId() === 'opencode_chambers_harness');
    await waitFor(() => h.cardIds().includes('H-70'));

    expect(h.guest.document.querySelector('.kb-tabs')).toBe(tabs);
    expect(h.tabButton('predictera')).toBe(firstButton);
  });

  test('a manual tab click wins over later directory pushes (userSelectedTab)', async () => {
    const h = await bootPanel({
      directory: HARNESS_PATH,
      projects: CANONICAL_SUBSET,
      tickets: CANONICAL_TICKETS,
    });

    await waitFor(() => h.cardIds().includes('H-70'));
    h.click(h.tabButton('jez_collections'));
    await waitFor(() => h.activeTabId() === 'jez_collections');
    await waitFor(() => h.cardIds().includes('J-1'));

    const requestsBefore = h.requests.length;
    h.sendDirectory(FATURAMENTO_PATH);
    await settle(200);

    expect(h.activeTabId()).toBe('jez_collections');
    expect(h.activeTabLabel()).toBe('JEZ Collections');
    expect(h.cardIds()).toEqual(['J-1']);
    expect(h.kanbanProjectsRequested()).not.toContain('faturamento_medico');
    expect(h.requests.length).toBe(requestsBefore);
  });
});

/* ================================================================== *
 * (3) Revalidation against GET /api/projects before the ticket fetch
 * ================================================================== */

describe('panel: the authoritative project list revalidates the initial tab (TICKET-HARNESS-70)', () => {
  test('a workspace unknown to the canonical mirror opens its tab once the service answers', async () => {
    const customPath = '/tmp/desconhecido';
    const projects = [
      project('custom_checkout', 'Custom Checkout', customPath),
      project('other_checkout', 'Other Checkout', '/tmp/outro-checkout'),
    ];
    const h = await bootPanel({
      directory: `${customPath}/app`,
      projects,
      tickets: { custom_checkout: [openTicket('C-1')], other_checkout: [openTicket('O-1')] },
    });

    await waitFor(() => h.activeTabId() === 'custom_checkout');
    await waitFor(() => h.cardIds().includes('C-1'));
    expect(h.activeTabLabel()).toBe('Custom Checkout');
    // load() must have read the revalidated tab: only the matching project is fetched.
    expect(h.kanbanProjectsRequested()).toEqual(['custom_checkout']);
  });

  test('a canonical match that the service no longer lists falls back to Todos and loads all service projects', async () => {
    const projects = [
      project('custom_checkout', 'Custom Checkout', '/tmp/desconhecido'),
      project('other_checkout', 'Other Checkout', '/tmp/outro-checkout'),
    ];
    const h = await bootPanel({
      directory: HARNESS_PATH,
      projects,
      tickets: { custom_checkout: [openTicket('C-1')], other_checkout: [openTicket('O-1')] },
    });

    await waitFor(() => h.activeTabId() === 'todos');
    await waitFor(() => h.cardIds().length === 2);
    expect(h.kanbanProjectsRequested().sort()).toEqual(['custom_checkout', 'other_checkout']);
    expect(h.cardIds().sort()).toEqual(['C-1', 'O-1']);
  });
});
