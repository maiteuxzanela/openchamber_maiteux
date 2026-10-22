/**
 * Kanban panel (TICKET-HARNESS-14 · T4).
 *
 * Renders the six fixed projects plus the aggregate "Todos" tab, consumes the
 * guest service exclusively through `host.serviceRequest` (CONTRACT_KANBAN.md
 * §2/§4) and never touches the filesystem. Theme comes from `ready.theme`.
 *
 * Full-screen (`contributes.page`) and rail (300–420px) share this one bundle.
 *
 * TICKET-HARNESS-88 (contract v2): `GET /api/kanban` answers with a sliced list
 * that carries no `body`, so the full description is fetched on demand by
 * `GET /api/kanban/ticket` when a card is expanded. A host that answers with an
 * explicit unfamiliar `contractVersion` is a lockstep failure and must surface
 * as a version error — never as a silently empty board.
 */

import {
  connectHost,
  HostRequestError,
  type GuestRequest,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

/* ------------------------------------------------------------------ *
 * Contract types — CONTRACT_KANBAN.md §1, §2
 * ------------------------------------------------------------------ */

type TicketStatus = 'open' | 'done';
type TicketPriority = 'alta' | 'media' | 'baixa';

type Ticket = {
  id: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  summary: string;
  /** Absent in the v2 list; always present in the on-demand ticket endpoint. */
  body?: string;
  order: number;
  created_at: string;
  completed_at: string | null;
};

type TaggedTicket = Ticket & { project: string; projectTitle: string };

type ProjectSummary = {
  id: string;
  title: string;
  path: string;
  totalTickets: number;
  openTickets: number;
  doneTickets: number;
};

type KanbanResponse = {
  project: string;
  /** 2 = sliced list (no `body`). Absent on pre-TICKET-HARNESS-88 hosts. */
  contractVersion?: number;
  meta: { version: number; project: string; title: string; updated_at: string };
  tickets: Ticket[];
};

type TicketResponse = {
  project: string;
  contractVersion?: number;
  ticket: Ticket;
};

type ProjectsResponse = { projects: ProjectSummary[] };

type ToggleResponse = {
  ok: boolean;
  ticket: { id: string; status: TicketStatus; completed_at: string | null };
  updated_at: string;
};

type ErrorBody = { error?: { code?: string; message?: string } };

/* ------------------------------------------------------------------ *
 * Constants — CONTRACT_KANBAN.md §3
 * ------------------------------------------------------------------ */

const TAB_ALL = 'todos';
const ALL_LABEL = 'Todos';

/**
 * Contract version this bundle speaks (TICKET-HARNESS-88 · F5/F7). Panel, host
 * and SDK are built in lockstep; a host that advertises any other explicit
 * version must fail loudly instead of rendering cards without their bodies.
 */
const CONTRACT_VERSION = 2;

/**
 * `window` focus fires whenever the iframe regains focus — including the very
 * first `mousedown` of a click that enters the panel. Reloading on every focus
 * burned an extra `load()` per tab click and (before tabs were reconciled in
 * place) destroyed the button between `mousedown` and `mouseup`, cancelling the
 * `click`. A short cooldown keeps genuine refreshes (returning after a while)
 * while ignoring focus churn from rapid in-panel clicks.
 */
const FOCUS_RELOAD_COOLDOWN_MS = 1000;

/**
 * Canonical project list (CONTRACT_KANBAN.md §3). The service's
 * `GET /api/projects` is authoritative at runtime (order, labels, counts);
 * this mirror only lets the tab bar render while the service is still starting
 * or before the user grants it in Settings → Extensions.
 */
const CANONICAL_PROJECTS: readonly ProjectSummary[] = [
  { id: 'projeto_jev', title: 'search-guard-agent', path: '/home/maiteuxzanela/search-guard-agent', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'jez_collections', title: 'JEZ Collections', path: '/mnt/94CCB337CCB3130A/JEZ collections', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'panela_sobra', title: 'Panela de Sobra', path: '/home/maiteuxzanela/PanelaBuild', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'faturamento_medico', title: 'Faturamento Médico', path: '/mnt/94CCB337CCB3130A/Faturamento', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'predictera', title: 'Predictera', path: '/mnt/94CCB337CCB3130A/predictera', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'opencode_chambers_harness', title: 'OpenCode Chambers Harness', path: '/mnt/94CCB337CCB3130A/opencode_chambers_harness', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'ensemble_room_lowcost', title: 'Ensemble Hardened', path: '/mnt/94CCB337CCB3130A/ensemble-room-lowcost', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'agent_dreams', title: 'Agent Dreams', path: '/home/maiteuxzanela/.config/opencode/plugins/opencode-plugin-dreams', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'cirurgic_search_mcp', title: 'cirurgic-search-mcp', path: '/home/maiteuxzanela/cirurgic-search-mcp', totalTickets: 0, openTickets: 0, doneTickets: 0 },
];

/** Aliases de caminho para resolução resiliente de abas ativas */
const PROJECT_PATH_ALIASES: Record<string, readonly string[]> = {
  projeto_jev: [
    '/home/maiteuxzanela/search-guard-agent',
    '/home/maiteuxzanela/agent_quality_guard',
    '/home/maiteuxzanela/projeto JEV',
  ],
};

/**
 * Normalise a filesystem path for comparison: trim, drop trailing slashes
 * (`/repo/` and `/repo` are the same checkout) while keeping the root `/`.
 */
const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let normalized = trimmed;
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

/**
 * Resolve which tab the panel should open on, given the active directory of the
 * host workspace (TICKET-HARNESS-70). Pure on purpose: the initial tab is a
 * deterministic function of the host context and the project list, never of
 * timers or of the DOM.
 *
 * Matching is exact (`/repo` === `/repo`) or ancestral (`/repo/app` belongs to
 * `/repo`). No directory, or a directory that is not a kanban project, keeps
 * the aggregate `Todos` tab.
 */
const resolveInitialTab = (
  directory: string | null,
  projects: readonly ProjectSummary[] = CANONICAL_PROJECTS,
): string => {
  const normalizedDirectory = typeof directory === 'string' ? normalizeProjectPath(directory) : '';
  if (normalizedDirectory === '') return TAB_ALL;

  for (const project of projects) {
    const candidatePaths = [
      project.path,
      ...(PROJECT_PATH_ALIASES[project.id] ?? []),
    ];
    for (const rawPath of candidatePaths) {
      const projectPath = normalizeProjectPath(rawPath);
      if (projectPath === '') continue;
      if (normalizedDirectory === projectPath || normalizedDirectory.startsWith(`${projectPath}/`)) {
        return project.id;
      }
    }
  }

  return TAB_ALL;
};

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const describeError = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NO_SERVICE':
        return 'O serviço da extensão ainda não está autorizado. Abra Configurações → Extensões, permita o serviço local do Kanban e tente novamente.';
      case 'DISABLED':
        return 'A extensão Kanban está desativada em Configurações → Extensões.';
      case 'SERVICE_FAILED':
        return 'O serviço do Kanban não iniciou. Verifique Configurações → Extensões e tente novamente.';
      case 'HOST_TIMEOUT':
        return 'O host demorou demais para responder. Tente novamente.';
      case 'HOST_UNAVAILABLE':
        return 'O host não está disponível no momento.';
      default:
        return `Falha de comunicação com o serviço (${error.code}).`;
    }
  }
  if (error instanceof ApiError) {
    if (error.code === 'response-too-large') {
      return `${error.message} Peça um recorte menor (a lista sem descrições já é o padrão) e tente novamente.`;
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Erro inesperado ao consultar o serviço.';
};

/**
 * Lockstep guard (TICKET-HARNESS-88 · F7). Only an explicitly advertised
 * version is validated, so a legacy host (tickets carry `body` inline and omit
 * the field) still works, while a mismatched modern host fails with an explicit
 * version error instead of an empty board or `invalid-json`.
 */
const assertContractVersion = (payload: { contractVersion?: number }, route: string): void => {
  if (payload.contractVersion === undefined) return;
  if (payload.contractVersion !== CONTRACT_VERSION) {
    throw new ApiError(
      0,
      'contract-version-mismatch',
      `Contrato incompatível em ${route}: o serviço respondeu v${payload.contractVersion} e este painel fala v${CONTRACT_VERSION}. Recarregue o OpenChamber para alinhar painel e serviço (build lockstep).`,
    );
  }
};

const requestJson = async <T,>(host: HostClient, request: GuestRequest): Promise<T> => {
  const result = await host.serviceRequest(request);
  if (result.status >= 400) {
    let code = `http-${result.status}`;
    let message = `O serviço respondeu HTTP ${result.status}.`;
    try {
      const parsed = JSON.parse(result.body) as ErrorBody;
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* body was not JSON; keep the HTTP-level message */
    }
    throw new ApiError(result.status, code, message);
  }
  try {
    return (result.body ? JSON.parse(result.body) : {}) as T;
  } catch {
    throw new ApiError(result.status, 'invalid-json', 'Resposta inválida do serviço.');
  }
};

/* ------------------------------------------------------------------ *
 * Safe markdown renderer (no dependencies, no raw HTML passthrough)
 * ------------------------------------------------------------------ */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeUrl = (raw: string): string | null => {
  const url = raw.trim();
  if (url === '' || url.includes('\\')) return null;
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith('//')) return null;
  if (/^[/#.]/.test(url)) return url;
  return null;
};

const renderInline = (text: string): string => {
  let out = escapeHtml(text);
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy">` : alt;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`);
  return out;
};

const renderMarkdown = (source: string): string => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph.length = 0;
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (/^\s*```/.test(line)) {
      flush();
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      const langAttr = language ? ` data-lang="${escapeHtml(language)}"` : '';
      html.push(`<pre class="kb-code"${langAttr}><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] ?? '#').length;
      html.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec(lines[index] ?? '');
        if (!match) break;
        quoted.push(renderInline(match[1] ?? ''));
        index += 1;
      }
      html.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      html.push('<ul>');
      while (index < lines.length) {
        const match = /^\s*[-*+]\s+(.*)$/.exec(lines[index] ?? '');
        if (!match) break;
        html.push(`<li>${renderInline(match[1] ?? '')}</li>`);
        index += 1;
      }
      html.push('</ul>');
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      html.push('<ol>');
      while (index < lines.length) {
        const match = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index] ?? '');
        if (!match) break;
        html.push(`<li>${renderInline(match[1] ?? '')}</li>`);
        index += 1;
      }
      html.push('</ol>');
      continue;
    }

    if (line.trim() === '') {
      flush();
      index += 1;
      continue;
    }

    paragraph.push(renderInline(line));
    index += 1;
  }
  flush();
  return html.join('\n');
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

