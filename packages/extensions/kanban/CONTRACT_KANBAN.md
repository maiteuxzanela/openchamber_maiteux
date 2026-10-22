# CONTRACT_KANBAN.md — TICKET-HARNESS-14 (T1)

> **Autor:** Túlio — MCP / FastAPI / Node ESM / Schemas  
> **Workspace:** `/mnt/94CCB337CCB3130A/openchamber_maiteux`  
> **Escopo:** contrato canônico do `kanban.json` + contrato HTTP do guest service da extensão built-in `openchamber-builtin-kanban`.  
> **Fonte de verdade:** este documento governa T2 (migração), T3 (service), T4 (painel), T5 (registry/build) e T6 (testes).  
> **Decisão de execução:** a extensão roda como **built-in guest** com `contributes.panel` (rail) + `contributes.page` (full-screen) + `contributes.service` (Node ESM). O iframe nunca toca o filesystem: toda leitura/escrita passa pelo service via `serviceRequest`.

---

## 1. Schema canônico `kanban.json`

Arquivo único na raiz de cada repositório: `<repo>/kanban.json`. JSON estrito (sem comentários, sem trailing comma), UTF-8, terminado por newline.

### 1.1 Estrutura

```jsonc
{
  "meta": {
    "version": 1,
    "project": "opencode_chambers_harness",
    "title": "OpenCode Chambers Harness",
    "updated_at": "2026-10-15T13:25:00-03:00"
  },
  "tickets": [
    {
      "id": "TICKET-HARNESS-14",
      "title": "Extension Page Nativa de Kanban Multi-Projeto",
      "status": "open",
      "priority": "alta",
      "summary": "Resumo curto exibido no modo recolhido do accordion.",
      "body": "## Descrição\n...markdown extenso (descrição, critérios de aceite, evidências)...",
      "order": 14,
      "created_at": "2026-10-14T20:30:00-03:00",
      "completed_at": null
    }
  ]
}
```

### 1.2 Contrato de campos

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `meta.version` | `1` (literal) | sim | Única versão aceita hoje. |
| `meta.project` | `string` | sim | Deve ser um dos ids fixos da §3 (ex.: `projeto_jev`). |
| `meta.title` | `string` | sim | Rótulo humano exibido na UI (pt-BR). |
| `meta.updated_at` | `string` ISO-8601 | sim | Timestamp da última escrita no arquivo. |
| `tickets` | `Ticket[]` | sim | Pode ser `[]` (template vazio). Ordem física do array não é significativa. |
| `tickets[].id` | `string` | sim | Identificador estável e **único** no arquivo. |
| `tickets[].title` | `string` | sim | Título do ticket. |
| `tickets[].status` | `"open" \| "done"` | sim | Dirige a partição abertos/concluídos. |
| `tickets[].priority` | `"alta" \| "media" \| "baixa"` | sim | Sem acento em `media`. Default de migração: `media`. |
| `tickets[].summary` | `string` | sim | Texto curto do modo recolhido. Pode ser `""`. |
| `tickets[].body` | `string` | sim | Markdown extenso (descrição, critérios, evidências). Pode ser `""`. |
| `tickets[].order` | `number` (int ≥ 0) | sim | Ordem de adição; define a ordenação dos abertos. |
| `tickets[].created_at` | `string` ISO-8601 | sim | Criação. |
| `tickets[].completed_at` | `string` ISO-8601 \| `null` | sim | `null` enquanto `status === "open"`; ISO quando `"done"`. |

### 1.3 Invariantes

1. `status === "open"` ⟺ `completed_at === null`.
2. `status === "done"` ⟹ `completed_at` é uma string ISO-8601 válida.
3. `tickets[].id` único dentro do arquivo (senão o arquivo é inválido → `500`/`schema-invalid`).
4. Todo valor ISO-8601 carrega offset explícito (`-03:00` ou `Z`); nunca timestamp local sem offset.

### 1.4 Regras de ordenação (consumidas pelo painel T4)

- **Abertos:** `status === "open"`, ordenados por `order` **asc** (ordem de adição).
- **Concluídos:** `status === "done"`, ordenados por `completed_at` **desc** (mais recente no topo).
- Sem busca/filtro/ordenação manual (fora de escopo).

