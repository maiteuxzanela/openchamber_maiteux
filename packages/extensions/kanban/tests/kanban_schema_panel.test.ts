/**
 * Deterministic, mock-free contract suite for the Kanban built-in extension.
 *
 * Covers the two production changes of the Kanban closing ticket:
 *
 *   (A) `src/service/schema.ts` — the canonical `kanbanSchema` must accept the
 *       six REAL `kanban.json` documents of the ecosystem (including the new
 *       `meta.instructions` field) and must reject document/ticket shapes that
 *       violate the status / priority / completed_at contract.
 *
 *   (B) `src/panel/main.ts` + `panel/style.css` — the REAL shipped panel bundle
 *       (`bun run extensions:build` output) must:
 *         · turn a vertical mouse wheel (|deltaY| > |deltaX|) into horizontal
 *           tab-strip scrolling with `preventDefault`,
 *         · leave native horizontal gestures untouched,
 *         · preserve `tabs.scrollLeft` across a re-render.
 *
 * No module under test is stubbed, faked or monkey-patched:
 *   · the schema is the real exported `kanbanSchema`,
 *   · the six `kanban.json` files are read from disk verbatim,
 *   · the panel is the real IIFE bundle served to the host, executed inside a
 *     real DOM (happy-dom) with the real SDK `ready` handshake.
 *
 * The one environment shim is a faithful emulation of the browser's scroll
 * clamp (a real browser collapses `scrollLeft` to 0 when a scroll container's
 * content is emptied; happy-dom has no layout engine and would otherwise never
 * reset it). It emulates the HOST behaviour, never the code under test, and a
 * canary test proves it is active, so the preservation assertion stays
 * mutation-sensitive.
 *
 * Run: bun test packages/extensions/kanban/tests/kanban_schema_panel.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { kanbanSchema, PRIORITY, STATUS, normalizePriority, normalizeStatus, ticketSchema } from '../src/service/schema.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_PACKAGE = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions', 'kanban');

/**
 * Mutation-testing seam ONLY: point at a mutated copy of the bundle to prove a
 * given assertion is sensitive (it must fail when the fix is removed). Unset in
 * normal runs, so the suite always exercises the real shipped bundle.
 */
const PANEL_BUNDLE = process.env['OPENCHAMBER_KANBAN_PANEL_BUNDLE']
  ? path.resolve(process.env['OPENCHAMBER_KANBAN_PANEL_BUNDLE'])
  : path.join(BUILT_PACKAGE, 'panel', 'main.js');

/** Canonical project list (CONTRACT_KANBAN §3). Ids are immutable route keys. */
const PROJECTS = [
  { id: 'projeto_jev', title: 'Projeto JEV', file: '/home/maiteuxzanela/projeto JEV/kanban.json' },
  { id: 'jez_collections', title: 'JEZ Collections', file: '/mnt/94CCB337CCB3130A/JEZ collections/kanban.json' },
  { id: 'panela_sobra', title: 'Panela de Sobra', file: '/home/maiteuxzanela/PanelaBuild/kanban.json' },
  { id: 'faturamento_medico', title: 'Faturamento Médico', file: '/mnt/94CCB337CCB3130A/Faturamento/kanban.json' },
  { id: 'predictera', title: 'Predictera', file: '/mnt/94CCB337CCB3130A/predictera/kanban.json' },
  { id: 'opencode_chambers_harness', title: 'OpenCode Chambers Harness', file: '/mnt/94CCB337CCB3130A/opencode_chambers_harness/kanban.json' },
] as const;

const CLI_PROJECTS = PROJECTS.map((project) => ({ id: project.id, title: project.title }));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fsp.readFile(file, 'utf8'));

/* ================================================================== *
 * (A) Schema conformance of the six REAL kanban.json files
 * ================================================================== */

