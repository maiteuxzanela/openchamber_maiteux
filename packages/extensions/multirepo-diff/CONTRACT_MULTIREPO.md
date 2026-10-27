# CONTRACT_MULTIREPO.md — TICKET-HARNESS-40

> **Extensão:** `openchamber-builtin-multirepo-diff` (diretório `packages/extensions/multirepo-diff`)
> **Workspace:** `/mnt/94CCB337CCB3130A/openchamber_maiteux`
> **Fronteira:** fundação + guest service (Tales) → painel UI/UX (Cris). Este documento é a
> fonte de verdade do wire contract; os tipos canônicos vivem em
> [`src/service/contract.ts`](src/service/contract.ts) e são importáveis pelo painel.

---

## 1. Visão geral

A extensão lê o **ledger do Ensemble** (quais arquivos cada sala tocou) e cruza com o
**estado real do git** de cada repositório, entregando uma árvore hierárquica
**Sala → Repositório → Arquivo** com diffs e reversão em 1 clique.

```
SQLite (team / team_modified_file)
        │  read-only
        ▼
src/service/ledger.ts ──► main.ts (HTTP 127.0.0.1) ──► host proxy ──► iframe (panel)
        ▲                        │
        │                        ▼
   src/service/git.ts (status, numstat, patch, revert)
```

O iframe **nunca** toca o filesystem e **nunca** recebe porta/token: usa
`host.serviceRequest({ method, path, query, body })` exatamente como o Kanban
(CONTRACT_KANBAN §2).

### 1.1 Banco de dados (resolução por capacidade)

O brief aponta `~/.local/share/opencode/opencode.db`, mas as tabelas `team` /
`team_member` / `team_modified_file` pertencem ao banco do plugin Ensemble
(`~/.config/opencode/ensemble.db`, cf. `ensemble-room-lowcost/src/db.ts:getDbPath`).
O service resolve o caminho por capacidade, na ordem:

1. `OPENCHAMBER_MULTIREPO_DB` (override absoluto, vence sempre);
2. `$XDG_CONFIG_HOME/opencode/ensemble.db` (default `~/.config/opencode/ensemble.db`);
3. `$XDG_DATA_HOME/opencode/ensemble.db`;
4. `$XDG_DATA_HOME/opencode/opencode.db`.

O primeiro candidato existente **que exponha `team` e `team_modified_file`** vence.
Nenhum banco elegível → `503 database-unavailable` (o painel deve exibir estado de
erro, nunca inventar dados). O banco é aberto **read-only** e fechado em `finally`.

O campo `database` de `GET /api/multirepo/rooms` informa qual arquivo foi usado
(útil para diagnóstico/telemetria no painel).

### 1.2 Escopo por sala

Só entram na árvore os caminhos registrados em `team_modified_file` para aquela sala.
Caminhos que não pertencem a nenhum repositório git viram entradas em
`room.errors` (máximo 20; o excedente é resumido), sem derrubar a listagem.

---

## 2. Contrato HTTP

- Processo Node ESM (`service/main.ts` → `service/main.js`), escuta **somente** em
  `127.0.0.1:${OPENCHAMBER_SERVICE_PORT}`.
- Toda requisição exige `Authorization: Bearer ${OPENCHAMBER_SERVICE_TOKEN}` →
  ausente/errado: `401 { "error": { "code": "unauthorized", ... } }`.
- `GET /health` → `200 { "ok": true }` (readiness do host, polling até 15s).
- Erros sempre no shape `{ "error": { "code": string, "message": string } }`.
- Respostas são `Cache-Control: no-store`.

### 2.1 `GET /api/multirepo/rooms`

**Query:** `status` = `active` (default) | `archived` | `all`; `refresh=1` ignora o cache
de 2s (use após operações que mudam o disco).

**Resposta `200`:**