### 1.5 Schema Zod canônico (referência de implementação)

O service (T3) e os testes (T6) DEVEM validar com este schema (ou equivalente estruturalmente idêntico). Importável de `src/service/schema.ts`.

```ts
import { z } from 'zod'; // zod ^4.3.6 (raiz e packages/web)

export const ISO = z.iso.datetime({ offset: true }); // zod v4; z.string().datetime() segue como alias deprecado
export const STATUS = z.enum(['open', 'done']);
export const PRIORITY = z.enum(['alta', 'media', 'baixa']);

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
}).superRefine((t, ctx) => {
  if (t.status === 'open' && t.completed_at !== null)
    ctx.addIssue({ code: 'custom', message: 'open ticket must have completed_at === null' });
  if (t.status === 'done' && t.completed_at === null)
    ctx.addIssue({ code: 'custom', message: 'done ticket must have completed_at' });
});

export const projectIdSchema = z.enum([
  'projeto_jev', 'jez_collections', 'panela_sobra',
  'faturamento_medico', 'predictera', 'opencode_chambers_harness',
]);

export const kanbanSchema = z.object({
  meta: z.object({
    version: z.literal(1),
    project: projectIdSchema,
    title: z.string().min(1),
    updated_at: ISO,
  }),
  tickets: z.array(ticketSchema),
}).superRefine((doc, ctx) => {
  const seen = new Set<string>();
  for (const t of doc.tickets) {
    if (seen.has(t.id)) ctx.addIssue({ code: 'custom', message: `duplicate ticket id: ${t.id}` });
    seen.add(t.id);
  }
});

export type KanbanTicket = z.infer<typeof ticketSchema>;
export type KanbanDoc = z.infer<typeof kanbanSchema>;
```

> **Leitura com fallback seguro:** arquivo ausente → o service responde com documento derivado do template vazio (mesmo `project`/`title` da §3, `tickets: []`, `updated_at` = agora) e status `200`. Arquivo presente porém **inválido** → resposta `500` com `code: "schema-invalid"` (nunca inventa sucesso, nunca sobrescreve o arquivo).

### 1.6 Template vazio canônico (usado em `projeto_jev` e no fallback)

```json
{
  "meta": {
    "version": 1,
    "project": "projeto_jev",
    "title": "Projeto JEV",
    "updated_at": "2026-10-15T13:25:00-03:00"
  },
  "tickets": []
}
```

---

## 2. Contrato HTTP do guest service

### 2.1 Papel e fronteira

- Processo Node ESM (`service/main.ts` → `service/main.js`) spawnado pelo host OpenChamber.
- Escuta **somente** em `127.0.0.1`, na porta `process.env.OPENCHAMBER_SERVICE_PORT`.
- Toda requisição recebe `Authorization: Bearer ${OPENCHAMBER_SERVICE_TOKEN}`. Token ausente/errado → `401`.
- O painel (iframe) chama o service **exclusivamente** por `host.serviceRequest({ method, path, query?, body? })`; nunca dialoga com a porta diretamente e nunca recebe o token.
- `GET /health` é o sinal de readiness do host (polling até HTTP 200, timeout 15s).

### 2.2 `GET /health`

Prerequisito do host para marcar o service como `ready`. Não faz parte da API de negócio.

```
200 { "ok": true }
```

### 2.3 `GET /api/projects`

Lista os 6 projetos da §3 com contagens derivadas do respectivo `kanban.json`.

**Resposta `200`:**

```jsonc
{
  "projects": [
    {
      "id": "projeto_jev",
      "title": "Projeto JEV",
      "path": "/home/maiteuxzanela/projeto JEV",
      "totalTickets": 0,
      "openTickets": 0,
      "doneTickets": 0
    }
    // ... 5 demais
  ]
}
```

- `totalTickets === openTickets + doneTickets`.
- Repo sem `kanban.json` → o projeto **não** é omitido: retorna com contagens `0/0/0` (equivalente ao template vazio).
- Arquivo inválido em um repo → esse projeto recebe contagens `0/0/0` e o service registra a falha; **não** derruba a listagem inteira.

