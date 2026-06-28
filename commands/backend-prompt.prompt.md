# Backend Developer — Prompt de Comportamento Detalhado

> Todo o conteúdo detalhado de skills (Clean Architecture, Clean Code, SOLID, TypeScript Expert) é carregado via as skills declaradas no agente.

## Estrutura de Pastas Recomendada

```
src/
├── domain/
│   ├── entities/          # Entidades e Aggregates
│   ├── value-objects/     # Value Objects
│   ├── events/            # Domain Events
│   └── services/          # Domain Services (stateless)
│
├── application/
│   ├── use-cases/         # Use Cases / Interactors
│   ├── ports/             # Interfaces (inbound/outbound)
│   └── dto/               # Input/Output DTOs
│
├── infrastructure/
│   ├── persistence/       # Repository implementations (Prisma, Drizzle, etc.)
│   ├── http/              # HTTP clients, API externas
│   └── messaging/         # Filas, eventos, message broker
│
├── presentation/
│   ├── api/               # API Routes (Next.js route handlers)
│   │   ├── controllers/   # Controller thin layer
│   │   ├── middleware/     # Auth, validation, error handling
│   │   └── validators/    # Input validation (Zod, etc.)
│   └── server-actions/    # Next.js Server Actions
│
├── config/                # DI Container, env vars, app config
│   └── container.ts       # Composition Root
│
└── shared/
    ├── errors/            # Error classes customizadas
    ├── types/             # Tipos compartilhados
    └── utils/             # Funções utilitárias
```

## Templates

### Entity com Value Objects

```typescript
// domain/value-objects/order-id.ts
export class OrderId {
  private constructor(private readonly value: string) {
    if (!value || value.length === 0) {
      throw new Error('OrderId cannot be empty')
    }
  }

  static create(value: string): OrderId {
    return new OrderId(value)
  }

  equals(other: OrderId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

// domain/value-objects/money.ts
export class Money {
  private constructor(
    private readonly amount: number,
    private readonly currency: string,
  ) {
    if (amount < 0) throw new Error('Amount cannot be negative')
  }

  static create(amount: number, currency: string): Money {
    return new Money(amount, currency)
  }

  add(other: Money): Money {
    if (this.currency !== other.currency) {
      throw new Error('Currency mismatch')
    }
    return new Money(this.amount + other.amount, this.currency)
  }

  getAmount(): number { return this.amount }
  getCurrency(): string { return this.currency }
}

// domain/entities/order.ts
import { OrderId } from '../value-objects/order-id'
import { Money } from '../value-objects/money'

interface OrderItem {
  productId: string
  quantity: number
  price: Money
}

type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'

export class Order {
  private constructor(
    private readonly id: OrderId,
    private readonly customerId: string,
    private items: OrderItem[],
    private status: OrderStatus,
    private readonly createdAt: Date,
    private updatedAt: Date,
  ) {}

  static create(id: OrderId, customerId: string, items: OrderItem[]): Order {
    if (items.length === 0) {
      throw new Error('Order must have at least one item')
    }
    return new Order(id, customerId, items, 'pending', new Date(), new Date())
  }

  calculateTotal(): Money {
    return this.items.reduce(
      (acc, item) => acc.add(item.price.multiply(item.quantity)),
      Money.create(0, 'BRL'),
    )
  }

  confirm(): void {
    if (this.status !== 'pending') {
      throw new Error('Only pending orders can be confirmed')
    }
    this.status = 'confirmed'
    this.updatedAt = new Date()
  }

  cancel(): void {
    if (this.status === 'shipped' || this.status === 'delivered') {
      throw new Error('Cannot cancel shipped or delivered orders')
    }
    this.status = 'cancelled'
    this.updatedAt = new Date()
  }

  getId(): OrderId { return this.id }
  getStatus(): OrderStatus { return this.status }
  getItems(): OrderItem[] { return [...this.items] }
}
```

### Repository Port e Implementação

```typescript
// application/ports/order-repository.ts
import { Order } from '@/domain/entities/order'
import { OrderId } from '@/domain/value-objects/order-id'

export interface OrderRepository {
  save(order: Order): Promise<void>
  findById(id: OrderId): Promise<Order | null>
  findByCustomerId(customerId: string): Promise<Order[]>
  delete(id: OrderId): Promise<void>
}

// infrastructure/persistence/prisma-order-repository.ts
import { PrismaClient } from '@prisma/client'
import { Order } from '@/domain/entities/order'
import { OrderId } from '@/domain/value-objects/order-id'
import { OrderRepository } from '@/application/ports/order-repository'

export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(order: Order): Promise<void> {
    const data = this.toPersistence(order)
    await this.prisma.order.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    })
  }

  async findById(id: OrderId): Promise<Order | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: id.toString() },
      include: { items: true },
    })
    return row ? this.toDomain(row) : null
  }

  async findByCustomerId(customerId: string): Promise<Order[]> {
    const rows = await this.prisma.order.findMany({
      where: { customerId },
      include: { items: true },
    })
    return rows.map(row => this.toDomain(row))
  }

  async delete(id: OrderId): Promise<void> {
    await this.prisma.order.delete({ where: { id: id.toString() } })
  }

  private toPersistence(order: Order) {
    return {
      id: order.getId().toString(),
      customerId: '',
      status: order.getStatus(),
      // ...
    }
  }

  private toDomain(row: any): Order {
    return Order.create(
      OrderId.create(row.id),
      row.customerId,
      row.items,
    )
  }
}
```

