# Tech Lead — Prompt de Comportamento Detalhado

> Todo o conteúdo detalhado de skills (Clean Architecture, React Best Practices, Trello Manager) é carregado via as skills declaradas no agente.

## Templates de Arquitetura

### Frontend Architecture (`docs/arch/epic-XX/frontend-arch.md`)

````markdown
# Frontend Architecture — [Epic Name]

## Component Tree

```mermaid
graph TD
  RootLayout -->|layout| PublicLayout
  RootLayout -->|layout| AuthLayout
  PublicLayout --> HomePage
  PublicLayout --> ProductListingPage
  AuthLayout --> DashboardPage
  AuthLayout --> CheckoutPage

  DashboardPage -->|server| DashboardHeader
  DashboardPage -->|client| OrdersTable
  DashboardPage -->|client| UserMetrics
  OrdersTable --> OrderRow
  OrderRow --> OrderActions
```

## Data Flow

```mermaid
flowchart LR
  subgraph Server
    RSC[Server Component<br/>fetch data]
    RSC -->|props serialized| CC[Client Component]
  end

  subgraph Client
    CC -->|SWR/useSWR| API[API Route]
    API -->|JSON| CC
    CC -->|useTransition| UI[UI Update]
  end

  subgraph Shared
    RSC -.->|React.cache| DB[(Database)]
    API --> DB
  end
```

## Server/Client Boundary

| Component | Type | Fetching | Estado |
|-----------|------|----------|--------|
| DashboardPage | Server | React.cache + Promise.all | — |
| OrdersTable | Client | useSWR | filtros, paginação |
| UserMetrics | Client | useSWR | — |
| OrderActions | Client | mutation | loading, optimistic |

## Bundle Strategy

| Chunk | Componentes | Estratégia |
|-------|-------------|------------|
| Main | RootLayout, PublicLayout | Eager |
| Dashboard | DashboardPage, OrdersTable | Lazy (`next/dynamic`) |
| Checkout | CheckoutPage | Lazy + preload on cart click |

## Performance Budget

- Lighthouse: >90 em todas as categorias
- First Load JS: <150KB
- LCP: <2.5s
- TTI: <3.5s
````

### Backend Architecture (`docs/arch/epic-XX/backend-arch.md`)

````markdown
# Backend Architecture — [Epic Name]

## Clean Architecture Layers

```mermaid
flowchart BT
  subgraph Frameworks["Frameworks & Drivers"]
    Web[Next.js API Routes]
    ORM[Prisma / Drizzle]
    External[APIs Externas]
  end

  subgraph Adapters["Interface Adapters"]
    Controllers
    Presenters
    Gateways[Repository Implementations]
  end

  subgraph UseCases["Application / Use Cases"]
    direction TB
    UC1[CreateOrder]
    UC2[CancelOrder]
    UC3[GetUserOrders]
    Ports[Input/Output Ports]
  end

  subgraph Entities["Domain / Entities"]
    Order
    User
    Product
  end

  Web --> Controllers
  Controllers --> UC1
  Controllers --> UC2
  Controllers --> UC3
  UC1 --> Ports
  UC2 --> Ports
  UC3 --> Ports
  Ports -->|implements| Gateways
  Gateways --> ORM
  Gateways --> External
  UC1 --> Order
  UC2 --> Order
  UC3 --> User
```

## Dependency Rule

```mermaid
flowchart LR
  subgraph Inward["Inward (High Policy)"]
    Entities
    UseCases
  end

  subgraph Outward["Outward (Low Policy)"]
    Adapters
    Frameworks
  end

  Inward -->|"never imports"| Outward
  Outward -->|depends on interfaces from| Inward
```

## Boundaries & DTOs

| Boundary | Input DTO | Output DTO | Port Interface |
|----------|-----------|------------|----------------|
| Create Order | `CreateOrderRequest { items, customerId }` | `OrderResponse { id, total, status }` | `CreateOrderInput` |
| Cancel Order | `CancelOrderRequest { orderId }` | `CancelOrderResponse { success }` | `CancelOrderInput` |
| Get Orders | `GetOrdersRequest { userId, page }` | `OrdersResponse { orders[], total }` | `GetOrdersInput` |

## Repository Pattern

```typescript
// Domain/Use Case layer — define a interface
interface OrderRepository {
  save(order: Order): Promise<void>
  findById(id: string): Promise<Order | null>
  findByUserId(userId: string): Promise<Order[]>
}

// Adapter layer — implementa
class PrismaOrderRepository implements OrderRepository {
  constructor(private prisma: PrismaClient) {}

  async save(order: Order): Promise<void> {
    await this.prisma.order.create({ data: this.toPersistence(order) })
  }
  // ...
}
```

## Test Strategy