### 2.4 `GET /api/kanban?project=:id` — contrato fatiado (v2, TICKET-HARNESS-88)

Lê, parseia e valida o `kanban.json` do projeto. Retorna o documento canônico da §1 mais o `project` explícito.

**Query:** `project` — um dos ids fixos da §3 (obrigatório); `includeBody=1` (opcional, debug/teste) devolve os tickets completos.

**Resposta `200` (v2 — `body` NÃO vem na lista):**

```jsonc
{
  "project": "opencode_chambers_harness",
  "contractVersion": 2,
  "meta": {
    "version": 1,
    "project": "opencode_chambers_harness",
    "title": "OpenCode Chambers Harness",
    "updated_at": "2026-10-15T13:25:00-03:00"
  },
  "tickets": [ /* Ticket sem `body`: id, title, status, priority, summary, order, created_at, completed_at */ ]
}
```

O `body` (markdown, potencialmente grande) é servido sob demanda em §2.4.1. Assim a listagem cresce com o **número** de tickets, não com o tamanho dos corpos, e um board acima de 2 MiB continua legível. O painel **deve** recusar `contractVersion` diferente de `2` com erro explícito de versão (lockstep, F7) em vez de renderizar um board vazio.

**Precedência do campo (implementado no painel):** `contractVersion` presente e diferente de `2` (ex.: `1`, `3`, `"2"`) ⇒ erro `contract-version-mismatch` com as duas versões na mensagem e **nenhum card renderizado**. Campo **ausente** ⇒ host legado (pré-TICKET-HARNESS-88): o painel usa o `body` já embutido na listagem, sem chamar §2.4.1. A regressão é coberta por `tests/kanban_panel_v2_contract.test.ts` (casos v2, legado, `contractVersion: 3` e `413`).

**Erros:**

| Situação | HTTP | Corpo |
|---|---|---|
| `project` ausente | `400` | `{ "error": { "code": "missing-project", "message": "..." } }` |
| `project` fora da lista fixa | `404` | `{ "error": { "code": "unknown-project", "message": "..." } }` |
| arquivo existe, mas viola o schema | `500` | `{ "error": { "code": "schema-invalid", "message": "..." } }` |
| falha de I/O inesperada | `500` | `{ "error": { "code": "io-error", "message": "..." } }` |

> Arquivo **ausente** = `200` com template vazio da §1.6 (fallback seguro). Não é `404`.

### 2.4.1 `GET /api/kanban/ticket?project=:id&ticketId=:id`

Devolve **um** ticket com o `body` completo, para o painel buscar ao expandir o card.

**Query:** `project` e `ticketId` (ambos obrigatórios).

**Resposta `200`:**

```jsonc
{ "project": "opencode_chambers_harness", "contractVersion": 2, "ticket": { /* Ticket completo, com `body` */ } }
```

| Situação | HTTP | `code` |
|---|---|---|
| `project` ausente | `400` | `missing-project` |
| `ticketId` ausente | `400` | `missing-ticket` |
| `project` fora da lista fixa | `404` | `unknown-project` |
| `ticketId` inexistente no documento | `404` | `unknown-ticket` |

### 2.5 `POST /api/toggle`

Única operação de escrita. Alterna `status` e ajusta `completed_at`, numa **escrita atômica**.

**Corpo (JSON, `Content-Type: application/json`):**

```jsonc
{ "project": "opencode_chambers_harness", "ticketId": "TICKET-HARNESS-14", "done": true }
```

| Campo | Tipo | Obrigatório |
|---|---|---|
| `project` | `string` (id fixo) | sim |
| `ticketId` | `string` | sim |
| `done` | `boolean` | sim |

**Semântica:**
- `done: true` → `status = "done"`, `completed_at = now()` (ISO-8601 com offset).
- `done: false` → `status = "open"`, `completed_at = null`.
- `meta.updated_at = now()` no arquivo gravado.
- **Idempotência:** repetir o mesmo `done` regrava o arquivo e atualiza `completed_at`/`updated_at` de forma consistente (comportamento determinístico, sem erro). O toggle não adiciona/remove/edita nenhum outro campo.

