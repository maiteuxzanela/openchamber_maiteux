/**
 * Multirepo Diff panel (TICKET-HARNESS-40).
 *
 * Renders the Ensemble ledger as a three-level tree — room → repository → file —
 * with a unified diff viewer and one-click reversion at file, repository and
 * room scope. The iframe never touches the filesystem: every read/write goes
 * through `host.serviceRequest` (CONTRACT_MULTIREPO.md §2/§3), and the host
 * proxies to the guest service. Theme and locale come from `ready` context.
 *
 * Full-screen (`contributes.page`) and rail (300–420px) share this one bundle:
 * above 720px the tree and the diff sit side by side; below that the diff takes
 * over the pane and a Back button returns to the tree.
 */

import {
  connectHost,
  HostRequestError,
  type GuestRequest,
  type HostClient,
  type HostReadyContext,
} from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import type {
  ApiErrorBody,
  DiffResponse,
  DiffView,
  FileStatus,
  RepoEntry,
  RepoFileEntry,
  RoomEntry,
  RoomsResponse,
  RevertResponse,
} from '../service/contract.ts';
import { createTranslator, type MessageKey, type Translator } from './i18n.ts';

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

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const branchIcon = (): SVGSVGElement => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute(
    'd',
    'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM7.5 9v6m1.5 3.5h4a3 3 0 0 0 3-3V12',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
};

const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  unmerged: '!',
  clean: '✓',
};

const statusKey = (status: FileStatus): MessageKey => {
  switch (status) {
    case 'added':
      return 'statusAdded';
    case 'modified':
      return 'statusModified';
    case 'deleted':
      return 'statusDeleted';
    case 'renamed':
      return 'statusRenamed';
    case 'copied':
      return 'statusCopied';
    case 'untracked':
      return 'statusUntracked';
    case 'unmerged':
      return 'statusUnmerged';
    case 'clean':
      return 'statusClean';
  }
};

const repoKey = (roomId: string, root: string): string => `${roomId}::${root}`;

const splitPath = (path: string): { directory: string; name: string } => {
  const index = path.lastIndexOf('/');
  if (index < 0) return { directory: '', name: path };
  return { directory: path.slice(0, index + 1), name: path.slice(index + 1) };
};

const repoDirtyFiles = (repo: RepoEntry): number => Math.max(0, repo.counts.files - repo.counts.clean);

const repoLineStats = (repo: RepoEntry): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const file of repo.files) {
    if (file.additions !== null) additions += file.additions;
    if (file.deletions !== null) deletions += file.deletions;
  }
  return { additions, deletions };
};

/* ------------------------------------------------------------------ *
 * Syntax highlighting (dependency-free, escape-first)
 * ------------------------------------------------------------------ */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

type HighlightRule = { re: RegExp; cls: string };

const JS_KEYWORDS =
  'break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|keyof|let|namespace|new|of|private|protected|public|readonly|return|satisfies|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|as|async|await|infer|is|asserts';

const JS_RULES: HighlightRule[] = [
  { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g, cls: 'comment' },
  { re: /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, cls: 'string' },
  { re: new RegExp(`\\b(?:${JS_KEYWORDS})\\b`, 'g'), cls: 'keyword' },
  { re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/g, cls: 'literal' },
  { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: 'number' },
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/g, cls: 'fn' },
  { re: /\b[A-Z][A-Za-z0-9_]*\b/g, cls: 'type' },
];

