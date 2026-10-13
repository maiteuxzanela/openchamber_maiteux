# 📋 Kanban — Acoplamento Nativo dos Plugins Dreams & Ensemble no OpenCode

> **Objetivo:** Embarcar os plugins `@maiteuxzanela/ensemble-room-lowcost` (versão própria customizada: https://github.com/maiteuxzanela/ensemble-room-lowcost) e `opencode-plugin-dreams` diretamente na distribuição própria do OpenCode, garantindo que instalações já venham com multi-agentes e memórias ativas por padrão (*batteries-included*), sem exigir downloads no primeiro boot nem duplicar código-fonte.

---

```
+---------------------------------------------------------------------------------------------------+
|                                          QUADRO KANBAN                                            |
+------------------------------------+--------------------------------+-----------------------------+
|              A FAZER               |          EM PROGRESSO          |          CONCLUÍDO          |
|              (BACKLOG)             |            (DOING)             |           (DONE)            |
+------------------------------------+--------------------------------+-----------------------------+
|                                    |                                | [x] Definição de Arquitetura|
|                                    |                                | [x] 1. Mapeamento Loader    |
|                                    |                                | [x] 2. Declaração Deps      |
|                                    |                                | [x] 3. Injeção Built-ins    |
|                                    |                                | [x] 4. Schemas Zero-Config  |
|                                    |                                | [x] 5. Testes Cold-Start    |
|                                    |                                | [x] 6. Script Sync & Bump   |
+------------------------------------+--------------------------------+-----------------------------+
```

---

## 📌 Coluna 1: A Fazer (Backlog Priorizado)

### card-01: Mapear Entrypoints do Plugin Loader no Core do OpenCode
- **Escopo:** Localizar onde o OpenCode CLI registra os plugins nativos e os do usuário (`src/plugin/index.ts` ou `src/plugin/loader.ts`).
- **Critério de Aceite:** Identificar a função de inicialização onde os plugins built-in podem ser instanciados antes da leitura do `opencode.json` do usuário.

### card-02: Adicionar Plugins ao `package.json` do Core
- **Escopo:** Declarar `@maiteuxzanela/ensemble-room-lowcost` (`github:maiteuxzanela/ensemble-room-lowcost`) e `opencode-plugin-dreams` nas dependências normais do pacote (`dependencies`).
- **Critério de Aceite:** Versionamento flexível (`^x.y.z` ou tracking de tag/commit do github) que permite atualizar com um simples `bun update` sem tocar no código interno dos plugins.

### card-03: Injetar Built-ins no Ciclo de Vida do Runtime
- **Escopo:** Criar o array `BUILT_IN_PLUGINS` no loader do OpenCode:
  ```typescript
  import ensemblePlugin from '@maiteuxzanela/ensemble-room-lowcost';
  import dreamsPlugin from 'opencode-plugin-dreams';

  export const BUILT_IN_PLUGINS = [
    ensemblePlugin,
    dreamsPlugin,
  ];
  ```
- **Critério de Aceite:** O runtime deve inicializar as tools `team_*` e `dream_*` mesmo quando o arquivo `~/.config/opencode/opencode.json` estiver vazio ou inexistente.

### card-04: Provisionar Configurações e Schemas Padrão (Fallback Seguro)
- **Escopo:** Assegurar que valores padrão (como portas de dashboard, modelos preferenciais e diretórios de banco do dreams) sejam assumidos de forma transparente caso o usuário não tenha configurado nada.
- **Critério de Aceite:** O sistema deve funcionar em modo *zero-config* imediato.

### card-05: Testes de Cold Start sem Conexão (Modo Offline)
- **Escopo:** Validar a inicialização do binário compilado em um ambiente limpo (sem pasta `~/.config/opencode/node_modules/` e sem internet).
- **Critério de Aceite:** O OpenCode deve subir com Ensemble e Dreams operacionais, sem disparar chamadas ao registro do npm nem falhar com `EACCES`.

### card-06: Pipeline Automatizado de Release e Sincronização
- **Escopo:** Criar um script `scripts/sync-plugins.sh` ou ação no CI que verifica se há versões mais recentes do Ensemble e Dreams no npm e atualiza as dependências do OpenCode automaticamente.
- **Critério de Aceite:** Atualizações nos plugins chegam ao OpenCode em um único comando de build.

---

## 📌 Coluna 2: Em Progresso (Doing)
*(Todas as tarefas ativas foram concluídas pelo time).*

---

## 📌 Coluna 3: Concluído (Done)

- [x] **Definição de Estratégia Arquitetural:**
  * **Decisão:** Rejeitada a clonagem/duplicação de código em subpastas (para evitar sincronizações manuais).
  * **Padrão Adotado:** Acoplamento via dependência formal de pacote (*Built-in Plugin via NPM Dependencies*). Os repositórios do Dreams e do Ensemble permanecem 100% autônomos para qualquer usuário externo, e a distribuição própria do OpenCode apenas os empacota compilados no binário final.

- [x] **Card 01 — Mapeamento dos Entrypoints do Plugin Loader no Core:**
  * **Módulo de Registro Built-in:** [`packages/core/src/plugin/internal.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/internal.ts)
  * **Ciclo de Vida e Supervisão:** [`packages/core/src/plugin/supervisor.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/supervisor.ts)
  * **Interface de Adaptação:** [`packages/core/src/plugin/module.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/module.ts)

- [x] **Card 02 — Adicionar Plugins ao `package.json` do Core:**
  * Registrados em `packages/core/package.json` sob `"dependencies"`:
    - `"@maiteuxzanela/ensemble-room-lowcost": "github:maiteuxzanela/ensemble-room-lowcost#486d2fc"`
    - `"opencode-plugin-dreams": "github:maiteuxzanela/chamber_dream#0529d49"`
  * Resolução e lockfile persistidos via `bun install --ignore-scripts` gerando o `bun.lock`.

- [x] **Card 03 — Injetar Built-ins no Ciclo de Vida do Runtime (`internal.ts`):**
  * Criados adapters modulares em `packages/core/src/plugin/builtin/ensemble.ts` e `packages/core/src/plugin/builtin/dreams.ts`.
  * Padrão com importação dinâmica widened string (`PACKAGE: string`) sob `Effect.promise` e `PluginPromise.fromPromise`, blindando o compilador contra invasão de escopo estrito de tipos e capturando erros sob `Effect.exit`.
  * Integrados na lista `post` de `packages/core/src/plugin/internal.ts`, permitindo que configurações explícitas do usuário em `opencode.json` continuem tendo precedência (pre → user packages → post).

- [x] **Card 04 — Provisionar Fallbacks e Schemas de Zero-Config:**
  * Adapters tratam graceful degradation: se o host do plugin falhar por ausência de diretório ou schema não provisionado, a falha é reportada como defeito de ativação (`Effect.die` capturado) sem derrubar o boot do OpenCode CLI.
  * Validações de integridade e ausência de arquivo de configuração cobertas pela suíte `packages/core/test/builtin-zero-config.test.ts`.

- [x] **Card 05 — Testes E2E de Cold-Start em Modo Offline (Quality Gate Clara):**
  * Suíte real anti-mock em `packages/core/test/builtin-cold-start-offline.test.ts` e `test/builtin-zero-config.test.ts`.
  * 11 testes reais executados e aprovados (126 asserções em 1.1s).
  * Validado isolamento sem rede, sem dependência de registry npm externo e com banco SQLite efêmero.

- [x] **Card 06 — Script de Sincronização e Bump Automatizado (`scripts/sync-plugins.sh`):**
  * Script automatizado com `chmod +x` e symlink `script/sync-plugins.sh`.
  * Suporte a `--dry-run`, `--check` (modo auditoria/CI), `--ensemble <ref>` e `--dreams <ref>`.
  * Fluxo integrado: inspeciona upstream remoto via `git ls-remote`, atualiza `packages/core/package.json`, atualiza `bun.lock` e roda testes de validação determinísticos.
