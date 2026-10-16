/**
 * Deterministic, mock-free interaction suite for the Kanban panel
 * (TICKET-HARNESS-31: "aba exige pousar o mouse" / "switch não conclui o ticket").
 *
 * It exercises the REAL shipped panel bundle produced by
 * `bun run extensions:build` (packages/web/server/built-in-extensions/kanban/
 * panel/main.js), executed inside a REAL DOM (happy-dom) and driven through the
 * REAL SDK `service-request` transport.
 *
 * Nothing under test is stubbed or monkey-patched:
 *   · the guest frame is a real happy-dom `<iframe>`; the bundle is evaluated
 *     in that frame's own global scope, so it uses ITS `window`/`document`,
 *   · the host transport is a faithful emulation of the parent frame: it listens
 *     for the guest's `postMessage` calls and replies with real `result`
 *     messages (exactly the protocol `@openchamber/sdk` speaks), returning the
 *     verbatim `kanban.json` documents served to the panel in production,
 *   · events (click / pointerdown / mousedown / change / focus) are dispatched
 *     as real DOM events, not synthetic call-throughs.
 *
 * Covers the two production changes:
 *   (A) the `.kb-switch` label stops propagation on `click`, `pointerdown` and
 *       `mousedown`, so the accordion head's `click` handler (`setExpanded`)
 *       never runs and the toggle's `change` reaches `toggleTicket`;
 *   (B) `renderTabs()` reconciles the tab strip in place — the exact same
 *       `<button class="kb-tab">` node objects survive consecutive renders
 *       (never `tabs.textContent = ''`), and the window `focus` listener is
 *       guarded by a cooldown so entering the frame does not destroy the button
 *       between `mousedown` and `mouseup`.
 *
 * Mutation-testing seam ONLY: `OPENCHAMBER_KANBAN_PANEL_BUNDLE` may point at a
 * mutated copy of the bundle to prove an assertion is sensitive (it must fail
 * when the fix is removed). Unset in normal runs, so the suite always exercises
 * the real shipped bundle.
 *
 * Run: bun test packages/extensions/kanban/tests/kanban_panel_interaction.test.ts
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
const NOW = '2026-10-16T12:00:00-03:00';

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

type PanelConfig = {
  projects: Project[];
  tickets?: Record<string, Ticket[]>;
};

type ServiceRequest = { method: string; path: string; query?: Record<string, string>; body?: string };
type ToggleBody = { project: string; ticketId: string; done: boolean };

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

/* ------------------------------------------------------------------ *
 * Host transport (the parent frame) + in-frame bundle execution
 * ------------------------------------------------------------------ */

type PanelHarness = {
  win: HappyDomWindow;
  /** The host frame's document (owns the iframe). */
  hostDocument: any;
  /** The guest frame's window — the panel actually runs here. */
  guest: HappyDomWindow;
  requests: ServiceRequest[];
  toggles: ToggleBody[];
  tabs: () => any;
  tabButtons: () => Array<{ id: string; node: any }>;
  tabState: (id: string) => { selected: string | null; tabIndex: number; count: string | null };
  activeTabId: () => string | null;
  cards: () => any[];
  cardFor: (id: string) => any;
  refreshButton: () => any;
  rootBusy: () => boolean;
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
  const toggles: ToggleBody[] = [];

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
    if (payload.path === '/api/toggle') {
      const body = JSON.parse(payload.body ?? '{}') as ToggleBody;
      toggles.push(body);
      return {
        status: 200,
        body: JSON.stringify({
          ok: true,
          ticket: { id: body.ticketId, status: body.done ? 'done' : 'open', completed_at: body.done ? NOW : null },
          updated_at: NOW,
        }),
      };
    }
    return { status: 404, body: JSON.stringify({ error: { code: 'not-found', message: `no route ${payload.path}` } }) };
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

  // Execute the real IIFE bundle in the guest frame's own global scope.
  guest.eval(PANEL_SOURCE);
  // Real SDK handshake: the panel registers `onReady` at load, so replay it.
  guest.postMessage(buildReadyMessage(), '*');

  const cards = () => Array.from(guest.document.querySelectorAll('.kb-card')) as any[];
  const tabButtons = () =>
    (Array.from(guest.document.querySelectorAll('.kb-tab')) as any[]).map((node) => ({
      id: node.getAttribute('data-tab-id') as string,
      node,
    }));

  return {
    win,
    hostDocument,
    guest,
    requests,
    toggles,
    tabs: () => guest.document.querySelector('.kb-tabs'),
    tabButtons,
    tabState: (id: string) => {
      const found = tabButtons().find((tab) => tab.id === id);
      if (!found) throw new Error(`tab ${id} not found`);
      const count = found.node.querySelector('.kb-tab-count');
      return {
        selected: found.node.getAttribute('aria-selected'),
        tabIndex: found.node.tabIndex,
        count: count ? count.textContent : null,
      };
    },
    activeTabId: () => guest.document.querySelector('.kb-tab[aria-selected="true"]')?.getAttribute('data-tab-id') ?? null,
    cards,
    cardFor: (id: string) => cards().find((card) => card.querySelector('.kb-id')?.textContent === id),
    refreshButton: () => guest.document.querySelector('.kb-refresh'),
    rootBusy: () => guest.document.querySelector('#root')?.getAttribute('aria-busy') === 'true',
  };
};