const CSS_RULES: HighlightRule[] = [
  { re: /\/\*[\s\S]*?\*\//g, cls: 'comment' },
  { re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, cls: 'string' },
  { re: /#[0-9a-fA-F]{3,8}\b/g, cls: 'number' },
  { re: /@[a-zA-Z-]+/g, cls: 'keyword' },
  { re: /-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\b/g, cls: 'number' },
  { re: /[a-zA-Z-]+(?=\s*:)/g, cls: 'property' },
];

const HTML_RULES: HighlightRule[] = [
  { re: /<!--[\s\S]*?-->/g, cls: 'comment' },
  { re: /<\/?[a-zA-Z][\w:-]*/g, cls: 'keyword' },
  { re: /[a-zA-Z_:][-a-zA-Z0-9_:.]*(?=\s*=)/g, cls: 'property' },
  { re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, cls: 'string' },
  { re: /\/?>/g, cls: 'keyword' },
];

const MARKDOWN_RULES: HighlightRule[] = [
  { re: /^#{1,6}\s.*$/gm, cls: 'keyword' },
  { re: /`[^`]+`/g, cls: 'string' },
  { re: /\*\*[^*]+\*\*/g, cls: 'type' },
  { re: /\[[^\]]+\]\([^)]+\)/g, cls: 'fn' },
  { re: /^\s*[-*+]\s/gm, cls: 'keyword' },
];

const PYTHON_RULES: HighlightRule[] = [
  { re: /#[^\n]*/g, cls: 'comment' },
  { re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, cls: 'string' },
  {
    re: /\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|and|or|not|in|is|None|True|False|async|await|global|nonlocal|del|assert)\b/g,
    cls: 'keyword',
  },
  { re: /@[A-Za-z_][\w.]*/g, cls: 'type' },
  { re: /\b\d+(?:\.\d+)?\b/g, cls: 'number' },
  { re: /\b[A-Za-z_]\w*(?=\s*\()/g, cls: 'fn' },
];

const BASH_RULES: HighlightRule[] = [
  { re: /#[^\n]*/g, cls: 'comment' },
  { re: /"(?:\\.|[^"\\])*"|'[^']*'/g, cls: 'string' },
  { re: /\$\{[^}]+\}|\$[A-Za-z_]\w*/g, cls: 'type' },
  {
    re: /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|echo|printf|cd|source|set|unset|exit|read|shift)\b/g,
    cls: 'keyword',
  },
  { re: /\b\d+\b/g, cls: 'number' },
];

const YAML_RULES: HighlightRule[] = [
  { re: /#[^\n]*/g, cls: 'comment' },
  { re: /"(?:\\.|[^"\\])*"|'(?:[^']|'')*'/g, cls: 'string' },
  { re: /^\s*[\w.-]+(?=\s*:)/gm, cls: 'property' },
  { re: /\b(?:true|false|null|yes|no|on|off)\b/gi, cls: 'literal' },
  { re: /\b\d+(?:\.\d+)?\b/g, cls: 'number' },
];

const JSON_RULES: HighlightRule[] = [
  { re: /"(?:\\.|[^"\\])*"(?=\s*:)/g, cls: 'property' },
  { re: /"(?:\\.|[^"\\])*"/g, cls: 'string' },
  { re: /\b(?:true|false|null)\b/g, cls: 'literal' },
  { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, cls: 'number' },
];

const rulesFor = (language: string): HighlightRule[] => {
  const lang = language.toLowerCase();
  if (lang === 'json' || lang === 'jsonc' || lang === 'json5') return JSON_RULES;
  if (lang === 'css' || lang === 'scss' || lang === 'less') return CSS_RULES;
  if (lang === 'html' || lang === 'xml' || lang === 'svg' || lang === 'vue' || lang === 'svelte') {
    return HTML_RULES;
  }
  if (lang === 'markdown' || lang === 'md' || lang === 'mdx') return MARKDOWN_RULES;
  if (lang === 'python' || lang === 'py') return PYTHON_RULES;
  if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') return BASH_RULES;
  if (lang === 'yaml' || lang === 'yml') return YAML_RULES;
  if (
    lang === 'typescript' ||
    lang === 'javascript' ||
    lang === 'ts' ||
    lang === 'js' ||
    lang === 'tsx' ||
    lang === 'jsx' ||
    lang === 'mjs' ||
    lang === 'cjs'
  ) {
    return JS_RULES;
  }
  return [];
};

const highlight = (text: string, language: string): string => {
  if (text === '') return '';
  const rules = rulesFor(language);
  if (rules.length === 0) return escapeHtml(text);

  const matches: Array<{ start: number; end: number; cls: string; text: string }> = [];
  for (const rule of rules) {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
    const re = new RegExp(rule.re.source, flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      if (match[0].length > 0) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          cls: rule.cls,
          text: match[0],
        });
      }
      if (match[0].length === 0) re.lastIndex += 1;
      match = re.exec(text);
    }
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  let html = '';
  let cursor = 0;
  for (const token of matches) {
    if (token.start < cursor) continue;
    html += escapeHtml(text.slice(cursor, token.start));
    html += `<span class="mrd-tok-${token.cls}">${escapeHtml(token.text)}</span>`;
    cursor = token.end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
};

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

type StatusFilter = 'active' | 'archived' | 'all';

type Selection = {
  roomId: string;
  repoRoot: string;
  path: string;
  repoName: string;
  status: FileStatus;
};

type RevertTarget =
  | { scope: 'file'; room: RoomEntry; repo: RepoEntry; file: RepoFileEntry }
  | { scope: 'repo'; room: RoomEntry; repo: RepoEntry }
  | { scope: 'room'; room: RoomEntry };

type ToastTone = 'success' | 'error' | 'info';

type State = {
  rooms: RoomEntry[];
  database: string;
  generatedAt: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  filter: StatusFilter;
  query: string;
  expandedRooms: Set<string>;
  expandedRepos: Set<string>;
  defaultsApplied: boolean;
  selection: Selection | null;
  detailOpen: boolean;
  diff: DiffResponse | null;
  diffLoading: boolean;
  diffError: string | null;
  diffView: DiffView;
  context: number;
  revert: { target: RevertTarget; busy: boolean; error: string | null } | null;
  toast: { text: string; tone: ToastTone } | null;
  toastTimer: number | null;
};

type Refs = {
  root: HTMLElement;
  subtitle: HTMLElement;
  footnote: HTMLElement;
  refresh: HTMLButtonElement;
  filterButtons: Map<StatusFilter, HTMLButtonElement>;
  search: HTMLInputElement;
  banner: HTMLElement;
  bannerText: HTMLElement;
  bannerRetry: HTMLButtonElement;
  treeScroll: HTMLElement;
  treeEmpty: HTMLElement;
  treeScrollWrap: HTMLElement;
  detailTitle: HTMLElement;
  detailMeta: HTMLElement;
  detailRevert: HTMLButtonElement;
  back: HTMLButtonElement;
  viewSelect: HTMLSelectElement;
  contextSelect: HTMLSelectElement;
  diffScroll: HTMLElement;
  modal: HTMLElement;
  modalDialog: HTMLElement;
  modalTitle: HTMLElement;
  modalBody: HTMLElement;
  modalWarning: HTMLElement;
  modalError: HTMLElement;
  modalCancel: HTMLButtonElement;
  modalConfirm: HTMLButtonElement;
  toast: HTMLElement;
};

const mount = (host: HostClient, rootElement: HTMLElement, ready: HostReadyContext): void => {
  const t: Translator = createTranslator(ready.locale);
  document.documentElement.lang = ready.locale || 'en';

  const state: State = {
    rooms: [],
    database: '',
    generatedAt: null,
    loaded: false,
    loading: false,
    error: null,
    filter: 'active',
    query: '',
    expandedRooms: new Set<string>(),
    expandedRepos: new Set<string>(),
    defaultsApplied: false,
    selection: null,
    detailOpen: false,
    diff: null,
    diffLoading: false,
    diffError: null,
    diffView: 'combined',
    context: 3,
    revert: null,
    toast: null,
    toastTimer: null,
  };

  /* ---------------- skeleton ---------------- */

  rootElement.replaceChildren();

  const topbar = make('header', 'mrd-topbar');
  const heading = make('div', 'mrd-heading');
  const title = make('h1', 'mrd-title', t('title'));
  const subtitle = make('p', 'mrd-subtitle', t('loading'));
  const footnote = make('p', 'mrd-footnote');
  footnote.hidden = true;
  heading.append(title, subtitle, footnote);

  const refresh = make('button', 'mrd-btn mrd-refresh');
  refresh.type = 'button';
  refresh.textContent = t('refresh');

  topbar.append(heading, refresh);

  const toolbar = make('div', 'mrd-toolbar');
  const filters = make('div', 'mrd-segmented');
  filters.setAttribute('role', 'tablist');
  filters.setAttribute('aria-label', t('title'));
  const filterButtons = new Map<StatusFilter, HTMLButtonElement>();
  const filterDefs: Array<[StatusFilter, MessageKey]> = [
    ['active', 'filterActive'],
    ['archived', 'filterArchived'],
    ['all', 'filterAll'],
  ];
  for (const [value, key] of filterDefs) {
    const button = make('button', 'mrd-segment', t(key));
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset['filter'] = value;
    button.addEventListener('click', () => {
      if (state.filter === value) return;
      state.filter = value;
      clearSelection();
      void loadRooms(false);
    });
    filterButtons.set(value, button);
    filters.append(button);
  }

  const search = make('input', 'mrd-search');
  search.type = 'search';
  search.placeholder = t('search');
  search.setAttribute('aria-label', t('search'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    renderTree();
  });

  toolbar.append(filters, search);

  const banner = make('div', 'mrd-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'alert');
  const bannerText = make('p', 'mrd-banner-text');
  const bannerRetry = make('button', 'mrd-btn is-compact');
  bannerRetry.type = 'button';
  bannerRetry.textContent = t('retry');
  bannerRetry.addEventListener('click', () => void loadRooms(true));
  banner.append(bannerText, bannerRetry);

  const body = make('main', 'mrd-body');
  const treePane = make('section', 'mrd-tree-pane');
  treePane.setAttribute('aria-label', t('title'));
  const treeScrollWrap = make('div', 'mrd-tree-wrap');
  const treeScroll = make('div', 'mrd-tree');
  treeScrollWrap.append(treeScroll);
  const treeEmpty = make('div', 'mrd-tree-empty');
  treePane.append(treeScrollWrap, treeEmpty);

  const detailPane = make('section', 'mrd-detail-pane');
  detailPane.setAttribute('aria-label', t('diffTitle'));

  const detailHead = make('div', 'mrd-detail-head');
  const back = make('button', 'mrd-btn mrd-back');
  back.type = 'button';
  back.textContent = t('back');
  back.addEventListener('click', () => {
    state.detailOpen = false;
    rootElement.dataset['detail'] = 'closed';
    renderDetail();
    refs.treeScroll.querySelector<HTMLElement>('[data-focus-key^="room:"]')?.focus();
  });

  const detailHeading = make('div', 'mrd-detail-heading');
  const detailTitle = make('h2', 'mrd-detail-title');
  const detailMeta = make('p', 'mrd-detail-meta');
  detailMeta.hidden = true;
  detailHeading.append(detailTitle, detailMeta);

  const detailTools = make('div', 'mrd-detail-tools');
  const viewSelect = make('select', 'mrd-select');
  viewSelect.setAttribute('aria-label', t('diffTitle'));
  const viewDefs: Array<[DiffView, MessageKey]> = [
    ['combined', 'viewCombined'],
    ['staged', 'viewStaged'],
    ['worktree', 'viewWorktree'],
  ];
  for (const [value, key] of viewDefs) {
    const option = make('option', undefined, t(key));
    option.value = value;
    viewSelect.append(option);
  }
  viewSelect.addEventListener('change', () => {
    state.diffView = parseView(viewSelect.value);
    if (state.selection) void loadDiff();
  });

  const contextSelect = make('select', 'mrd-select mrd-context');
  contextSelect.setAttribute('aria-label', t('context'));
  for (const value of [0, 3, 6, 12, 25]) {
    const option = make('option', undefined, String(value));
    option.value = String(value);
    contextSelect.append(option);
  }
  contextSelect.value = String(state.context);
  contextSelect.addEventListener('change', () => {
    const parsed = Number.parseInt(contextSelect.value, 10);
    state.context = Number.isFinite(parsed) ? Math.min(50, Math.max(0, parsed)) : 3;
    if (state.selection) void loadDiff();
  });

  const detailRevert = make('button', 'mrd-btn is-danger');
  detailRevert.type = 'button';
  detailRevert.textContent = t('revertFile');
  detailRevert.hidden = true;
  detailRevert.addEventListener('click', () => {
    const located = locateSelection();
    if (!located) return;
    openRevert({ scope: 'file', room: located.room, repo: located.repo, file: located.file });
  });

  detailTools.append(viewSelect, contextSelect, detailRevert);
  detailHead.append(back, detailHeading, detailTools);

  const diffScroll = make('div', 'mrd-diff');
  detailPane.append(detailHead, diffScroll);

  body.append(treePane, detailPane);

  const modal = make('div', 'mrd-modal');
  modal.hidden = true;
  const modalDialog = make('div', 'mrd-modal-dialog');
  modalDialog.setAttribute('role', 'dialog');
  modalDialog.setAttribute('aria-modal', 'true');
  modalDialog.setAttribute('aria-labelledby', 'mrd-modal-title');
  modalDialog.tabIndex = -1;
  const modalTitle = make('h2', 'mrd-modal-title');
  modalTitle.id = 'mrd-modal-title';
  const modalBody = make('p', 'mrd-modal-body');
  const modalWarning = make('p', 'mrd-modal-warning');
  const modalError = make('p', 'mrd-modal-error');
  modalError.hidden = true;
  const modalActions = make('div', 'mrd-modal-actions');
  const modalCancel = make('button', 'mrd-btn');
  modalCancel.type = 'button';
  modalCancel.textContent = t('cancel');
  const modalConfirm = make('button', 'mrd-btn is-danger');
  modalConfirm.type = 'button';
  modalConfirm.textContent = t('confirm');
  modalActions.append(modalCancel, modalConfirm);
  modalDialog.append(modalTitle, modalBody, modalWarning, modalError, modalActions);
  modal.append(modalDialog);

  const toast = make('div', 'mrd-toast');
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  rootElement.append(topbar, toolbar, banner, body, modal, toast);

  const refs: Refs = {
    root: rootElement,
    subtitle,
    footnote,
    refresh,
    filterButtons,
    search,
    banner,
    bannerText,
    bannerRetry,
    treeScroll,
    treeEmpty,
    treeScrollWrap,
    detailTitle,
    detailMeta,
    detailRevert,
    back,
    viewSelect,
    contextSelect,
    diffScroll,
    modal,
    modalDialog,
    modalTitle,
    modalBody,
    modalWarning,
    modalError,
    modalCancel,
    modalConfirm,
    toast,
  };

  /* ---------------- data access ---------------- */

  const requestJson = async <T,>(request: GuestRequest): Promise<T> => {
    const result = await host.serviceRequest(request);
    if (result.status >= 400) {
      let code = `http-${result.status}`;
      let message = `HTTP ${result.status}`;
      try {
        const parsed = JSON.parse(result.body) as ApiErrorBody;
        if (parsed.error?.code) code = parsed.error.code;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        /* keep the HTTP-level message */
      }
      throw new ApiError(result.status, code, message);
    }
    try {
      return (result.body ? JSON.parse(result.body) : {}) as T;
    } catch {
      throw new ApiError(result.status, 'invalid-json', t('errInvalidJson'));
    }
  };

  const describeError = (error: unknown): string => {
    if (error instanceof HostRequestError) {
      switch (error.code) {
        case 'NO_SERVICE':
          return t('errNoService');
        case 'DISABLED':
          return t('errDisabled');
        case 'SERVICE_FAILED':
          return t('errServiceFailed');
        case 'HOST_TIMEOUT':
          return t('errTimeout');
        case 'HOST_UNAVAILABLE':
          return t('errHostUnavailable');
        default:
          return t('errRequest', { code: error.code });
      }
    }
    if (error instanceof ApiError || error instanceof Error) return error.message;
    return t('errUnknown');
  };

  let diffToken = 0;
  let queuedLoad: { refresh: boolean } | null = null;

  const findRoom = (roomId: string): RoomEntry | null =>
    state.rooms.find((room) => room.id === roomId) ?? null;

  const locateSelection = (): { room: RoomEntry; repo: RepoEntry; file: RepoFileEntry } | null => {
    const selection = state.selection;
    if (!selection) return null;
    const room = findRoom(selection.roomId);
    if (!room) return null;
    const repo = room.repos.find((entry) => entry.root === selection.repoRoot);
    if (!repo) return null;
    const file = repo.files.find((entry) => entry.path === selection.path);
    if (!file) return null;
    return { room, repo, file };
  };

  const clearSelection = (): void => {
    state.selection = null;
    state.detailOpen = false;
    state.diff = null;
    state.diffLoading = false;
    state.diffError = null;
    diffToken += 1;
  };

  const applyDefaults = (): void => {
    if (state.defaultsApplied) return;
    state.defaultsApplied = true;
    let expanded = 0;
    for (const room of state.rooms) {
      if (room.totals.dirtyFiles <= 0) continue;
      state.expandedRooms.add(room.id);
      const repo = room.repos.find((entry) => repoDirtyFiles(entry) > 0) ?? room.repos[0];
      if (repo) state.expandedRepos.add(repoKey(room.id, repo.root));
      expanded += 1;
      if (expanded >= 3) break;
    }
    if (expanded === 0) {
      const first = state.rooms.find((room) => room.repos.length > 0);
      if (first) {
        state.expandedRooms.add(first.id);
        const repo = first.repos[0];
        if (repo) state.expandedRepos.add(repoKey(first.id, repo.root));
      }
    }
  };

  const loadRooms = async (refreshCache: boolean): Promise<void> => {
    if (state.loading) {
      // A filter switch or a post-revert refresh landed on an in-flight load.
      // Coalesce it instead of dropping it, otherwise the board could keep
      // showing rows that belong to the previous filter.
      queuedLoad = { refresh: refreshCache || (queuedLoad?.refresh ?? false) };
      return;
    }
    state.loading = true;
    state.error = null;
    render();
    const hadDiff = state.diff !== null && state.selection !== null;
    try {
      const query: Record<string, string> = { status: state.filter };
      if (refreshCache) query['refresh'] = '1';
      const data = await requestJson<RoomsResponse>({
        method: 'GET',
        path: '/api/multirepo/rooms',
        query,
      });
      state.rooms = Array.isArray(data.rooms) ? data.rooms : [];
      state.database = typeof data.database === 'string' ? data.database : '';
      state.generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : null;
      state.loaded = true;
      applyDefaults();

      if (state.selection) {
        const located = locateSelection();
        if (located) {
          state.selection = { ...state.selection, status: located.file.status };
        } else {
          clearSelection();
        }
      }
    } catch (error) {
      state.error = describeError(error);
    } finally {
      state.loading = false;
      render();
      const queued = queuedLoad;
      queuedLoad = null;
      if (queued) {
        void loadRooms(queued.refresh);
      } else if (hadDiff && state.selection) {
        void loadDiff();
      }
    }
  };

  const loadDiff = async (): Promise<void> => {
    const selection = state.selection;
    if (!selection) return;
    const token = ++diffToken;
    state.diffLoading = true;
    state.diffError = null;
    render();
    try {
      const data = await requestJson<DiffResponse>({
        method: 'GET',
        path: '/api/multirepo/diff',
        query: {
          room: selection.roomId,
          repo: selection.repoRoot,
          file: selection.path,
          view: state.diffView,
          context: String(state.context),
        },
      });
      if (token !== diffToken) return;
      state.diff = data;
    } catch (error) {
      if (token !== diffToken) return;
      state.diff = null;
      state.diffError = describeError(error);
    } finally {
      if (token === diffToken) {
        state.diffLoading = false;
        render();
      }
    }
  };

  const selectFile = (room: RoomEntry, repo: RepoEntry, file: RepoFileEntry): void => {
    if (file.status === 'clean') return;
    state.selection = {
      roomId: room.id,
      repoRoot: repo.root,
      path: file.path,
      repoName: repo.name,
      status: file.status,
    };
    state.detailOpen = true;
    state.diff = null;
    state.diffError = null;
    render();
    void loadDiff();
  };

  /* ---------------- revert ---------------- */

  let lastFocused: HTMLElement | null = null;

  const openRevert = (target: RevertTarget): void => {
    state.revert = { target, busy: false, error: null };
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    renderModal();
    refs.modal.hidden = false;
    document.body.classList.add('mrd-modal-open');
    refs.modalCancel.focus();
  };

  const closeRevert = (): void => {
    if (!state.revert || state.revert.busy) return;
    state.revert = null;
    refs.modal.hidden = true;
    document.body.classList.remove('mrd-modal-open');
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  };

  const performRevert = async (): Promise<void> => {
    const revert = state.revert;
    if (!revert || revert.busy) return;
    revert.busy = true;
    revert.error = null;
    renderModal();

    let payload: Record<string, string>;
    if (revert.target.scope === 'file') {
      payload = {
        room: revert.target.room.id,
        scope: 'file',
        repo: revert.target.repo.root,
        file: revert.target.file.path,
      };
    } else if (revert.target.scope === 'repo') {
      payload = { room: revert.target.room.id, scope: 'repo', repo: revert.target.repo.root };
    } else {
      payload = { room: revert.target.room.id, scope: 'room' };
    }

    try {
      const response = await requestJson<RevertResponse>({
        method: 'POST',
        path: '/api/multirepo/revert',
        body: payload,
      });
      state.revert = null;
      refs.modal.hidden = true;
      document.body.classList.remove('mrd-modal-open');
      showToast(
        response.counts.reverted > 0
          ? t('revertDone', { count: response.counts.reverted, skipped: response.counts.skipped })
          : t('revertNothing'),
        response.counts.reverted > 0 ? 'success' : 'info',
      );
      await loadRooms(true);
    } catch (error) {
      revert.busy = false;
      revert.error = t('revertFailed', { message: describeError(error) });
      renderModal();
    }
  };

  refs.modalCancel.addEventListener('click', closeRevert);
  refs.modalConfirm.addEventListener('click', () => void performRevert());
  refs.modal.addEventListener('click', (event) => {
    if (event.target === refs.modal) closeRevert();
  });
  refs.modalDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRevert();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      refs.modalDialog.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const describeRevert = (target: RevertTarget): { title: string; body: string } => {
    if (target.scope === 'file') {
      return {
        title: t('revertFileTitle'),
        body: t('revertFileBody', { file: target.file.path, repo: target.repo.name }),
      };
    }
    if (target.scope === 'repo') {
      return {
        title: t('revertRepoTitle'),
        body: t('revertRepoBody', {
          count: repoDirtyFiles(target.repo),
          repo: target.repo.name,
        }),
      };
    }
    return {
      title: t('revertRoomTitle'),
      body: t('revertRoomBody', {
        count: target.room.totals.dirtyFiles,
        room: target.room.name,
      }),
    };
  };

  /* ---------------- rendering ---------------- */

  const showToast = (text: string, tone: ToastTone): void => {
    state.toast = { text, tone };
    if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      state.toast = null;
      state.toastTimer = null;
      renderToast();
    }, 5000);
    renderToast();
  };

  const renderToast = (): void => {
    const toast = state.toast;
    if (!toast) {
      refs.toast.hidden = true;
      refs.toast.textContent = '';
      return;
    }
    refs.toast.hidden = false;
    refs.toast.textContent = toast.text;
    refs.toast.dataset['tone'] = toast.tone;
  };

  const renderModal = (): void => {
    const revert = state.revert;
    if (!revert) {
      refs.modal.hidden = true;
      document.body.classList.remove('mrd-modal-open');
      return;
    }
    const copy = describeRevert(revert.target);
    refs.modalTitle.textContent = copy.title;
    refs.modalBody.textContent = copy.body;
    refs.modalWarning.textContent = t('revertWarning');
    refs.modalError.hidden = revert.error === null;
    refs.modalError.textContent = revert.error ?? '';
    refs.modalCancel.disabled = revert.busy;
    refs.modalConfirm.disabled = revert.busy;
    refs.modalConfirm.textContent = revert.busy ? t('reverting') : t('confirm');
  };

  const renderTopbar = (): void => {
    const repos = state.rooms.reduce((sum, room) => sum + room.totals.repos, 0);
    const files = state.rooms.reduce((sum, room) => sum + room.totals.files, 0);
    if (state.loading && !state.loaded) {
      refs.subtitle.textContent = t('loading');
    } else {
      refs.subtitle.textContent = t('sub', {
        rooms: state.rooms.length,
        repos,
        files,
      });
    }

    if (state.loaded && (state.database || state.generatedAt)) {
      const parts: string[] = [];
      if (state.database) parts.push(`${t('database')}: ${state.database}`);
      if (state.generatedAt) {
        const when = formatTime(state.generatedAt);
        if (when) parts.push(t('updated', { when }));
      }
      refs.footnote.textContent = parts.join(' · ');
      refs.footnote.title = refs.footnote.textContent;
      refs.footnote.hidden = parts.length === 0;
    } else {
      refs.footnote.hidden = true;
    }

    refs.refresh.disabled = state.loading;
    refs.refresh.setAttribute('aria-busy', String(state.loading));
    refs.refresh.textContent = state.loading ? t('refreshing') : t('refresh');

    for (const [value, button] of refs.filterButtons) {
      const active = state.filter === value;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('is-active', active);
      button.tabIndex = active ? 0 : -1;
    }

    if (refs.search.value !== state.query && document.activeElement !== refs.search) {
      refs.search.value = state.query;
    }
  };

  const renderBanner = (): void => {
    if (state.error) {
      refs.banner.hidden = false;
      refs.bannerText.textContent = state.error;
      refs.bannerRetry.hidden = false;
    } else {
      refs.banner.hidden = true;
      refs.bannerText.textContent = '';
      refs.bannerRetry.hidden = true;
    }
  };

  const buildTreeEmpty = (): HTMLElement => {
    let emptyTitle = t('emptyTitle');
    let emptyBody = t('emptyBody');
    let showRetry = false;

    if (state.loading && !state.loaded) {
      emptyTitle = t('loading');
      emptyBody = '';
    } else if (state.error && state.rooms.length === 0) {
      emptyTitle = t('errorTitle');
      emptyBody = state.error;
      showRetry = true;
    } else if (state.rooms.length === 0) {
      emptyTitle = t('roomsEmpty');
      emptyBody = '';
    } else if (visibleRooms().length === 0) {
      emptyTitle = t('roomsEmpty');
      emptyBody = '';
    }

    const box = make('div', 'mrd-empty');
    const art = make('div', 'mrd-empty-art');
    art.append(branchIcon());
    box.append(art, make('h2', 'mrd-empty-title', emptyTitle));
    if (emptyBody) box.append(make('p', 'mrd-empty-body', emptyBody));
    if (showRetry) {
      const retry = make('button', 'mrd-btn', t('retry'));
      retry.type = 'button';
      retry.addEventListener('click', () => void loadRooms(true));
      box.append(retry);
    }
    return box;
  };

  const visibleRooms = (): RoomEntry[] => {
    const query = state.query.toLowerCase();
    if (query === '') return state.rooms;
    return state.rooms.filter((room) => {
      if (room.name.toLowerCase().includes(query)) return true;
      return room.repos.some(
        (repo) =>
          repo.name.toLowerCase().includes(query) ||
          repo.root.toLowerCase().includes(query) ||
          repo.files.some(
            (file) =>
              file.path.toLowerCase().includes(query) ||
              (file.previousPath ?? '').toLowerCase().includes(query),
          ),
      );
    });
  };

  const buildFileRow = (room: RoomEntry, repo: RepoEntry, file: RepoFileEntry): HTMLElement => {
    const selected =
      state.selection !== null &&
      state.selection.roomId === room.id &&
      state.selection.repoRoot === repo.root &&
      state.selection.path === file.path;

    const row = make('div', 'mrd-file');
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-clean', file.status === 'clean');

    const main = make('button', 'mrd-file-main');
    main.type = 'button';
    main.disabled = file.status === 'clean';
    main.dataset['focusKey'] = `file:${repoKey(room.id, repo.root)}:${file.path}`;
    main.setAttribute('aria-label', `${t(statusKey(file.status))}: ${file.path}`);
    if (selected) main.setAttribute('aria-current', 'true');
    main.addEventListener('click', () => selectFile(room, repo, file));

    const badge = make('span', `mrd-status is-${file.status}`, STATUS_LETTER[file.status]);
    badge.title = t(statusKey(file.status));

    const path = make('span', 'mrd-file-path');
    const current = splitPath(file.path);
    if (file.previousPath) {
      path.append(
        make('span', 'mrd-file-prev', file.previousPath),
        make('span', 'mrd-file-arrow', ' → '),
        make('span', 'mrd-file-dir', current.directory),
        make('span', 'mrd-file-current', current.name),
      );
    } else {
      if (current.directory) path.append(make('span', 'mrd-file-dir', current.directory));
      path.append(make('span', 'mrd-file-current', current.name));
    }
    path.title = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;

    const stats = make('span', 'mrd-file-stats');
    if (file.binary) {
      stats.textContent = 'bin';
      stats.title = t('diffBinary');
    } else if (file.status === 'clean') {
      stats.textContent = t('statusClean');
    } else {
      const additions = file.additions ?? 0;
      const deletions = file.deletions ?? 0;
      if (additions > 0) stats.append(make('span', 'mrd-add', `+${additions}`));
      if (deletions > 0) stats.append(make('span', 'mrd-del', `−${deletions}`));
    }

    main.append(badge, path, stats);

    const revert = make('button', 'mrd-file-revert');
    revert.type = 'button';
    revert.textContent = t('revertShort');
    revert.disabled = file.status === 'clean';
    revert.title = `${t('revertFile')}: ${file.path}`;
    revert.setAttribute('aria-label', `${t('revertFile')}: ${file.path}`);
    revert.addEventListener('click', (event) => {
      event.stopPropagation();
      openRevert({ scope: 'file', room, repo, file });
    });

    row.append(main, revert);
    return row;
  };

  const buildRepo = (room: RoomEntry, repo: RepoEntry, forceOpen: boolean): HTMLElement => {
    const key = repoKey(room.id, repo.root);
    const open = forceOpen || state.expandedRepos.has(key);
    const dirty = repoDirtyFiles(repo);
    const stats = repoLineStats(repo);

    const box = make('div', 'mrd-repo');

    const head = make('div', 'mrd-repo-head');
    const toggle = make('button', 'mrd-disclosure is-repo');
    toggle.type = 'button';
    toggle.dataset['focusKey'] = `repo:${key}`;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? t('collapse') : t('expand'));
    const text = make('span', 'mrd-disclosure-text');
    const line = make('span', 'mrd-disclosure-line');
    line.append(
      make('span', 'mrd-repo-name', repo.name),
      make('span', 'mrd-badge is-branch', repo.branch ?? t('detached')),
    );
    const sub = make('span', 'mrd-disclosure-sub');
    sub.append(
      make(
        'span',
        'mrd-repo-meta',
        `${t('filesCount', { count: repo.counts.files })} · ${t('dirtyCount', { count: dirty })}`,
      ),
    );
    if (stats.additions > 0 || stats.deletions > 0) {
      const lines = make('span', 'mrd-repo-lines');
      if (stats.additions > 0) lines.append(make('span', 'mrd-add', `+${stats.additions}`));
      if (stats.deletions > 0) lines.append(make('span', 'mrd-del', `−${stats.deletions}`));
      sub.append(lines);
    }
    text.append(line, sub);
    toggle.append(make('span', 'mrd-caret'), text);
    toggle.addEventListener('click', () => {
      if (state.expandedRepos.has(key)) state.expandedRepos.delete(key);
      else state.expandedRepos.add(key);
      renderTree();
      focusByKey(`repo:${key}`);
    });

    const actions = make('div', 'mrd-repo-actions');
    const revert = make('button', 'mrd-btn is-danger is-compact');
    revert.type = 'button';
    revert.textContent = t('revertShort');
    revert.disabled = dirty === 0;
    revert.title = t('revertRepo');
    revert.setAttribute('aria-label', `${t('revertRepo')}: ${repo.name}`);
    revert.addEventListener('click', () => openRevert({ scope: 'repo', room, repo }));
    actions.append(revert);

    head.append(toggle, actions);
    box.append(head);

    if (repo.error) {
      const alert = make('p', 'mrd-notice is-error', t('gitError', { message: repo.error }));
      box.append(alert);
    }
    if (repo.truncatedFiles > 0) {
      box.append(make('p', 'mrd-notice is-warning', t('omitted', { count: repo.truncatedFiles })));
    }

    if (open) {
      const files = make('div', 'mrd-files');
      if (repo.files.length === 0) {
        files.append(make('p', 'mrd-muted', t('emptyBody')));
      } else {
        for (const file of repo.files) files.append(buildFileRow(room, repo, file));
      }
      box.append(files);
    }

    return box;
  };

  const buildRoom = (room: RoomEntry, forceOpen: boolean): HTMLElement => {
    const open = forceOpen || state.expandedRooms.has(room.id);
    const card = make('section', 'mrd-room');
    card.classList.toggle('is-archived', room.status === 'archived');

    const head = make('div', 'mrd-room-head');
    const toggle = make('button', 'mrd-disclosure is-room');
    toggle.type = 'button';
    toggle.dataset['focusKey'] = `room:${room.id}`;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? t('collapse') : t('expand'));
    const text = make('span', 'mrd-disclosure-text');
    const line = make('span', 'mrd-disclosure-line');
    line.append(
      make('span', 'mrd-room-name', room.name),
      make(
        'span',
        'mrd-badge is-room',
        room.status === 'archived' ? t('filterArchived') : t('filterActive'),
      ),
    );
    const sub = make(
      'span',
      'mrd-disclosure-sub',
      `${t('reposCount', { count: room.totals.repos })} · ${t('filesCount', { count: room.totals.files })} · ${t('dirtyCount', { count: room.totals.dirtyFiles })}`,
    );
    text.append(line, sub);
    toggle.append(make('span', 'mrd-caret'), text);
    toggle.addEventListener('click', () => {
      if (state.expandedRooms.has(room.id)) state.expandedRooms.delete(room.id);
      else state.expandedRooms.add(room.id);
      renderTree();
      focusByKey(`room:${room.id}`);
    });

    const actions = make('div', 'mrd-room-actions');
    const revert = make('button', 'mrd-btn is-danger is-compact');
    revert.type = 'button';
    revert.textContent = t('revertShort');
    revert.disabled = room.totals.dirtyFiles === 0;
    revert.title = t('revertRoom');
    revert.setAttribute('aria-label', `${t('revertRoom')}: ${room.name}`);
    revert.addEventListener('click', () => openRevert({ scope: 'room', room }));
    actions.append(revert);

    head.append(toggle, actions);
    card.append(head);

    if (room.errors.length > 0) {
      const warnings = make('details', 'mrd-room-warnings');
      warnings.append(make('summary', undefined, t('warnings', { count: room.errors.length })));
      const list = make('ul', 'mrd-warning-list');
      for (const issue of room.errors) {
        list.append(make('li', undefined, `${issue.path} — ${issue.reason}`));
      }
      warnings.append(list);
      card.append(warnings);
    }

    if (open) {
      const roomBody = make('div', 'mrd-room-body');
      if (room.repos.length === 0) {
        roomBody.append(make('p', 'mrd-muted', t('emptyBody')));
      } else {
        for (const repo of room.repos) roomBody.append(buildRepo(room, repo, forceOpen));
      }
      card.append(roomBody);
    }

    return card;
  };

  const renderTree = (): void => {
    const scrollTop = refs.treeScroll.scrollTop;
    const rooms = visibleRooms();
    const queryActive = state.query !== '';
    const cards: HTMLElement[] = [];
    for (const room of rooms) cards.push(buildRoom(room, queryActive));
    refs.treeScroll.replaceChildren(...cards);

    if (rooms.length === 0) {
      refs.treeEmpty.replaceChildren(buildTreeEmpty());
      refs.treeEmpty.hidden = false;
      refs.treeScrollWrap.hidden = true;
    } else {
      refs.treeEmpty.hidden = true;
      refs.treeEmpty.replaceChildren();
      refs.treeScrollWrap.hidden = false;
    }
    refs.treeScroll.scrollTop = scrollTop;
  };

  const buildDiffBody = (diff: DiffResponse): HTMLElement => {
    const fragment = document.createDocumentFragment();
    for (const hunk of diff.hunks) {
      fragment.append(make('div', 'mrd-hunk', hunk.header));
      for (const line of hunk.lines) {
        const row = make('div', `mrd-line is-${line.type}`);
        const oldNumber = make('span', 'mrd-ln', line.oldNumber === null ? '' : String(line.oldNumber));
        const newNumber = make('span', 'mrd-ln', line.newNumber === null ? '' : String(line.newNumber));
        const sign = make(
          'span',
          'mrd-sign',
          line.type === 'add' ? '+' : line.type === 'del' ? '−' : '',
        );
        const code = make('code', 'mrd-code');
        code.innerHTML = line.type === 'meta' ? escapeHtml(line.text) : highlight(line.text, diff.language);
        row.append(oldNumber, newNumber, sign, code);
        fragment.append(row);
      }
    }
    const body = make('div', 'mrd-diff-body');
    body.append(fragment);
    return body;
  };

  const renderDiff = (): void => {
    const located = locateSelection();
    if (!located) {
      const box = make('div', 'mrd-empty');
      const art = make('div', 'mrd-empty-art');
      art.append(branchIcon());
      box.append(
        art,
        make('h2', 'mrd-empty-title', t('diffEmptyTitle')),
        make('p', 'mrd-empty-body', t('diffEmptyBody')),
      );
      refs.diffScroll.replaceChildren(box);
      return;
    }

    const nodes: HTMLElement[] = [];
    if (state.diffError) {
      nodes.push(make('p', 'mrd-notice is-error', state.diffError));
    } else if (state.diffLoading) {
      nodes.push(make('p', 'mrd-notice is-muted', t('diffLoading')));
    } else if (!state.diff) {
      nodes.push(make('p', 'mrd-notice is-muted', t('diffLoading')));
    } else {
      const diff = state.diff;
      if (diff.truncated) nodes.push(make('p', 'mrd-notice is-warning', t('diffTruncated')));
      if (diff.binary) {
        nodes.push(make('p', 'mrd-notice is-info', t('diffBinary')));
      } else if (diff.status === 'clean') {
        nodes.push(make('p', 'mrd-notice is-success', t('diffClean')));
      } else {
        if (diff.status === 'untracked') {
          nodes.push(make('p', 'mrd-notice is-info', t('diffUntracked')));
        }
        if (diff.hunks.length === 0) {
          nodes.push(make('p', 'mrd-notice is-muted', t('noHunks')));
        } else {
          nodes.push(buildDiffBody(diff));
        }
      }
    }
    refs.diffScroll.replaceChildren(...nodes);
  };

  const renderDetail = (): void => {
    const located = locateSelection();
    refs.root.dataset['detail'] = state.detailOpen ? 'open' : 'closed';
    refs.back.hidden = false;

    if (!located) {
      refs.detailTitle.textContent = t('diffTitle');
      refs.detailMeta.textContent = '';
      refs.detailMeta.hidden = true;
      refs.detailRevert.hidden = true;
      refs.viewSelect.disabled = true;
      refs.contextSelect.disabled = true;
    } else {
      const { repo, file } = located;
      refs.detailTitle.textContent = file.path;
      refs.detailTitle.title = file.path;
      refs.detailMeta.hidden = false;
      const additions = file.additions === null ? '—' : `+${file.additions}`;
      const deletions = file.deletions === null ? '—' : `−${file.deletions}`;
      refs.detailMeta.textContent = `${t(statusKey(file.status))} · ${repo.name} · ${additions} ${deletions}`;
      refs.detailRevert.hidden = file.status === 'clean';
      refs.detailRevert.disabled = file.status === 'clean' || state.diffLoading;
      refs.viewSelect.disabled = state.diffLoading;
      refs.contextSelect.disabled = state.diffLoading;
      refs.viewSelect.value = state.diffView;
      refs.contextSelect.value = String(state.context);
    }

    renderDiff();
  };

  const render = (): void => {
    refs.root.setAttribute('aria-busy', String(state.loading));
    renderTopbar();
    renderBanner();
    renderTree();
    renderDetail();
    renderModal();
    renderToast();
  };

  const focusByKey = (key: string): void => {
    const selector = `[data-focus-key="${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const target = refs.treeScroll.querySelector<HTMLElement>(selector);
    target?.focus();
  };

  /* ---------------- listeners ---------------- */

  refs.refresh.addEventListener('click', () => void loadRooms(true));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loaded && !state.loading) {
      void loadRooms(false);
    }
  });

  render();
  void loadRooms(false);
};

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const parseView = (value: string): DiffView => {
  if (value === 'staged' || value === 'worktree') return value;
  return 'combined';
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

const host = connectHost();
const rootElement = document.querySelector<HTMLElement>('#root');
if (!rootElement) throw new Error('Multirepo Diff: missing #root');
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