**Resposta `200`:**

```jsonc
{
  "ok": true,
  "ticket": { "id": "TICKET-HARNESS-14", "status": "done", "completed_at": "2026-10-15T13:25:00-03:00" },
  "updated_at": "2026-10-15T13:25:00-03:00"
}
```

**Erros:**

| Situação | HTTP | Corpo |
|---|---|---|
| JSON malformado ou `done` não-booleano ou campo faltando | `400` | `{ "error": { "code": "invalid-payload", "message": "..." } }` |
| `project` fora da lista fixa | `404` | `{ "error": { "code": "unknown-project", "message": "..." } }` |
| `ticketId` inexistente no arquivo do projeto | `404` | `{ "error": { "code": "unknown-ticket", "message": "..." } }` |
| arquivo do projeto inválido | `500` | `{ "error": { "code": "schema-invalid", "message": "..." } }` |
| falha de I/O na escrita | `500` | `{ "error": { "code": "io-error", "message": "..." } }` |

### 2.6 Escrita atômica (obrigatória)

```
1. Serializar o documento completo (pretty, 2 espaços) + "\n".
2. Criar temp no MESMO diretório do alvo:  <dir>/.kanban.json.<pid>.<rand>.tmp
3. Escrever o buffer e dar fsync.
4. fs.rename(temp, <dir>/kanban.json)  // substituição atômica no mesmo FS
5. Em erro: remover o temp (best-effort) e responder 500 sem tocar o original.
```

