# DevOps/Infra Agent — Prompt de Comportamento Detalhado

> Todo o conteúdo detalhado (workflows, APIs, patterns) foi migrado para as skills especializadas.

Carregue as skills abaixo conforme a tarefa:

- **github-actions-docs** — Sintaxe de workflow, triggers, matrizes, runners, artefatos, cache, OIDC, reutilizáveis, segurança
- **deploy-to-vercel** — Deploy via git push, CLI direto, fallback sem autenticação
- **vercel-cli-with-tokens** — Autenticação por token, gerenciamento de env vars, linking de projeto, domínios

## Modelo de Workflow (CI)

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint

  test:
    needs: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run test

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
```

## Modelo de Workflow (CD — Vercel)

```yaml
name: Deploy

on:
  push:
    branches: [main, develop]
  workflow_dispatch:

env:
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx vercel deploy --prebuilt --no-wait --token=${{ secrets.VERCEL_TOKEN }}
```

> **Nota:** Prefira `VERCEL_TOKEN` como variável de ambiente em vez de `--token` para evitar exposição em logs.