```jsonc
{
  "rooms": [
    {
      "id": "team_mvfnl62b_0002_yvzwww",
      "name": "multirepo-diff",
      "status": "active",                 // "active" | "archived"
      "leadAgent": "dante",               // string | null
      "leadSessionId": "ses_abc123",      // sessão líder; null quando o ledger não registra
      "createdAt": "2026-10-19T13:11:00.000Z",
      "updatedAt": "2026-10-19T16:20:00.000Z",
      "memberCount": 4,
      "worktrees": [                       // TICKET-HARNESS-76: team_member.worktree_dir, ordenado por path
        {
          "path": "/mnt/.../openchamber_maiteux-worktrees/feat",
          "branch": "feat/context-rank",   // null quando não registrado
          "member": "cris",
          "sessionId": "ses_member123"     // team_member.session_id; null quando ausente
        }
      ],
      "repos": [
        {
          "root": "/mnt/94CCB337CCB3130A/openchamber_maiteux",  // git rev-parse --show-toplevel
          "name": "openchamber_maiteux",                       // basename do root
          "branch": "main",                                    // null se detached/unborn
          "head": "d86dda273...",                              // null se sem commits
          "dirty": true,
          "truncatedFiles": 0,                                 // >0 se o repo excedeu o teto de 5 000 arquivos
          "error": null,                                       // string quando o git falha
          "counts": {
            "files": 6, "added": 0, "modified": 2, "deleted": 1,
            "renamed": 1, "untracked": 1, "clean": 1
          },
          "files": [
            {
              "path": "src/service/main.ts",       // SEMPRE relativo ao root, separador "/"
              "absolutePath": "/mnt/.../src/service/main.ts",
              "status": "modified",                // added|modified|deleted|renamed|copied|untracked|unmerged|clean
              "code": " M",                        // código porcelain cru ("??" p/ untracked) | null se clean
              "staged": false,                     // índice sujo (X do porcelain)
              "unstaged": true,                    // working tree sujo (Y do porcelain; untracked = true)
              "additions": 12,                     // inteiro vs HEAD; null se binário
              "deletions": 3,                      // inteiro vs HEAD; null se binário
              "binary": false,
              "previousPath": null                 // caminho de origem quando status=renamed|copied
            }
          ]
        }
      ],
      "totals": { "repos": 1, "files": 6, "dirtyFiles": 5 },
      "errors": [{ "path": "/tmp/.../loose.txt", "reason": "not-a-git-repository" }]
    }
  ],
  "generatedAt": "2026-10-19T16:35:00.000Z",
  "database": "/home/maiteuxzanela/.config/opencode/ensemble.db"
}
```

Regras:

- `repos` ordenado por `name`; `files` ordenado por `path`.
- `files` inclui também entradas `clean` (o ledger lembra do arquivo, mas ele já foi
  revertido/commitado) — o painel deve exibi-las desabilitadas.
- `counts.clean` conta as entradas `clean`; `dirty = counts.files - counts.clean > 0`.
- Sala sem arquivos no ledger → `repos: []`, `totals` zerados (não é erro).
- Repositório com falha de git → `error: "cannot read git status: ..."`, `files: []`,
  `dirty: false`; as demais salas/repos continuam sendo servidas.

**Erros:** `400 invalid-status`; `503 database-unavailable`.

### 2.2 `GET /api/multirepo/diff`

**Query:**

| Parâmetro | Obrigatório | Default | Regra |
|---|---|---|---|
| `room` | sim | — | id da sala (`team.id`) |
| `repo` | sim | — | root absoluto **que pertença à sala** |
| `file` | sim | — | relativo ao root **ou** absoluto dentro do root |
| `view` | não | `combined` | `combined` (vs HEAD: staged+unstaged) \| `staged` \| `worktree` |
| `context` | não | `3` | inteiro 0–50 (linhas de contexto) |

**Resposta `200`** (arquivo modificado):

```jsonc
{
  "room": "team_mvfnl62b_0002_yvzwww",
  "repo": "/mnt/94CCB337CCB3130A/openchamber_maiteux",
  "file": "src/service/main.ts",
  "status": "modified",
  "view": "combined",
  "staged": false,
  "unstaged": true,
  "additions": 12,
  "deletions": 3,
  "binary": false,
  "truncated": false,
  "language": "typescript",              // hint p/ highlighter: typescript|javascript|json|markdown|css|html|python|bash|yaml|text|...
  "hunks": [
    {
      "header": "@@ -10,6 +10,8 @@",
      "oldStart": 10, "oldLines": 6, "newStart": 10, "newLines": 8,
      "lines": [
        { "type": "context", "text": "const a = 1;", "oldNumber": 10, "newNumber": 10 },
        { "type": "del",     "text": "const b = 2;", "oldNumber": 11, "newNumber": null },
        { "type": "add",     "text": "const b = 3;", "oldNumber": null, "newNumber": 11 },
        { "type": "meta",    "text": "\\ No newline at end of file", "oldNumber": null, "newNumber": null }
      ]
    }
  ],
  "patch": "diff --git a/src/service/main.ts b/src/service/main.ts\n..."
}
```

Casos especiais:

- `status: "untracked"` → patch sintético `new file mode` com todas as linhas `+`
  (git não gera diff para untracked); `deletions: 0`.
- `status: "clean"` → `patch: ""`, `hunks: []`, `additions/deletions: 0`.
- `binary: true` → `patch: ""`, `hunks: []`, `additions/deletions: null`.
- `truncated: true` → patch cortado em ≤512 KiB / ≤20 000 linhas (o painel deve
  avisar "diff truncado").
- `meta` só aparece em marcadores `\ No newline at end of file` (não é conteúdo).

**Erros:**

| Situação | HTTP | `code` |
|---|---|---|
| `room`/`repo`/`file` ausente | 400 | `missing-room` / `missing-repo` / `missing-file` |
| `view`/`context` inválido | 400 | `invalid-view` / `invalid-context` |
| sala inexistente | 404 | `unknown-room` |
| repo fora dos repositórios da sala | 404 | `repo-not-in-room` |
| caminho escapa do root (inclui symlink) | 403 | `path-outside-repo` |
| arquivo/alvo inexistente | 404 | `file-not-found` |
| panne de git na leitura | 500 | `git-error` |