- Proibido escrita direta in-place (`writeFile` no alvo) — risco de arquivo parcial.
- Sem backup automático (decisão do interrogatório #7).
- Serialização síncrona por arquivo (mutex/lock em memória) para evitar corrida entre `POST /api/toggle` concorrentes.

### 2.7 Atualização ao vivo (`fs.watch`) e cache

- O service mantém cache em memória por projeto, invalidado por `fs.watch` no `kanban.json` correspondente (e por verificação de `mtime` no read).
- `GET /api/kanban` e `GET /api/projects` servem sempre o estado consistente do disco; após um `toggle`, o cache do projeto é atualizado com o documento gravado.
- Streaming service→painel está fora de escopo (fase 1 do SDK). **Estratégia do painel (T4):** refetch ao: (a) trocar de aba/abrir painel, (b) `visibilitychange`/foco da janela, (c) logo após um toggle bem-sucedido (Optimistic UI + reconcilição). Ver §4.

---

## 3. Lista fixa dos 6 projetos

Embarcada no pacote do service. Fonte única: `projects.ts` (T3), consumida também pela UI (T4). Novo repo = pedido explícito da usuária ao Dante.

| `id` | `title` (pt-BR) | `path` absoluto |
|---|---|---|
| `projeto_jev` | Projeto JEV | `/home/maiteuxzanela/projeto JEV` |
| `jez_collections` | JEZ Collections | `/mnt/94CCB337CCB3130A/JEZ collections` |
| `panela_sobra` | Panela de Sobra | `/home/maiteuxzanela/PanelaBuild` |
| `faturamento_medico` | Faturamento Médico | `/mnt/94CCB337CCB3130A/Faturamento` |
| `predictera` | Predictera | `/mnt/94CCB337CCB3130A/predictera` |
| `opencode_chambers_harness` | OpenCode Chambers Harness | `/mnt/94CCB337CCB3130A/opencode_chambers_harness` |

O arquivo alvo de cada projeto é sempre `<path>/kanban.json`. `id` é **imutável** (chave de rota e de cache); `title` é apenas rótulo de UI.

### 3.1 Estado de migração por repositório (insumo para T2)

| Projeto | Origem | Observação |
|---|---|---|
| `projeto_jev` | — | Criar `kanban.json` vazio (template §1.6). |
| `jez_collections` | `KANBAN.md` | Preservar todos os tickets/histórico em `body`. |
| `panela_sobra` | `KANBAN.md` | idem. |
| `faturamento_medico` | `kanban.json` antigo (schema `meta`/`metrics`/`texts`/`columns`) | Migrar para o schema canônico; legar `dashboard_kanban.html`, `kanban_data.js`, `sync_kanban.py`. |
| `predictera` | `KANBAN.md` | idem. |
| `opencode_chambers_harness` | `kanban/*.md` (TICKET-* 01..21) | Um ticket por arquivo → um item em `tickets[]`; `order` = ordem de adição. |

---

## 4. Integração do painel (contrato mínimo para T4)

- `host.serviceRequest({ method: 'GET', path: '/api/projects' })` → `{ status, body }`.
- `host.serviceRequest({ method: 'GET', path: '/api/kanban', query: { project } })`.
- `host.serviceRequest({ method: 'POST', path: '/api/toggle', body: JSON.stringify({ project, ticketId, done }) })`.
- Tema: aplicar tokens de `ready.theme.tokens` (CSS variables do host). `ready.locale` disponível; UI é pt-BR fixo.
- Tratamento de erro: `status >= 400` → reverter o Optimistic UI e exibir feedback visual no card.
- Full-screen (`page`) e rail (300–420px) usam o mesmo bundle `panel/main.js`.

---

## 5. Empacotamento e registro (contrato para T5)

### 5.1 Manifest `packages/extensions/kanban/package.json`

```jsonc
{
  "name": "@openchamber/builtin-kanban",
  "version": "0.0.0",            // estampado com a versão do app no build
  "private": true,
  "type": "module",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.22.0" },
    "contributes": {
      "panel": { "id": "openchamber-builtin-kanban", "name": "Kanban", "icon": "task", "entry": "panel/index.html" },
      "page": true,
      "service": { "entry": "service/main.js", "runtime": "host", "permissions": {} }
    }
  }
}
```

### 5.2 Entrada em `packages/extensions/registry.json`

```jsonc
{
  "version": 1,
  "extensions": [
    {
      "id": "openchamber-builtin-kanban",
      "directory": "kanban",
      "files": ["panel/index.html", "panel/style.css"],
      "build": [
        { "entry": "src/panel/main.ts", "out": "panel/main.js", "target": "browser" },
        { "entry": "src/service/main.ts", "out": "service/main.js", "target": "node" }
      ]
    }
  ]
}
```

Regras do build (validadas por `scripts/build-builtin-extensions.mjs`):
- `id` casa `^openchamber-builtin-[a-z][a-z0-9-]*$`; `directory` é relativo e canônico dentro de `packages/extensions/`.
- `package.json` é copiado implicitamente e **não** deve constar em `files`/`build.out` (o build rejeita duplicatas).
- `panel/main.js` (browser) é um **IIFE self-contained**; `service/main.js` (node) é **ESM**.
- CSS/HTML estáticos vão em `files`. Fontes TS ficam fora do bundle de build.
- Build output: `packages/web/server/built-in-extensions/kanban/`.

---

## 6. Decisões de contrato (resolução de ambiguidades)

1. **Toggle:** o campo canônico é **`done: boolean`** (base para T3/T4/T6). O `status` citado informalmente em notas do board **não** é aceito no payload; enviar `status` sem `done` → `400 invalid-payload`.
2. **`GET /api/kanban`** sempre inclui o campo top-level `project` além de `meta`/`tickets`.
3. **Arquivo ausente** é `200` + template vazio (fallback seguro), nunca `404`.
4. **`priority`** usa `media` sem acento; migrações defaultValue = `media`.
5. Escrita é **exclusivamente** via `POST /api/toggle`; nenhuma outra rota escreve.

---

## 7. Referências

- `packages/sdk/GUEST_SERVICES.md` — contrato de guest services, env do processo, proxy loopback, `/health`.
- `packages/sdk/examples/service-echo/` — exemplo de service Node ESM (auth via token, `/health`).
- `packages/web/server/lib/guests/builtins.js` — schema do registry e parse dos built-ins.
- `scripts/build-builtin-extensions.mjs` — schema-fonte do registry e pipeline de build.
- `packages/extensions/DOCUMENTATION.md` / `README.md` — regras de ownership e build.