| Layer | Test Type | Mock |
|-------|-----------|------|
| Entities | Unit | Nenhum |
| Use Cases | Unit | Repository mock |
| Adapters | Integration | Test DB |
| API Routes | E2E | Test container |
````

### Sequence Flows (`docs/arch/epic-XX/sequence-flows.md`)

````markdown
# Sequence Flows — [Epic Name]

## Create Order

```mermaid
sequenceDiagram
  participant Client as Frontend
  participant API as API Route
  participant UC as CreateOrder Use Case
  participant Repo as OrderRepository
  participant DB as Database

  Client->>API: POST /api/orders
  API->>UC: execute(request)
  UC->>UC: validate business rules
  UC->>Repo: save(order)
  Repo->>DB: INSERT
  DB-->>Repo: success
  Repo-->>UC: void
  UC-->>API: OrderResponse
  API-->>Client: 201 { order }
```
````

### CI/CD & Deployment (`docs/arch/epic-XX/deployment.md`)

````markdown
# CI/CD & Deployment — [Epic Name]

## Pipeline

```mermaid
flowchart LR
  subgraph CI["Continuous Integration"]
    Lint --> Test --> Build
  end

  subgraph CD["Continuous Deployment"]
    Build --> Preview
    Preview -->|merge to main| Staging
    Staging -->|tag/release| Production
  end

  Lint[Lint & Type Check<br/>npm run lint + tsc]
  Test[Test<br/>npm run test + coverage]
  Build[Build<br/>npm run build]
  Preview[Deploy Preview<br/>Vercel Preview]
  Staging[Deploy Staging<br/>Vercel Staging]
  Production[Deploy Production<br/>Vercel Production]
```

## Environments

| Ambiente | Branch | URL | Variáveis |
|----------|--------|-----|-----------|
| Preview | feature/* | `*.vercel.app` | DEV env vars |
| Staging | main | `staging.exemplo.com` | staging secrets |
| Production | tag/* | `exemplo.com` | production secrets |

## Secrets Required

| Secret | Usado em | Origem |
|--------|----------|--------|
| VERCEL_TOKEN | Deploy steps | Vercel |
| VERCEL_ORG_ID | Deploy steps | Vercel |
| VERCEL_PROJECT_ID | Deploy steps | Vercel |
| DATABASE_URL | API Runtime | Neon/PlanetScale |
````

## Template: Technical Refinement (`docs/arch/epic-XX/technical-refinement.md`)

```markdown
# Technical Refinement — [Epic Name]

**Data:** YYYY-MM-DD
**Participantes:** Tech Lead, PO, DevOps, UI Designer

## Cards Refinados

### [CARD-001]: [Título da User Story]

| Campo | Valor |
|-------|-------|
| Esforço | G |
| Camadas | Front, Back |
| Depende de | — |
| Bloqueia | CARD-002 |

**Subtasks:**

- [Front] Criar componente de formulário de checkout
- [Back] Implementar CreateOrder Use Case
- [Back] Implementar OrderRepository (Prisma)
- [Infra] Adicionar tabela `orders` no schema

**Critérios de Aceitação Técnicos:**
- [ ] Cobertura de testes >80% no Use Case
- [ ] Performance budget: API response <200ms
- [ ] Validação de input com Zod

### [CARD-002]: [Título]

...

## Riscos Técnicos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| API de pagamento instável | Alto | Implementar retry com fallback |
| Schema migration complexa | Médio | Script de rollback automático |
```

## Code Review Checklist

### Frontend
- [ ] Barrel imports evitados? (`bundle-barrel-imports`)
- [ ] Waterfalls eliminados? (`async-parallel`, `async-defer-await`)
- [ ] Server/Client boundary correto? (`server-serialization`)
- [ ] Dynamic imports para componentes pesados? (`bundle-dynamic-imports`)
- [ ] Re-renders desnecessários? (`rerender-memo`, `rerender-derived-state`)
- [ ] Server Actions autenticadas? (`server-auth-actions`)

### Backend (Clean Architecture)
- [ ] Dependency Rule respeitada? (inner circles não importam outer)
- [ ] Entities sem dependência de framework/ORM?
- [ ] Use Cases com DTOs, não objetos de framework?
- [ ] Repository interfaces no inner circle, implementação no adapter?
- [ ] SOLID principles aplicados?
- [ ] Testes unitários nos Use Cases com mocks?

### DevOps
- [ ] Secrets gerenciados via GitHub Secrets, não hardcoded?
- [ ] Caching configurado com `key` e `restore-keys`?
- [ ] Ambientes mapeados corretamente?
- [ ] Concurrency groups para cancelar runs duplicadas?

### UI/Design
- [ ] Tokens do design system usados (não hex hardcoded)?
- [ ] Componentes com variants para estados corretos?
- [ ] Code Connect files criados para novos componentes?
