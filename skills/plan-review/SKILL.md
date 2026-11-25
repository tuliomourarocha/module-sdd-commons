---
name: plan-review
description: >-
  Apresenta o plano (PRD/PLAN, decisões, arquitetura, skills sugeridas) como um
  HTML interativo aberto no Lavish Editor — o usuário revisa, anota elementos,
  clica escolhas e responde pela Conversation panel em vez de interagir via
  terminal. Use no fim do planejamento (planner) e em revisões de decisões que
  precisam de aprovação humana estruturada.
---

# Plan Review — plano como HTML interativo (Lavish)

Substitui a interação por terminal: o macro **gera um HTML do plano**, abre no **Lavish Editor** (`npx -y lavish-axi`) e **faz long-poll** (`lavish-axi poll`) até o usuário enviar feedback (anotações, escolhas clicáveis, mensagens). Cada volta: aplique o feedback, atualize o HTML e re-polle. Ao final, encerre com `lavish-axi end`.

## Regras

- **Arquivo em tmpdir** (`/tmp` ou `$TMPDIR`) — **NUNCA em `.planning/**`** (`permission: deny`). O HTML é descartável; o conteúdo real volta em memória.
- **Um poll por vez, em foreground do macro** — `lavish-axi poll <file>` bloqueia até feedback; sem `nohup`/`&`/detached. Se interrompido, re-rode (feedback fica na fila do server).
- **Respostas curtas** — use `lavish-axi poll <file> --agent-reply "<status>"` para acusar receipt e continuar esperando; `lavish-axi reply <file> --agent-reply "..."` quando for entregar resultado sem continuar o poll.
- `ended` na resposta do poll = usuário clicou **Send & End** — pare de polle e **não reabra sem pedido**.
- `browser_disconnected` — sessão segue resumível; siga o fluxo (feedback pendente será entregue no próximo poll) e, se persistir, informe o usuário.

## Esqueleto do HTML (obrigatório)

Página self-contained (CSS inline, background explícito em `:root` para evitar `self_paint_warning`, sem assets locais fora do arquivo):

```html
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Plano — <feature></title>
<style>:root{color-scheme:light;background:#faf9f6;color:#1a1a1a}
body{margin:0 auto;max-width:960px;padding:2rem;font:16px/1.6 system-ui}</style></head>
<body>
  <h1>Plano — <feature></h1>
  <!-- 1. Resumo/visão (1 parágrafo) -->
  <!-- 2. DECISÕES: card por decisão com alternativas; a recomendada marcada -->
  <!-- 3. SKILLS SUGERIDAS: cards LOCAL vs REMOTE (fonte, installs, link, comando) -->
  <!-- 4. Riscos + pendências -->
</body></html>
```

**Escolhas clicáveis (mecanismo sancionado do Lavish):** opção é control nativo (radio/checkbox/button); clicar só atualiza estado local; um botão **"Queue answer"** por pergunta chama `window.lavish.queuePrompt()` com a resposta formatada — o usuário revisa na Conversation panel e envia. Nunca enfileire de dentro da página sem controle do usuário.

```html
<label><input type="radio" name="d1" value="A"> Alternativa A</label>
<button data-lavish-action onclick="window.lavish?.queuePrompt?.('D1: escolhi A — <justificativa>')">Queue answer</button>
```

## Fluxo do macro

1. **Gere** o HTML (resumo, decisões com alternativas e recomendado, skills sugeridas — locais e `--remote` do find-skills, riscos).
2. **Abra:** `npx -y lavish-axi <arquivo>.html` (imprime URL local `localhost:4387`).
3. **Poll:** `npx -y lavish-axi poll <arquivo>.html` — resposta traz os prompts do usuário (mensagens + anotações com alvo).
4. **Aplique** o feedback (decisões do usuário viram conteúdo do `PLAN.md`/PRD em memória; skills aprovadas são instaladas — somente elas — via `npx skills add` após `find_skill.py --audit <id>`).
5. **Responda + re-polle:** `poll <file> --agent-reply "Aplicado: <resumo>"` — repita 3–4 até o usuário encerrar ou aprovar sem pendências.
6. **Fim:** `npx -y lavish-axi end <arquivo>.html` (se ainda aberto) e **retorne em memória**: decisões aprovadas, skills instaladas/rejeitadas, pendências.
7. Se o usuário pediu mudança no HTML: reescreva o arquivo (Lavish recarrega ao vivo, preservando contexto de revisão) e continue polle.

## Erros comuns

- `LISTENER_ACTIVE` — outro poll rodando: não inicie um segundo; resolva o dono atual.
- `self_paint_warning` — coloque background em `:root`/`body` inline.
- Feedback "não chega" — poll deve ficar no foreground; matou o poll? re-rode o comando.
- Nada aparece no browser — rode `npx -y lavish-axi <file>` de novo (sessão é por caminho do arquivo).
