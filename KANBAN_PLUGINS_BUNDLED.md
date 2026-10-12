# 📋 Kanban — Acoplamento Nativo dos Plugins Dreams & Ensemble no OpenCode

> **Objetivo:** Embarcar os plugins `@hueyexe/opencode-ensemble` e `opencode-plugin-dreams` diretamente na distribuição própria do OpenCode, garantindo que instalações já venham com multi-agentes e memórias ativas por padrão (*batteries-included*), sem exigir downloads no primeiro boot nem duplicar código-fonte.

---

```
+---------------------------------------------------------------------------------------------------+
|                                          QUADRO KANBAN                                            |
+------------------------------------+--------------------------------+-----------------------------+
|              A FAZER               |          EM PROGRESSO          |          CONCLUÍDO          |
|              (BACKLOG)             |            (DOING)             |           (DONE)            |
+------------------------------------+--------------------------------+-----------------------------+
| [ ] 1. Mapeamento dos Entrypoints  |                                | [x] Definição de Arquitetura|
| [ ] 2. Declaração de Dependências  |                                |     (Dependências NPM vs    |
| [ ] 3. Registro no Plugin Loader   |                                |     Fork Duplicado)         |
| [ ] 4. Injeção de Seeds & Schemas  |                                |                             |
| [ ] 5. Testes E2E de Cold-Start    |                                |                             |
| [ ] 6. Script de Release & Bump    |                                |                             |
+------------------------------------+--------------------------------+-----------------------------+
```

---

## 📌 Coluna 1: A Fazer (Backlog Priorizado)

### card-01: Mapear Entrypoints do Plugin Loader no Core do OpenCode
- **Escopo:** Localizar onde o OpenCode CLI registra os plugins nativos e os do usuário (`src/plugin/index.ts` ou `src/plugin/loader.ts`).
- **Critério de Aceite:** Identificar a função de inicialização onde os plugins built-in podem ser instanciados antes da leitura do `opencode.json` do usuário.

### card-02: Adicionar Plugins ao `package.json` do Core
- **Escopo:** Declarar `@hueyexe/opencode-ensemble` e `opencode-plugin-dreams` nas dependências normais do pacote (`dependencies`).
- **Critério de Aceite:** Versionamento flexível (`^x.y.z`) que permite atualizar com um simples `bun update` sem tocar no código interno dos plugins.

### card-03: Injetar Built-ins no Ciclo de Vida do Runtime
- **Escopo:** Criar o array `BUILT_IN_PLUGINS` no loader do OpenCode:
  ```typescript
  import ensemblePlugin from '@hueyexe/opencode-ensemble';
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
*(Aguardando priorização da Maiteux após a entrega atual de resiliência de transporte).*

---

## 📌 Coluna 3: Concluído (Done)

- [x] **Definição de Estratégia Arquitetural:**
  * **Decisão:** Rejeitada a clonagem/duplicação de código em subpastas (para evitar sincronizações manuais).
  * **Padrão Adotado:** Acoplamento via dependência formal de pacote (*Built-in Plugin via NPM Dependencies*). Os repositórios do Dreams e do Ensemble permanecem 100% autônomos para qualquer usuário externo, e a distribuição própria do OpenCode apenas os empacota compilados no binário final.
