# Global Rules — module-sdd-commons

Regras globais que se aplicam a todos os agentes neste projeto.

## Estrutura do Projeto

- `agents/` — Definições de agentes (máx. 200 linhas cada, com regras e hooks próprios)
- `commands/` — Prompts detalhados e templates referenciados pelos agentes
- `skills/` — Habilidades carregadas pelos agentes
- `packs/` — Configurações de empacotamento APM

## Regras Gerais

1. **Progressive Disclosure** — Arquivos de agente são concisos e autossuficientes. Comportamento detalhado fica em `commands/`.
2. **Autossuficiência** — Cada agente incorpora suas próprias regras e hooks de validação. Não busca regras em arquivos externos.
3. **Idioma** — Padrão português para artefatos, salvo contexto do produto exigir inglês.
4. **Qualidade** — Prefira artefatos concisos, prontos para uso e validados contra os hooks do agente.
5. **Validação** — Execute hooks de validação antes de finalizar cada artefato.