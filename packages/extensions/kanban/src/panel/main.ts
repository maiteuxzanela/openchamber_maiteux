/**
 * Kanban panel (TICKET-HARNESS-14 · T4).
 *
 * Renders the six fixed projects plus the aggregate "Todos" tab, consumes the
 * guest service exclusively through `host.serviceRequest` (CONTRACT_KANBAN.md
 * §2/§4) and never touches the filesystem. Theme comes from `ready.theme`.
 *
 * Full-screen (`contributes.page`) and rail (300–420px) share this one bundle.
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
  body: string;
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
  meta: { version: number; project: string; title: string; updated_at: string };
  tickets: Ticket[];
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
 * Canonical project list (CONTRACT_KANBAN.md §3). The service's
 * `GET /api/projects` is authoritative at runtime (order, labels, counts);
 * this mirror only lets the tab bar render while the service is still starting
 * or before the user grants it in Settings → Extensions.
 */
const CANONICAL_PROJECTS: readonly ProjectSummary[] = [
  { id: 'projeto_jev', title: 'Projeto JEV', path: '/home/maiteuxzanela/projeto JEV', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'jez_collections', title: 'JEZ Collections', path: '/mnt/94CCB337CCB3130A/JEZ collections', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'panela_sobra', title: 'Panela de Sobra', path: '/home/maiteuxzanela/PanelaBuild', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'faturamento_medico', title: 'Faturamento Médico', path: '/mnt/94CCB337CCB3130A/Faturamento', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'predictera', title: 'Predictera', path: '/mnt/94CCB337CCB3130A/predictera', totalTickets: 0, openTickets: 0, doneTickets: 0 },
  { id: 'opencode_chambers_harness', title: 'OpenCode Chambers Harness', path: '/mnt/94CCB337CCB3130A/opencode_chambers_harness', totalTickets: 0, openTickets: 0, doneTickets: 0 },
];

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
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Erro inesperado ao consultar o serviço.';
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

const mount = (host: HostClient, root: HTMLElement): void => {
  const state: State = {
    projects: [],
    projectsLoaded: false,
    docs: new Map(),
    activeTab: TAB_ALL,
    expanded: new Set(),
    errors: new Map(),
    pending: new Set(),
    loading: false,
    serviceError: null,
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

  scroll.append(list, separator, doneList, empty);
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
      if (next) state.expanded.add(key);
      else state.expanded.delete(key);
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
      if (ticket.body.trim() !== '') {
        body.innerHTML = renderMarkdown(ticket.body);
      } else {
        const placeholder = document.createElement('p');
        placeholder.className = 'kb-body-empty';
        placeholder.textContent = 'Sem descrição.';
        body.append(placeholder);
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
  };

  const loadProject = async (project: string): Promise<void> => {
    const data = await requestJson<KanbanResponse>(host, {
      method: 'GET',
      path: '/api/kanban',
      query: { project },
    });
    const projectTitleValue = data.meta?.title || projectTitle(project);
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    state.docs.set(
      project,
      tickets.map((ticket) => ({ ...ticket, project, projectTitle: projectTitleValue })),
    );
  };

  const load = async (): Promise<void> => {
    if (state.loading) return;
    state.loading = true;
    state.serviceError = null;
    render();
    try {
      if (!state.projectsLoaded) await loadProjects();
      if (state.activeTab === TAB_ALL) {
        const ids = projectList().map((project) => project.id);
        const results = await Promise.allSettled(ids.map((id) => loadProject(id)));
        const rejected = results.filter((result) => result.status === 'rejected');
        if (ids.length > 0 && rejected.length === ids.length) {
          throw rejected[0]?.reason;
        }
      } else {
        await loadProject(state.activeTab);
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

  const renderTabs = (tickets: TaggedTicket[]): void => {
    tabs.textContent = '';
    for (const item of tabItems()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kb-tab';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(item.id === state.activeTab));
      button.tabIndex = item.id === state.activeTab ? 0 : -1;
      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(label);

      if (item.id === state.activeTab) {
        const count = document.createElement('span');
        count.className = 'kb-tab-count';
        count.textContent = String(countTicket(tickets, 'open'));
        button.append(count);
      }

      button.addEventListener('click', () => {
        if (state.activeTab === item.id) return;
        state.activeTab = item.id;
        state.serviceError = null;
        render();
        void load();
      });
      tabs.append(button);
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
    empty.hidden = total > 0 || state.loading;
    if (!empty.hidden) {
      emptyTitle.textContent = state.serviceError ? 'Não foi possível carregar' : 'Nenhum ticket';
      emptyBody.textContent = state.serviceError
        ? 'Verifique o serviço da extensão e tente novamente.'
        : 'Adicione tickets ao kanban.json deste projeto para vê-los aqui.';
    }
  };

  const render = (): void => {
    const tickets = visibleTickets();
    const scrollTop = scroll.scrollTop;

    renderTabs(tickets);
    renderList(tickets);

    const activeLabel = state.activeTab === TAB_ALL ? ALL_LABEL : projectTitle(state.activeTab);
    const openCount = countTicket(tickets, 'open');
    const doneCount = countTicket(tickets, 'done');
    subtitle.textContent = state.loading
      ? `${activeLabel} · carregando…`
      : `${activeLabel} · ${openCount} aberto${openCount === 1 ? '' : 's'} · ${doneCount} concluído${doneCount === 1 ? '' : 's'}`;

    refresh.disabled = state.loading;
    refresh.setAttribute('aria-busy', String(state.loading));
    refresh.textContent = state.loading ? 'Atualizando…' : 'Atualizar';

    if (state.serviceError) {
      banner.hidden = false;
      bannerText.textContent = state.serviceError;
    } else {
      banner.hidden = true;
      bannerText.textContent = '';
    }

    root.setAttribute('aria-busy', String(state.loading));
    scroll.scrollTop = scrollTop;
  };

  /* ----- live refresh (CONTRACT_KANBAN.md §2.7) ----- */

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load();
  });
  window.addEventListener('focus', () => {
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
  mount(host, rootElement);
});

window.addEventListener('pagehide', () => {
  host.dispose();
});