type State = {
  projects: ProjectSummary[];
  projectsLoaded: boolean;
  docs: Map<string, TaggedTicket[]>;
  activeTab: string;
  expanded: Set<string>;
  errors: Map<string, string>;
  pending: Set<string>;
  /** F5: full `body` per card, fetched on demand from `/api/kanban/ticket`. */
  bodies: Map<string, string>;
  bodyLoading: Set<string>;
  bodyErrors: Map<string, string>;
  /** F6: per-project load failures, surfaced instead of silently omitted. */
  projectErrors: Map<string, string>;
  loading: boolean;
  serviceError: string | null;
};

const cardKey = (ticket: Pick<Ticket, 'id'> & { project: string }): string => `${ticket.project}::${ticket.id}`;

const sortOpen = (tickets: TaggedTicket[]): TaggedTicket[] =>
  [...tickets]
    .filter((ticket) => ticket.status === 'open')
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.projectTitle.localeCompare(b.projectTitle, 'pt-BR') ||
        a.id.localeCompare(b.id),
    );

const sortDone = (tickets: TaggedTicket[]): TaggedTicket[] =>
  [...tickets]
    .filter((ticket) => ticket.status === 'done')
    .sort((a, b) => {
      const left = a.completed_at ? Date.parse(a.completed_at) : 0;
      const right = b.completed_at ? Date.parse(b.completed_at) : 0;
      return right - left || a.id.localeCompare(b.id);
    });

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