/* ------------------------------------------------------------------ *
 * State-based waits (no arbitrary sleeps in assertions)
 * ------------------------------------------------------------------ */

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const click = (h: PanelHarness, node: any): void => {
  node.dispatchEvent(new h.guest.MouseEvent('click', { bubbles: true, cancelable: true }));
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

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

const projectSummary = (id: string, title: string): Project => ({
  id,
  title,
  path: `/repos/${id}`,
  totalTickets: 1,
  openTickets: 1,
  doneTickets: 0,
});

const SINGLE_PROJECT: PanelConfig = {
  projects: [projectSummary('projeto_jev', 'Projeto JEV')],
  tickets: { projeto_jev: [openTicket('KB-1')] },
};

const TWO_PROJECTS: PanelConfig = {
  projects: [projectSummary('projeto_jev', 'Projeto JEV'), projectSummary('jez_collections', 'JEZ Collections')],
  tickets: { projeto_jev: [openTicket('KB-1')], jez_collections: [openTicket('KB-2')] },
};

/* ================================================================== *
 * (A) The completion switch never leaks into the accordion
 * ================================================================== */

describe('panel: .kb-switch stops propagation into the accordion head (TICKET-HARNESS-31)', () => {
  test('the shipped bundle exists and boots into a live DOM', async () => {
    expect(fs.existsSync(PANEL_BUNDLE), `missing built bundle: ${PANEL_BUNDLE}`).toBe(true);
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);
    expect(h.guest.document.querySelector('.kb-tabs')).not.toBeNull();
    expect(h.cards().length).toBe(1);
  });

  test('click / pointerdown / mousedown on .kb-switch do not bubble and never expand the card', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    const card = h.cardFor('KB-1');
    expect(card).toBeDefined();
    const head = card.querySelector('.kb-card-head');
    expect(head.getAttribute('aria-expanded')).toBe('false');

    // Observer ABOVE the switch, in the bubbling phase: it only sees the event
    // if `.kb-switch` failed to stop propagation.
    const seen = { click: 0, pointerdown: 0, mousedown: 0 };
    for (const type of ['click', 'pointerdown', 'mousedown'] as const) {
      h.hostDocument.addEventListener(type, () => { seen[type] += 1; });
      card.addEventListener(type, () => { seen[type] += 1; });
    }

    const switchEl = card.querySelector('.kb-switch');
    expect(switchEl).toBeTruthy();
    switchEl.dispatchEvent(new h.guest.MouseEvent('click', { bubbles: true, cancelable: true }));
    switchEl.dispatchEvent(new h.guest.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    switchEl.dispatchEvent(new h.guest.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    // Synchronous assertions: the head's click handler (setExpanded -> render)
    // runs synchronously if the event leaked.
    expect(seen).toEqual({ click: 0, pointerdown: 0, mousedown: 0 });
    expect(h.guest.document.querySelectorAll('.kb-card--expanded').length).toBe(0);
    expect(h.guest.document.querySelectorAll('.kb-body').length).toBe(0);
    for (const node of Array.from(h.guest.document.querySelectorAll('.kb-card-head')) as any[]) {
      expect(node.getAttribute('aria-expanded')).toBe('false');
    }
  });

  test('clicking .kb-card-head itself still toggles the accordion (positive control)', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    const head = h.cardFor('KB-1').querySelector('.kb-card-head');
    click(h, head);

    // The accordion handler is synchronous; prove it is alive and reachable.
    await waitFor(() => h.guest.document.querySelectorAll('.kb-card--expanded').length === 1);
    const expandedHead = h.guest.document.querySelector('.kb-card--expanded .kb-card-head');
    expect(expandedHead.getAttribute('aria-expanded')).toBe('true');
    expect(h.guest.document.querySelectorAll('.kb-body').length).toBe(1);
  });

  test('the switch input change calls the service and completes the ticket', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    const input = h.cardFor('KB-1').querySelector('input[role="switch"]');
    expect(input).toBeTruthy();
    expect(input.checked).toBe(false);

    input.checked = true;
    input.dispatchEvent(new h.guest.Event('change', { bubbles: true }));

    await waitFor(() => h.toggles.length >= 1);
    expect(h.toggles).toEqual([{ project: 'projeto_jev', ticketId: 'KB-1', done: true }]);
    await waitFor(() => h.guest.document.querySelectorAll('.kb-card[data-status="done"]').length === 1);
    expect(h.guest.document.querySelectorAll('.kb-card[data-status="done"]').length).toBe(1);
  });

  test('re-issuing change reopens the ticket (done -> open)', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    let input = h.cardFor('KB-1').querySelector('input[role="switch"]');
    input.checked = true;
    input.dispatchEvent(new h.guest.Event('change', { bubbles: true }));
    await waitFor(() => h.toggles.length >= 1);
    // The optimistic render shows the done card before the service settles; the
    // switch stays `disabled` while the toggle is pending, so wait for the
    // reconciliation to release it before re-issuing `change`.
    await waitFor(() => h.cardFor('KB-1').querySelector('input[role="switch"]').disabled === false);

    input = h.cardFor('KB-1').querySelector('input[role="switch"]');
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new h.guest.Event('change', { bubbles: true }));

    await waitFor(() => h.toggles.length >= 2);
    expect(h.toggles[1]).toEqual({ project: 'projeto_jev', ticketId: 'KB-1', done: false });
    await waitFor(() => h.guest.document.querySelectorAll('.kb-card[data-status="open"]').length === 1);
  });
});