### 2.3 `POST /api/multirepo/revert`

Reversão **atômica por arquivo** (unstage + restore/delete + verificação), serializada
por repositório por um lock em memória (sem concorrência entre requisições).

**Corpo:**

```jsonc
// escopo arquivo
{ "room": "team_...", "repo": "/mnt/.../openchamber_maiteux", "file": "src/service/main.ts" }
// escopo repositório (todos os arquivos daquela sala naquele repo)
{ "room": "team_...", "scope": "repo", "repo": "/mnt/.../openchamber_maiteux" }
// escopo sala (todos os repositórios da sala)
{ "room": "team_...", "scope": "room" }
```

- `scope` é opcional e inferido: `file` se `file` vier, senão `repo` se `repo` vier,
  senão `room`.
- `file` no escopo `file` pode ser absoluto (precisa constar no ledger da sala) **ou**
  relativo ao `repo` informado.
- **Só arquivos do ledger da sala** são elegíveis; arquivos sujos alheios no mesmo
  repositório nunca são tocados.
- Arquivos `clean` são reportados em `skipped` com `reason: "already-clean"` (idempotente).

**Resposta `200`:**

```jsonc
{
  "ok": true,
  "room": "team_mvfnl62b_0002_yvzwww",
  "scope": "repo",
  "reverted": [
    { "repo": "/mnt/.../openchamber_maiteux", "path": "src/service/main.ts", "status": "modified", "action": "restored" },
    { "repo": "/mnt/.../openchamber_maiteux", "path": "sub/novo.md",        "status": "untracked", "action": "deleted" }
  ],
  "skipped": [
    { "repo": "/mnt/.../openchamber_maiteux", "path": "sub/mod.ts", "reason": "already-clean" }
  ],
  "counts": { "reverted": 2, "skipped": 1 }
}
```

`action`: `restored` (arquivo voltou ao conteúdo de HEAD) | `deleted` (só existia como
adição/untracked) | `unchanged` (nada a fazer). `status` é o estado **anterior** à
reversão (para telemetria/UI).

Algoritmo por arquivo (garantia de limpeza verificada com `git status --porcelain` ao final):

1. `git reset HEAD -- <path>` (ou `git rm --cached` quando o repo não tem HEAD);
2. se o caminho existe em HEAD → `git restore --source=HEAD --worktree -- <path>`;
   senão → remove o arquivo do disco;
3. rename (`previousPath`) é revertido em par (novo caminho + origem);
4. `git status` do caminho precisa voltar vazio; caso contrário o item vai para
   `skipped` com a mensagem real (nunca reporta sucesso falso).

**Erros:** `400 invalid-payload` (JSON/campo inválido), `404 unknown-room`,
`404 unknown-repo`, `404 file-not-in-room`, `403 path-outside-repo`,
`409 nothing-to-revert` (sala sem ledger ou nenhum alvo casando o escopo).

---

## 3. Integração do painel (Cris)

- Importe os tipos de `src/service/contract.ts` (mesmo bundle TypeScript; o build do
  host empacota só o painel, tipos são apagados).
- Nada de `fetch` direto: `host.serviceRequest({ method: 'GET', path: '/api/multirepo/rooms', query: 'status=active' })`.
  Para o POST: `{ method: 'POST', path: '/api/multirepo/revert', body: JSON.stringify(payload) }`.
- Hierarquia sugerida: sala (accordion) → repo (`name`, `branch`, `counts`) → arquivo
  (`path`, badge `status`, `+additions/-deletions`).
- Após `revert` bem-sucedido: refazer `rooms?refresh=1` (e recarregar o diff aberto).
- `truncated`, `binary`, `status: clean` e `repo.error` precisam de estados visuais
  próprios; `room.errors` deve aparecer como aviso não bloqueante.
- Confirmação de reversão em modal (ação destrutiva): exibir os `counts` previstos e
  usar `scope` explícito no payload.

## 4. Build

`packages/extensions/registry.json` já contém:

```jsonc
{
  "id": "openchamber-builtin-multirepo-diff",
  "directory": "multirepo-diff",
  "files": ["panel/index.html", "panel/style.css"],
  "build": [
    { "entry": "src/panel/main.ts", "out": "panel/main.js",    "target": "browser" },
    { "entry": "src/service/main.ts", "out": "service/main.js", "target": "node" }
  ]
}
```

O build (`bun run extensions:build`) só passa quando `panel/index.html`,
`panel/style.css` e `src/panel/main.ts` existirem. Saída:
`packages/web/server/built-in-extensions/multirepo-diff/`.

## 5. Testes determinísticos (Hugo)

O backend foi validado contra git e SQLite reais (sem mocks) em:
rooms/counts/erros, diff untracked/modificado/rename, guards (traversal, repo fora da
sala, sala desconhecida), revert arquivo/repo/sala, idempotência (`already-clean`),
árvore limpa após reversão, `SIGTERM` com exit 0 e **zero processos órfãos**.
A suíte determinística versionada deve espelhar esses cenários em `tests/`.