### Use Case (Interactor)

```typescript
// application/use-cases/create-order.ts
import { Order } from '@/domain/entities/order'
import { OrderId } from '@/domain/value-objects/order-id'
import { Money } from '@/domain/value-objects/money'
import { OrderRepository } from '@/application/ports/order-repository'

export interface CreateOrderRequest {
  customerId: string
  items: Array<{
    productId: string
    quantity: number
    price: number
    currency: string
  }>
}

export interface CreateOrderResponse {
  orderId: string
  total: number
  currency: string
  status: string
}

export class CreateOrderUseCase {
  constructor(private readonly orderRepository: OrderRepository) {}

  async execute(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    const orderId = OrderId.create(crypto.randomUUID())
    const items = request.items.map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      price: Money.create(item.price, item.currency),
    }))

    const order = Order.create(orderId, request.customerId, items)
    order.confirm()

    await this.orderRepository.save(order)

    const total = order.calculateTotal()
    return {
      orderId: orderId.toString(),
      total: total.getAmount(),
      currency: total.getCurrency(),
      status: order.getStatus(),
    }
  }
}
```

### API Route (Controller)

```typescript
// presentation/api/orders/create.route.ts
import { NextRequest, NextResponse } from 'next/server'
import { container } from '@/config/container'
import { CreateOrderRequest } from '@/application/use-cases/create-order'
import { z } from 'zod'

const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
    price: z.number().positive(),
    currency: z.string().length(3),
  })).min(1),
})

export async function POST(request: NextRequest) {
  const body = await request.json()
  const parsed = createOrderSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    )
  }

  const useCase = container.getCreateOrderUseCase()
  const result = await useCase.execute(parsed.data as CreateOrderRequest)

  return NextResponse.json(result, { status: 201 })
}
```

### Composition Root

```typescript
// config/container.ts
import { PrismaClient } from '@prisma/client'
import { PrismaOrderRepository } from '@/infrastructure/persistence/prisma-order-repository'
import { CreateOrderUseCase } from '@/application/use-cases/create-order'

class Container {
  private prisma = new PrismaClient()
  private orderRepository = new PrismaOrderRepository(this.prisma)

  getCreateOrderUseCase(): CreateOrderUseCase {
    return new CreateOrderUseCase(this.orderRepository)
  }
}

export const container = new Container()
```

### Teste de Use Case

```typescript
// tests/application/use-cases/create-order.test.ts
import { describe, it, expect, vi } from 'vitest'
import { CreateOrderUseCase } from '@/application/use-cases/create-order'
import { OrderRepository } from '@/application/ports/order-repository'

describe('CreateOrderUseCase', () => {
  it('creates and confirms an order successfully', async () => {
    const mockRepo: OrderRepository = {
      save: vi.fn(),
      findById: vi.fn(),
      findByCustomerId: vi.fn(),
      delete: vi.fn(),
    }

    const useCase = new CreateOrderUseCase(mockRepo)
    const result = await useCase.execute({
      customerId: '550e8400-e29b-41d4-a716-446655440000',
      items: [{
        productId: 'prod-123',
        quantity: 2,
        price: 49.90,
        currency: 'BRL',
      }],
    })

    expect(result.status).toBe('confirmed')
    expect(result.total).toBe(99.8)
    expect(result.currency).toBe('BRL')
    expect(mockRepo.save).toHaveBeenCalledTimes(1)
  })
})
```

## Code Review Checklist (Backend Clean Architecture)

- [ ] Dependency Rule respeitada? (inner circles não importam outer)
- [ ] Entities sem dependência de framework/ORM?
- [ ] Value Objects usados para conceitos do domínio?
- [ ] Use Cases com DTOs, não objetos de framework?
- [ ] Repository interfaces no inner circle, implementação no adapter?
- [ ] Input validado na borda (API Route / Controller)?
- [ ] SOLID principles aplicados?
- [ ] Testes unitários nos Use Cases com mocks?
- [ ] Testes unitários nas Entities sem mocks?
- [ ] Composição Root centralizada (não DI espalhada)?
- [ ] Erros de domínio são exceções específicas, não genéricas?
- [ ] Nomes seguem a linguagem ubíqua do domínio?

## Test Strategy

| Camada | Tipo de Teste | Mock |
|--------|---------------|------|
| Domain/Entities | Unit | Nenhum |
| Application/Use Cases | Unit | Repository mock |
| Infrastructure | Integration | Test DB / HTTP mock |
| Presentation/API | E2E / Integration | Test container |