/* ================================================================== *
 * (B) renderTabs reconciles in place — node identity survives renders
 * ================================================================== */

describe('panel: renderTabs reuses the exact tab nodes across renders (TICKET-HARNESS-31)', () => {
  test('consecutive renders (refresh + tab switches) keep the same <button class="kb-tab"> objects', async () => {
    const h = await bootPanel(TWO_PROJECTS);
    await waitFor(() => h.tabButtons().length === 3);

    const ids = h.tabButtons().map((tab) => tab.id);
    const before = h.tabButtons().map((tab) => tab.node);
    expect(ids).toEqual(['todos', 'projeto_jev', 'jez_collections']);

    // Render trigger #1: the refresh button -> load() renders at start and in `finally`.
    const kanbanBefore = h.requests.filter((request) => request.path === '/api/kanban').length;
    click(h, h.refreshButton());
    await waitFor(() => h.requests.filter((request) => request.path === '/api/kanban').length >= kanbanBefore + 2);
    await waitFor(() => !h.rootBusy());

    const afterRefresh = h.tabButtons();
    expect(afterRefresh.map((tab) => tab.id)).toEqual(ids);
    afterRefresh.forEach((tab, index) => expect(tab.node).toBe(before[index]));

    // Render trigger #2: switching the active tab (and back) also re-renders.
    click(h, h.tabButtons().find((tab) => tab.id === 'jez_collections')!.node);
    await waitFor(() => h.activeTabId() === 'jez_collections');
    h.tabButtons().forEach((tab, index) => expect(tab.node).toBe(before[index]));

    click(h, h.tabButtons().find((tab) => tab.id === 'todos')!.node);
    await waitFor(() => h.activeTabId() === 'todos');
    h.tabButtons().forEach((tab, index) => expect(tab.node).toBe(before[index]));
  });

  test('renderTabs syncs aria-selected, tabIndex and the active kb-tab-count in place', async () => {
    const h = await bootPanel(TWO_PROJECTS);
    await waitFor(() => h.tabButtons().length === 3);

    const allButtons = h.tabButtons().map((tab) => tab.node);

    // Todos is active on mount and shows the open count.
    expect(h.tabState('todos')).toEqual({ selected: 'true', tabIndex: 0, count: '2' });
    expect(h.tabState('projeto_jev')).toEqual({ selected: 'false', tabIndex: -1, count: null });

    click(h, h.tabButtons().find((tab) => tab.id === 'jez_collections')!.node);
    await waitFor(() => h.activeTabId() === 'jez_collections');

    expect(h.tabState('jez_collections')).toEqual({ selected: 'true', tabIndex: 0, count: '1' });
    expect(h.tabState('todos')).toEqual({ selected: 'false', tabIndex: -1, count: null });
    expect(h.tabState('projeto_jev')).toEqual({ selected: 'false', tabIndex: -1, count: null });

    // Identity held through the state sync as well.
    const afterButtons = h.tabButtons().map((tab) => tab.node);
    afterButtons.forEach((node, index) => expect(node).toBe(allButtons[index]));
  });
});

/* ================================================================== *
 * (C) window focus cooldown — entering the frame must not nuke the button
 * ================================================================== */

describe('panel: window focus respects the reload cooldown (TICKET-HARNESS-31)', () => {
  test('focus within the cooldown does not reload and preserves tab node identity', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    const before = h.tabButtons().map((tab) => tab.node);
    const baseline = h.requests.length;

    h.guest.dispatchEvent(new h.guest.Event('focus'));

    // Give any (buggy) reload a real chance to hit the transport.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.requests.length).toBe(baseline);
    h.tabButtons().forEach((tab, index) => expect(tab.node).toBe(before[index]));
  });

  test('focus after the cooldown reloads (proves the guard is a cooldown, not a dead listener)', async () => {
    const h = await bootPanel(SINGLE_PROJECT);
    await waitFor(() => h.cards().length >= 1);

    const baseline = h.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    h.guest.dispatchEvent(new h.guest.Event('focus'));

    await waitFor(() => h.requests.length > baseline);
    expect(h.requests.length).toBeGreaterThan(baseline);
  });
});