describe('schema: the six real kanban.json documents conform', () => {
  for (const project of PROJECTS) {
    test(`${project.id} parses, matches its directory and carries meta.instructions`, async () => {
      const doc = (await readJson(project.file)) as {
        meta: Record<string, unknown>;
        tickets: Array<Record<string, unknown>>;
      };

      const parsed = kanbanSchema.safeParse(doc);
      expect(parsed.success, `schema issues: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.meta.version).toBe(1);
      expect(parsed.data.meta.project).toBe(project.id);
      expect(parsed.data.meta.title).toBe(project.title);
      expect(parsed.data.meta.updated_at).toMatch(ISO);

      // The new formal contract carried in meta.
      expect(typeof parsed.data.meta.instructions).toBe('string');
      const instructions = parsed.data.meta.instructions ?? '';
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('"open"');
      expect(instructions).toContain('"done"');
      expect(instructions).toContain('"alta"');
      expect(instructions).toContain('"media"');
      expect(instructions).toContain('"baixa"');
      expect(instructions).toContain('completed_at');

      // Every ticket honours the status / priority / completed_at contract.
      for (const ticket of parsed.data.tickets) {
        expect(['open', 'done']).toContain(ticket.status);
        expect(['alta', 'media', 'baixa']).toContain(ticket.priority);
        expect(ticket.created_at).toMatch(ISO);
        if (ticket.status === 'open') {
          expect(ticket.completed_at).toBeNull();
        } else {
          expect(typeof ticket.completed_at).toBe('string');
          expect(ticket.completed_at).toMatch(ISO);
        }
      }
    });
  }
});

describe('schema: rejects contract violations (mutation sensitivity)', () => {
  const base = () => ({
    meta: {
      version: 1,
      project: 'projeto_jev',
      title: 'Projeto JEV',
      instructions: 'CONTRATO: status "open" | "done"; priority "alta" | "media" | "baixa"; completed_at.',
      updated_at: '2026-10-15T19:34:50-03:00',
    },
    tickets: [
      { id: 'KB-1', title: 't', status: 'open', priority: 'alta', summary: 's', body: 'b', order: 0, created_at: '2026-10-15T19:34:50-03:00', completed_at: null },
    ],
  });

  test('the well-formed base document itself is accepted', () => {
    expect(kanbanSchema.safeParse(base()).success).toBe(true);
  });

  test('status outside the open|done enum is rejected', () => {
    const doc = base();
    doc.tickets[0].status = 'closed' as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('priority outside alta|media|baixa is rejected', () => {
    const doc = base();
    doc.tickets[0].priority = 'urgent' as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('a done ticket without completed_at is rejected', () => {
    const doc = base();
    doc.tickets[0].status = 'done' as never;
    doc.tickets[0].completed_at = null as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('an open ticket with completed_at set is rejected', () => {
    const doc = base();
    doc.tickets[0].completed_at = '2026-10-15T19:34:50-03:00' as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('duplicate ticket ids are rejected', () => {
    const doc = base();
    doc.tickets.push({ ...doc.tickets[0] });
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('a non-string meta.instructions is rejected', () => {
    const doc = base() as unknown as { meta: Record<string, unknown> };
    doc.meta.instructions = 42;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('an unknown meta.project is rejected', () => {
    const doc = base();
    doc.meta.project = 'ghost' as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });

  test('meta.version other than 1 is rejected', () => {
    const doc = base();
    doc.meta.version = 2 as never;
    expect(kanbanSchema.safeParse(doc).success).toBe(false);
  });
});

/* ================================================================== *
 * (B) The REAL shipped panel bundle: wheel + scrollLeft preservation
 * ================================================================== */

type HappyDomWindow = {
  document: any;
  [key: string]: any;
};

type PanelHarness = {
  win: HappyDomWindow;
  document: any;
  tabs: any;
};

const HAPPY_DOM_GLOBALS = [
  'window', 'document', 'customElements', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'MessageEvent', 'WheelEvent', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'HTMLElement', 'Element', 'Node', 'NodeList', 'HTMLInputElement', 'MutationObserver',
];

const loadHappyDom = async (): Promise<{ Window: new (options?: unknown) => HappyDomWindow }> => {
  const requireFromUi = createRequire(path.join(REPO_ROOT, 'packages', 'ui', 'package.json'));
  const entry = requireFromUi.resolve('happy-dom');
  const mod = (await import(pathToFileURL(entry).href)) as { Window: new (options?: unknown) => HappyDomWindow };
  return mod;
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

/** The real SDK handshake: the guest only accepts a message whose source is its parent frame. */
const dispatchReady = (win: HappyDomWindow): void => {
  win.dispatchEvent(new win.MessageEvent('message', { data: buildReadyMessage(), source: win }));
};

/**
 * Emulate the browser's scroll clamp on a scroll container: emptying the
 * content (`textContent = ''`, exactly what `renderTabs()` does) collapses
 * `scrollLeft` to 0. This models the HOST, not the code under test.
 */
const emulateBrowserScrollClamp = (el: any): void => {
  const proto = Object.getPrototypeOf(el);
  let owner = proto;
  let descriptor = Object.getOwnPropertyDescriptor(owner, 'textContent');
  while (!descriptor && owner) {
    owner = Object.getPrototypeOf(owner);
    descriptor = owner ? Object.getOwnPropertyDescriptor(owner, 'textContent') : undefined;
  }
  if (!descriptor?.get || !descriptor.set) throw new Error('happy-dom textContent descriptor not found');
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get(this: any) { return descriptor.get.call(this); },
    set(this: any, value: any) { descriptor.set.call(this, value); this.scrollLeft = 0; },
  });
};

let harness: PanelHarness | null = null;

const loadPanelBundle = async (): Promise<PanelHarness> => {
  const { Window } = await loadHappyDom();
  const win = new Window({ url: 'http://localhost/' });
  const document = win.document;
  document.body.innerHTML = '<div id="root" class="kb-root" aria-busy="true"></div>';

  for (const key of HAPPY_DOM_GLOBALS) {
    try {
      if (win[key] !== undefined) (globalThis as Record<string, unknown>)[key] = win[key];
    } catch {
      // Some globals (e.g. `navigator`) are getter-only in the Node runtime.
    }
  }
  (globalThis as Record<string, unknown>).window = win;

  const bundle = PANEL_BUNDLE;
  await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

  // The bundle registers `onReady` at module load; replay the real handshake.
  dispatchReady(win);

  const tabs = document.querySelector('.kb-tabs');
  if (!tabs) throw new Error('panel bundle did not mount: .kb-tabs not found');
  return { win, document, tabs };
};

const activeTabText = (h: PanelHarness): string =>
  h.document.querySelector('.kb-tab[aria-selected="true"]')?.textContent ?? '';

describe('panel: shipped build artifacts carry the tabs scroll fix', () => {
  test('the build output exists (produced by `bun run extensions:build`)', () => {
    for (const rel of ['package.json', 'panel/index.html', 'panel/style.css', 'panel/main.js', 'service/main.js']) {
      expect(fs.existsSync(path.join(BUILT_PACKAGE, rel)), `missing built artifact: ${rel}`).toBe(true);
    }
  });

  test('index.html loads main.js and the CSS keeps the horizontal-scroll contract', async () => {
    const html = await fsp.readFile(path.join(BUILT_PACKAGE, 'panel', 'index.html'), 'utf8');
    expect(html).toContain('main.js');
    const css = await fsp.readFile(path.join(BUILT_PACKAGE, 'panel', 'style.css'), 'utf8');
    expect(css).toContain('overscroll-behavior-x: contain');
    expect(css).toContain('scroll-behavior: auto');
  });
});

describe('panel: tabs wheel + scrollLeft behaviour (real bundle in a real DOM)', () => {
  beforeAll(async () => {
    harness = await loadPanelBundle();
    emulateBrowserScrollClamp(harness.tabs);
  });

  test('mount: renders the canonical tab strip (Todos + six projects)', () => {
    expect(harness).not.toBeNull();
    const { tabs } = harness as PanelHarness;
    expect(tabs.tagName).toBe('NAV');
    expect(tabs.getAttribute('role')).toBe('tablist');
    const buttons = tabs.querySelectorAll('.kb-tab');
    expect(buttons.length).toBe(CLI_PROJECTS.length + 1);
    expect(buttons[0].textContent).toContain('Todos');
    expect(buttons[1].textContent).toContain('Projeto JEV');
  });

  test('wheel: vertical deltaY > deltaX scrolls the strip and prevents default', () => {
    const { win, tabs } = harness as PanelHarness;
    tabs.scrollLeft = 100;
    const event = new win.WheelEvent('wheel', { deltaY: 50, deltaX: 0, cancelable: true, bubbles: true });
    tabs.dispatchEvent(event);
    expect(tabs.scrollLeft).toBe(150);
    expect(event.defaultPrevented).toBe(true);
  });

  test('wheel: a negative deltaY scrolls the strip back', () => {
    const { win, tabs } = harness as PanelHarness;
    tabs.scrollLeft = 150;
    const event = new win.WheelEvent('wheel', { deltaY: -70, deltaX: 0, cancelable: true, bubbles: true });
    tabs.dispatchEvent(event);
    expect(tabs.scrollLeft).toBe(80);
    expect(event.defaultPrevented).toBe(true);
  });

  test('wheel: native horizontal gesture (deltaX > deltaY) falls through untouched', () => {
    const { win, tabs } = harness as PanelHarness;
    tabs.scrollLeft = 120;
    const event = new win.WheelEvent('wheel', { deltaY: 5, deltaX: 40, cancelable: true, bubbles: true });
    tabs.dispatchEvent(event);
    expect(tabs.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(false);
  });

  test('wheel: equal magnitudes fall through (strict > boundary)', () => {
    const { win, tabs } = harness as PanelHarness;
    tabs.scrollLeft = 120;
    const event = new win.WheelEvent('wheel', { deltaY: 40, deltaX: 40, cancelable: true, bubbles: true });
    tabs.dispatchEvent(event);
    expect(tabs.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(false);
  });

  test('render: preserves tabs.scrollLeft across a tab-strip rebuild', () => {
    const h = harness as PanelHarness;
    const { win, document, tabs } = h;

    // Canary: the host clamp emulation must really collapse scrollLeft when the
    // strip is emptied, otherwise the preservation assertion below could pass
    // for the wrong reason.
    const canary = document.createElement('nav');
    emulateBrowserScrollClamp(canary);
    canary.scrollLeft = 77;
    canary.textContent = '';
    expect(canary.scrollLeft).toBe(0);

    const before = activeTabText(h);
    const target = [...tabs.querySelectorAll('.kb-tab')]
      .find((button: any) => button.getAttribute('aria-selected') === 'false');
    expect(target).toBeDefined();

    tabs.scrollLeft = 210;
    target.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    // A rebuild happened (active tab changed)...
    expect(activeTabText(h)).not.toBe(before);
    // ...and the horizontal offset survived it.
    expect(tabs.scrollLeft).toBe(210);
  });
});

/* ================================================================== *
 * (C) Resilient Priority & Status Normalization (Tolerant Formatting)
 * ================================================================== */

describe('schema: resilient priority normalization', () => {
  const variationsMedia = ['media', 'Media', 'MEDIA', 'Média', 'média', 'MÉDIA', '  Média  ', 'medio', 'Medio', 'medium', 'Medium', 'med', 'mid'];
  for (const v of variationsMedia) {
    test(`normalizes "${v}" to canonical "media"`, () => {
      expect(PRIORITY.parse(v)).toBe('media');
    });
  }

  const variationsAlta = ['alta', 'Alta', 'ALTA', '  Alta  ', 'alto', 'high', 'HIGH', 'critica', 'urgente'];
  for (const v of variationsAlta) {
    test(`normalizes "${v}" to canonical "alta"`, () => {
      expect(PRIORITY.parse(v)).toBe('alta');
    });
  }

  const variationsBaixa = ['baixa', 'Baixa', 'BAIXA', '  baixa  ', 'baixo', 'low', 'LOW'];
  for (const v of variationsBaixa) {
    test(`normalizes "${v}" to canonical "baixa"`, () => {
      expect(PRIORITY.parse(v)).toBe('baixa');
    });
  }

  test('ticketSchema accepts ticket with priority "Média"', () => {
    const rawTicket = {
      id: 'TICKET-TEST-01',
      title: 'Teste de Tolerância de Grafia',
      status: 'open',
      priority: 'Média',
      summary: 'Resiliência a acentos e maiúsculas',
      body: 'Corpo do ticket',
      order: 1,
      created_at: '2026-10-17T18:00:00-03:00',
      completed_at: null,
    };
    const parsed = ticketSchema.parse(rawTicket);
    expect(parsed.priority).toBe('media');
  });

  test('ticketSchema accepts ticket with status "concluído"', () => {
    const rawTicket = {
      id: 'TICKET-TEST-02',
      title: 'Teste de Status Concluído',
      status: 'concluído',
      priority: 'Alta',
      summary: 'Status em português',
      body: 'Corpo do ticket',
      order: 2,
      created_at: '2026-10-17T18:00:00-03:00',
      completed_at: '2026-10-17T18:30:00-03:00',
    };
    const parsed = ticketSchema.parse(rawTicket);
    expect(parsed.status).toBe('done');
    expect(parsed.priority).toBe('alta');
  });
});