const mount = (host: HostClient, root: HTMLElement, context: HostReadyContext): void => {
  const state: State = {
    projects: [],
    projectsLoaded: false,
    docs: new Map(),
    // Open on the tab that matches the workspace the host opened us for
    // (TICKET-HARNESS-70); `Todos` when the directory is unknown.
    activeTab: resolveInitialTab(context.directory, CANONICAL_PROJECTS),
    expanded: new Set(),
    errors: new Map(),
    pending: new Set(),
    bodies: new Map(),
    bodyLoading: new Set(),
    bodyErrors: new Map(),
    projectErrors: new Map(),
    loading: false,
    serviceError: null,
  };

  /** Wall-clock of the last `load()` start; drives the focus cooldown. */
  let lastLoadStartedAt = 0;

  /** Active workspace directory reported by the host, kept live via `onDirectory`. */
  let hostDirectory: string | null = context.directory;

  /**
   * The panel follows the host workspace only until the user picks a tab by
   * hand: an explicit click is a deliberate intent that must not be yanked by a
   * later directory event. Returns `true` when the active tab changed.
   */
  let userSelectedTab = false;

  const syncActiveTabWithDirectory = (): boolean => {
    if (userSelectedTab) return false;
    const next = resolveInitialTab(hostDirectory, projectList());
    if (next === state.activeTab) return false;
    state.activeTab = next;
    state.serviceError = null;
    return true;
  };

  /* ----- skeleton ----- */

  const topbar = document.createElement('header');
  topbar.className = 'kb-topbar';

  const heading = document.createElement('div');
  heading.className = 'kb-heading';
  const title = document.createElement('h1');
  title.textContent = 'Kanban';
  const subtitle = document.createElement('span');
  subtitle.className = 'kb-heading-sub';
  subtitle.textContent = 'Carregando…';
  heading.append(title, subtitle);

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'kb-refresh';
  refresh.textContent = 'Atualizar';
  refresh.addEventListener('click', () => {
    void load();
  });

  topbar.append(heading, refresh);

  const tabs = document.createElement('nav');
  tabs.className = 'kb-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Projetos');

  // Convert the common vertical mouse wheel into smooth horizontal scrolling of
  // the tab strip. Horizontal-native gestures (trackpads) fall through untouched
  // so we never fight a deliberate two-axis scroll.
  tabs.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        tabs.scrollLeft += event.deltaY;
      }
    },
    { passive: false },
  );

  const banner = document.createElement('div');
  banner.className = 'kb-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'alert');
  const bannerText = document.createElement('span');
  bannerText.className = 'kb-banner-text';
  const bannerRetry = document.createElement('button');
  bannerRetry.type = 'button';
  bannerRetry.className = 'kb-banner-retry';
  bannerRetry.textContent = 'Tentar novamente';
  bannerRetry.addEventListener('click', () => {
    void load();
  });
  banner.append(bannerText, bannerRetry);

  const scroll = document.createElement('div');
  scroll.className = 'kb-scroll';

  /**
   * F6 (TICKET-HARNESS-88): the aggregate tab merges six/eight independent
   * requests; a project that fails must stay visible as a named warning. It is
   * never dropped from the tab bar nor folded into a fake `0 abertos`.
   */
  const failureList = document.createElement('div');
  failureList.className = 'kb-project-errors';
  failureList.setAttribute('role', 'status');

  const list = document.createElement('div');
  list.className = 'kb-list';

  const separator = document.createElement('div');
  separator.className = 'kb-separator';
  separator.hidden = true;
  const separatorLabel = document.createElement('span');
  separatorLabel.textContent = 'Concluídos';
  separator.append(separatorLabel);

  const doneList = document.createElement('div');
  doneList.className = 'kb-list';

  const empty = document.createElement('div');
  empty.className = 'kb-empty';
  empty.hidden = true;
  const emptyTitle = document.createElement('strong');
  emptyTitle.textContent = 'Nenhum ticket';
  const emptyBody = document.createElement('span');
  empty.append(emptyTitle, emptyBody);

  scroll.append(failureList, list, separator, doneList, empty);
  root.append(topbar, tabs, banner, scroll);

  /* ----- helpers ----- */

  const projectList = (): readonly ProjectSummary[] =>
    state.projects.length > 0 ? state.projects : CANONICAL_PROJECTS;

  const projectTitle = (id: string): string =>
    projectList().find((project) => project.id === id)?.title ?? id;

  const tabItems = (): { id: string; label: string }[] => [
    { id: TAB_ALL, label: ALL_LABEL },
    ...projectList().map((project) => ({ id: project.id, label: project.title })),
  ];

  const visibleTickets = (): TaggedTicket[] => {
    if (state.activeTab === TAB_ALL) {
      const merged: TaggedTicket[] = [];
      for (const tickets of state.docs.values()) merged.push(...tickets);
      return merged;
    }
    return state.docs.get(state.activeTab) ?? [];
  };

  const makeBadge = (label: string, modifier: string): HTMLElement => {
    const badge = document.createElement('span');
    badge.className = `kb-badge ${modifier}`;
    badge.textContent = label;
    return badge;
  };

  const buildCard = (ticket: TaggedTicket): HTMLElement => {
    const key = cardKey(ticket);
    const done = ticket.status === 'done';
    const expanded = state.expanded.has(key);

    const card = document.createElement('article');
    card.className = `kb-card${expanded ? ' kb-card--expanded' : ''}`;
    card.dataset['status'] = ticket.status;
    card.dataset['project'] = ticket.project;

    const head = document.createElement('div');
    head.className = 'kb-card-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));

    const toggle = document.createElement('label');
    toggle.className = 'kb-switch';
    toggle.title = done ? 'Reabrir ticket' : 'Concluir ticket';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = done;
    input.disabled = state.pending.has(key);
    input.setAttribute('aria-label', done ? `Reabrir ${ticket.id}` : `Concluir ${ticket.id}`);
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => {
      void toggleTicket(ticket, input.checked);
    });
    input.addEventListener('keydown', (event) => event.stopPropagation());
    const track = document.createElement('span');
    track.className = 'kb-switch-track';
    track.setAttribute('aria-hidden', 'true');
    toggle.append(input, track);

    // The visual input is 1x1px with `pointer-events: none`, so the physical
    // click lands on the `<label class="kb-switch">` (44x44 hit area) or its
    // track — never on the input itself. Without stopping propagation here the
    // click bubbled to `.kb-card-head`, fired the accordion's `setExpanded` and
    // re-rendered the card, racing/cancelling the `change` that completes or
    // reopens the ticket. Keep the `change` listener on the input intact.
    toggle.addEventListener('click', (event) => event.stopPropagation());
    toggle.addEventListener('pointerdown', (event) => event.stopPropagation());
    toggle.addEventListener('mousedown', (event) => event.stopPropagation());

    const main = document.createElement('div');
    main.className = 'kb-card-main';

    const meta = document.createElement('div');
    meta.className = 'kb-card-meta';
    const idEl = document.createElement('span');
    idEl.className = 'kb-id';
    idEl.textContent = ticket.id;
    meta.append(idEl);
    meta.append(makeBadge(done ? 'Concluído' : 'Aberto', done ? 'kb-badge--done' : 'kb-badge--open'));
    meta.append(makeBadge(PRIORITY_LABEL[ticket.priority], `kb-badge--${ticket.priority}`));
    if (state.activeTab === TAB_ALL) meta.append(makeBadge(ticket.projectTitle, 'kb-badge--project'));

    const titleEl = document.createElement('h3');
    titleEl.className = 'kb-title';
    titleEl.textContent = ticket.title;
    main.append(meta, titleEl);

    const chevron = document.createElement('span');
    chevron.className = 'kb-chevron';
    chevron.setAttribute('aria-hidden', 'true');

    head.append(toggle, main, chevron);

    const setExpanded = (next: boolean): void => {
      if (next) {
        state.expanded.add(key);
        // F5: the v2 list carries no `body`; fetch it on first expansion and
        // cache it, so collapsing/expanding again never re-hits the service.
        void ensureBody(ticket);
      } else {
        state.expanded.delete(key);
      }
      render();
    };
    head.addEventListener('click', () => setExpanded(!state.expanded.has(key)));
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setExpanded(!state.expanded.has(key));
      }
    });

    card.append(head);

    if (ticket.summary.trim() !== '') {
      const summary = document.createElement('p');
      summary.className = 'kb-summary';
      summary.textContent = ticket.summary;
      card.append(summary);
    }

    const error = state.errors.get(key);
    if (error) {
      const alert = document.createElement('p');
      alert.className = 'kb-card-error';
      alert.textContent = error;
      card.append(alert);
    }

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'kb-body';
      const bodyError = state.bodyErrors.get(key);
      if (state.bodyLoading.has(key)) {
        const loading = document.createElement('p');
        loading.className = 'kb-body-empty';
        loading.textContent = 'Carregando descrição…';
        body.append(loading);
      } else if (bodyError) {
        const alert = document.createElement('p');
        alert.className = 'kb-card-error';
        alert.textContent = `Não foi possível carregar a descrição: ${bodyError}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'kb-body-retry';
        retry.textContent = 'Tentar novamente';
        retry.addEventListener('click', (event) => {
          event.stopPropagation();
          void ensureBody(ticket, { force: true });
        });
        body.append(alert, retry);
      } else {
        const source = state.bodies.get(key) ?? ticket.body ?? '';
        if (source.trim() !== '') {
          body.innerHTML = renderMarkdown(source);
        } else {
          const placeholder = document.createElement('p');
          placeholder.className = 'kb-body-empty';
          placeholder.textContent = 'Sem descrição.';
          body.append(placeholder);
        }
      }
      card.append(body);
    }

    return card;
  };

  /* ----- data ----- */

  const loadProjects = async (): Promise<void> => {
    const data = await requestJson<ProjectsResponse>(host, { method: 'GET', path: '/api/projects' });
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    state.projectsLoaded = true;
    // The canonical mirror exists only to render the tab bar before the service
    // answers. Now that the authoritative list arrived, re-derive the
    // host-selected tab from it; `load()` reads `state.activeTab` right after
    // this call, so the ticket fetch targets the revalidated project.
    syncActiveTabWithDirectory();
  };

  const loadProject = async (project: string): Promise<void> => {
    const data = await requestJson<KanbanResponse>(host, {
      method: 'GET',
      path: '/api/kanban',
      query: { project },
    });
    assertContractVersion(data, '/api/kanban');
    const projectTitleValue = data.meta?.title || projectTitle(project);
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    state.docs.set(
      project,
      tickets.map((ticket) => ({ ...ticket, project, projectTitle: projectTitleValue })),
    );
  };

  /**
   * F5 (TICKET-HARNESS-88): fetches a single ticket's `body` on demand. Legacy
   * payloads that still inline `body` short-circuit here (zero extra request);
   * v2 lists go to `GET /api/kanban/ticket`. Errors are cached per card so a
   * failing card does not retry in a loop — the user retries explicitly.
   */
  const ensureBody = async (ticket: TaggedTicket, options: { force?: boolean } = {}): Promise<void> => {
    const key = cardKey(ticket);
    if (ticket.body !== undefined && options.force !== true) {
      state.bodies.set(key, ticket.body);
      return;
    }
    if (!options.force && (state.bodies.has(key) || state.bodyLoading.has(key))) return;
    state.bodyErrors.delete(key);
    state.bodyLoading.add(key);
    render();
    try {
      const data = await requestJson<TicketResponse>(host, {
        method: 'GET',
        path: '/api/kanban/ticket',
        query: { project: ticket.project, ticketId: ticket.id },
      });
      assertContractVersion(data, '/api/kanban/ticket');
      state.bodies.set(key, typeof data.ticket?.body === 'string' ? data.ticket.body : '');
    } catch (error) {
      state.bodyErrors.set(key, describeError(error));
    } finally {
      state.bodyLoading.delete(key);
      render();
    }
  };

  const load = async (): Promise<void> => {
    if (state.loading) return;
    lastLoadStartedAt = Date.now();
    state.loading = true;
    state.serviceError = null;
    render();
    try {
      if (!state.projectsLoaded) await loadProjects();
      if (state.activeTab === TAB_ALL) {
        const ids = projectList().map((project) => project.id);
        const results = await Promise.allSettled(ids.map((id) => loadProject(id)));
        let failures = 0;
        results.forEach((result, index) => {
          const id = ids[index];
          if (id === undefined) return;
          if (result.status === 'rejected') {
            failures += 1;
            state.projectErrors.set(id, describeError(result.reason));
          } else {
            state.projectErrors.delete(id);
          }
        });
        // F6: a partial failure is NOT silent anymore — only a total blackout
        // escalates to the full-page error banner.
        if (ids.length > 0 && failures === ids.length) {
          const first = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (first) throw first.reason;
        }
      } else {
        await loadProject(state.activeTab);
        state.projectErrors.delete(state.activeTab);
      }
    } catch (error) {
      state.serviceError = describeError(error);
    } finally {
      state.loading = false;
      render();
    }
  };

  const applyLocal = (project: string, id: string, done: boolean): void => {
    const doc = state.docs.get(project);
    if (!doc) return;
    state.docs.set(
      project,
      doc.map((ticket) =>
        ticket.id === id
          ? { ...ticket, status: done ? 'done' : 'open', completed_at: done ? new Date().toISOString() : null }
          : ticket,
      ),
    );
  };

  const reconcile = (project: string, patch: ToggleResponse['ticket']): void => {
    const doc = state.docs.get(project);
    if (!doc) return;
    state.docs.set(
      project,
      doc.map((ticket) =>
        ticket.id === patch.id ? { ...ticket, status: patch.status, completed_at: patch.completed_at } : ticket,
      ),
    );
  };

  const toggleTicket = async (ticket: TaggedTicket, done: boolean): Promise<void> => {
    const key = cardKey(ticket);
    if (state.pending.has(key)) return;
    state.errors.delete(key);
    const snapshot = state.docs.get(ticket.project);

    // Optimistic UI: reorder immediately, then reconcile with the service.
    applyLocal(ticket.project, ticket.id, done);
    state.pending.add(key);
    render();

    try {
      const response = await requestJson<ToggleResponse>(host, {
        method: 'POST',
        path: '/api/toggle',
        body: JSON.stringify({ project: ticket.project, ticketId: ticket.id, done }),
      });
      reconcile(ticket.project, response.ticket);
    } catch (error) {
      if (snapshot) state.docs.set(ticket.project, snapshot);
      state.errors.set(key, `Não foi possível atualizar: ${describeError(error)}`);
    } finally {
      state.pending.delete(key);
      render();
    }
  };

  /* ----- render ----- */

  const countTicket = (tickets: TaggedTicket[], status: TicketStatus): number =>
    tickets.filter((ticket) => ticket.status === status).length;

  /** F6: projects whose `loadProject` rejected while the aggregate tab is open. */
  const failureCount = (): number =>
    state.activeTab === TAB_ALL ? state.projectErrors.size : 0;

  const renderProjectFailures = (): void => {
    failureList.textContent = '';
    if (state.activeTab !== TAB_ALL) return;
    for (const [id, message] of state.projectErrors) {
      const row = document.createElement('div');
      row.className = 'kb-project-error';
      row.dataset['project'] = id;
      row.setAttribute('role', 'alert');
      const name = document.createElement('strong');
      name.textContent = projectTitle(id);
      const text = document.createElement('span');
      text.textContent = `não carregou: ${message}`;
      row.append(name, text);
      failureList.append(row);
    }
  };

  const renderTabs = (tickets: TaggedTicket[]): void => {
    const items = tabItems();

    // Reconcile in place: never blast `tabs.textContent = ''`. Tearing down and
    // recreating every button destroyed the node under the cursor between
    // `mousedown` and `mouseup` (the `focus` handler used to trigger a full
    // render), which silently cancelled the tab `click`. Existing buttons are
    // reused and only their visual state is updated.
    const existing = new Map<string, HTMLButtonElement>();
    for (const button of Array.from(tabs.querySelectorAll<HTMLButtonElement>('.kb-tab'))) {
      const id = button.dataset['tabId'];
      if (id) existing.set(id, button);
    }

    const wanted = new Set(items.map((item) => item.id));
    for (const [id, button] of existing) {
      if (!wanted.has(id)) {
        button.remove();
        existing.delete(id);
      }
    }

    for (const item of items) {
      const tabId = item.id;
      let button = existing.get(tabId);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'kb-tab';
        button.setAttribute('role', 'tab');
        button.dataset['tabId'] = tabId;
        const label = document.createElement('span');
        label.className = 'kb-tab-label';
        label.textContent = item.label;
        button.append(label);
        button.addEventListener('click', () => {
          if (state.activeTab === tabId) return;
          userSelectedTab = true;
          state.activeTab = tabId;
          state.serviceError = null;
          render();
          void load();
        });
        tabs.append(button);
        existing.set(tabId, button);
      } else {
        const label = button.querySelector<HTMLElement>('.kb-tab-label');
        if (label && label.textContent !== item.label) label.textContent = item.label;
      }

      const active = tabId === state.activeTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;

      let count = button.querySelector<HTMLElement>('.kb-tab-count');
      if (active) {
        if (!count) {
          count = document.createElement('span');
          count.className = 'kb-tab-count';
          button.append(count);
        }
        count.textContent = String(countTicket(tickets, 'open'));
      } else if (count) {
        count.remove();
      }
    }

    // Only reorder when the sequence actually diverged. `append` on an already
    // placed node detaches then re-attaches it, which must never happen during
    // an in-flight click gesture.
    const currentOrder = Array.from(tabs.children).map((child) => (child as HTMLElement).dataset['tabId']);
    const wantedOrder = items.map((item) => item.id);
    const reordered =
      currentOrder.length !== wantedOrder.length ||
      currentOrder.some((id, index) => id !== wantedOrder[index]);
    if (reordered) {
      for (const item of items) {
        const button = existing.get(item.id);
        if (button) tabs.append(button);
      }
    }
  };

  const renderList = (tickets: TaggedTicket[]): void => {
    const open = sortOpen(tickets);
    const done = sortDone(tickets);

    list.textContent = '';
    for (const ticket of open) list.append(buildCard(ticket));

    doneList.textContent = '';
    if (done.length > 0) {
      separator.hidden = false;
      separatorLabel.textContent = `Concluídos (${done.length})`;
      for (const ticket of done) doneList.append(buildCard(ticket));
    } else {
      separator.hidden = true;
      separatorLabel.textContent = 'Concluídos';
    }

    const total = open.length + done.length;
    const failed = failureCount();
    empty.hidden = total > 0 || state.loading;
    if (!empty.hidden) {
      if (state.serviceError) {
        emptyTitle.textContent = 'Não foi possível carregar';
        emptyBody.textContent = 'Verifique o serviço da extensão e tente novamente.';
      } else if (failed > 0) {
        // F6: never dress a failed load as an empty board.
        emptyTitle.textContent = 'Carregamento parcial';
        emptyBody.textContent = `${failed} projeto${failed === 1 ? '' : 's'} não carregou${failed === 1 ? '' : 'ram'}. Veja o aviso acima e tente novamente.`;
      } else {
        emptyTitle.textContent = 'Nenhum ticket';
        emptyBody.textContent = 'Adicione tickets ao kanban.json deste projeto para vê-los aqui.';
      }
    }
  };

  const render = (): void => {
    const tickets = visibleTickets();
    const scrollTop = scroll.scrollTop;
    const scrollLeft = tabs.scrollLeft;

    renderTabs(tickets);
    renderList(tickets);
    renderProjectFailures();

    const activeLabel = state.activeTab === TAB_ALL ? ALL_LABEL : projectTitle(state.activeTab);
    const failed = state.serviceError ? 0 : failureCount();
    const openCount = countTicket(tickets, 'open');
    const doneCount = countTicket(tickets, 'done');
    const failureNote =
      failed > 0 ? ` · ${failed} projeto${failed === 1 ? '' : 's'} com falha` : '';
    subtitle.textContent = state.loading
      ? `${activeLabel} · carregando…`
      : state.serviceError
        ? // F6: a failed load is never summarised as `0 abertos · 0 concluídos`.
          `${activeLabel} · falha ao carregar`
        : `${activeLabel} · ${openCount} aberto${openCount === 1 ? '' : 's'} · ${doneCount} concluído${doneCount === 1 ? '' : 's'}${failed > 0 ? ' (parcial)' : ''}${failureNote}`;

    refresh.disabled = state.loading;
    refresh.setAttribute('aria-busy', String(state.loading));
    refresh.textContent = state.loading ? 'Atualizando…' : 'Atualizar';

    if (state.serviceError) {
      banner.hidden = false;
      bannerText.textContent = state.serviceError;
    } else if (failed > 0) {
      // F6: partial failure is announced by name, never swallowed by the
      // `Promise.allSettled` merge.
      const names = [...state.projectErrors.keys()].map((id) => projectTitle(id)).join(', ');
      banner.hidden = false;
      bannerText.textContent = `Falha parcial ao carregar ${failed} projeto${failed === 1 ? '' : 's'} (${names}). Os demais projetos estão completos.`;
    } else {
      banner.hidden = true;
      bannerText.textContent = '';
    }

    root.setAttribute('aria-busy', String(state.loading));
    scroll.scrollTop = scrollTop;
    // renderTabs() reconciles the strip in place (it does not rebuild buttons),
    // so the horizontal scroll is usually preserved; restore it defensively so a
    // data refresh never yanks the active tab out of view.
    tabs.scrollLeft = scrollLeft;
  };

  /* ----- live refresh (CONTRACT_KANBAN.md §2.7) ----- */

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load();
  });
  window.addEventListener('focus', () => {
    // Guard against focus churn: entering the iframe (first click) fires focus
    // right before the click, so a rapid refresh here would race the gesture.
    if (Date.now() - lastLoadStartedAt < FOCUS_RELOAD_COOLDOWN_MS) return;
    void load();
  });

  /* ----- host workspace follow (TICKET-HARNESS-70) ----- */

  // When the user switches repository in OpenChamber, the host pushes the new
  // directory; follow it onto the matching tab (unless a tab was picked by
  // hand). `onDirectory` replays the current directory on subscribe, so this is
  // also the single place that keeps state in sync after a late handshake.
  host.onDirectory((directory: string | null) => {
    hostDirectory = directory;
    if (!syncActiveTabWithDirectory()) return;
    render();
    void load();
  });

  render();
  void load();
};

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Kanban: missing #root');
const rootElement = root;
let mounted = false;

host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  mount(host, rootElement, context);
});

window.addEventListener('pagehide', () => {
  host.dispose();
});
