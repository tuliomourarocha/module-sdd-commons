# Testing Patterns

**Analysis Date:** 2026-07-03

## Overview

This project does not contain application test files. Instead, it **prescribes** testing conventions and patterns that AI agents apply when working on target projects. Testing guidance is defined across:

- **Agent definitions:** `agents/unit-tester.agent.md`, `agents/e2e-tester.agent.md`, `agents/api-tester.agent.md`, `agents/qa-engineer.agent.md`
- **Commands:** `commands/qa-prompt.prompt.md`, `commands/backend-prompt.prompt.md`
- **Skills:** `skills/webapp-testing/SKILL.md`, `skills/solid/SKILL.md`, `skills/typescript-expert/SKILL.md`

## Test Framework (prescribed)

**Default:**
- **vitest** — The standard test runner, to be used unless the project has jest configured (`agents/unit-tester.agent.md`)
- Jest detected as fallback only

**Config file:** No test config is present in this repo (it's project-level). The unit-tester agent is configured to run `npm run test` and `npm run test:*`.

**Run Commands** (from agent tool permissions):
```bash
npm run test              # Run all tests
npm run test:api          # Run API tests only
npm run test:e2e          # Run E2E tests only
npx vitest run            # Direct vitest run
npx vitest run --reporter=basic --no-watch  # Minimal output (from skills/typescript-expert/SKILL.md)
npx playwright test       # Playwright test run
```

**Assertion library:** vitest built-in (`expect`, `vi`) — from `commands/backend-prompt.prompt.md`:
```typescript
import { describe, it, expect, vi } from 'vitest'
```

## Test File Organization

### Unit & API Tests

**Pattern (from `agents/unit-tester.agent.md`):**
- Files: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`
- Co-located with source or in `__tests__/` directories
- Directory patterns: `**/__tests__/**`, `**/tests/**`

### E2E Tests

**Pattern (from `agents/e2e-tester.agent.md`):**
- Files: `*.spec.ts`, `*.test.ts`
- Directory: `**/e2e/**`

### QA Structure (from `commands/qa-prompt.prompt.md`):

```
tests/
├── functional/           # Testes funcionais via browser (Playwright)
│   ├── flows/            # Fluxos completos de usuário
│   ├── components/       # Testes de componentes isolados
│   └── fixtures/         # Dados de teste e helpers
│
├── api/                  # Testes de API (contratos)
│   ├── contracts/        # Validação de schemas e contratos
│   ├── endpoints/        # Testes por endpoint
│   └── auth/             # Fluxos de autenticação
│
├── integration/          # Testes integrados front+back
│   ├── flows/            # Fluxos completos integrados
│   └── boundaries/       # Testes de fronteira entre camadas
│
└── shared/               # Compartilhado entre categorias
    ├── setup.ts          # Setup global (browser, server, DB)
    ├── teardown.ts       # Cleanup global
    └── utils.ts          # Helpers e asserts customizados
```

## Test Structure

### Suite Organization (prescribed)

**Pattern from `agents/unit-tester.agent.md`:**
> Um `describe` por arquivo, `it` por cenário — nomes em português ou inglês conforme o código

```typescript
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

**Naming pattern (from `skills/solid/SKILL.md`):**
> Use concrete examples, not abstract statements
- BAD: `'can add numbers'`
- GOOD: `'when adding 2 + 3, returns 5'`

### Setup/Teardown (prescribed)

**From `agents/unit-tester.agent.md`:**
> Dados de teste inline no `it` (evitar `beforeEach` poluído)
> Testes isolados: sem dependência entre si
> Mocks resetados entre testes (`vi.clearAllMocks()` ou `jest.clearAllMocks()`)

## Mocking

**Framework:** vitest (`vi.fn()`, `vi.clearAllMocks()`) — fallback to jest

### What to Mock (prescribed)

**From `agents/unit-tester.agent.md`:**
- **Backend**: Mock at boundary (ports/repositories), not implementations
- **Frontend**: Mock at boundary (API/service calls)
- Use Cases: Mock repositories/ports interfaces
- Entities/Value Objects: Never mock — test pure logic

**From `agents/code-reviewer-backend.agent.md` review checklist:**
> Entities testam sem mock, Use Cases com mock de repository

**Pattern from `commands/backend-prompt.prompt.md`:**

```typescript
// Mock repository interface (not concrete implementation)
const mockRepo: OrderRepository = {
  save: vi.fn(),
  findById: vi.fn(),
  findByCustomerId: vi.fn(),
  delete: vi.fn(),
}
```

### What NOT to Mock (prescribed)

**From `agents/unit-tester.agent.md`:**
> Não mockar o que não pertence ao teste (bibliotecas de UI, Node built-ins)

**Test strategy matrix (from `commands/backend-prompt.prompt.md`):**

| Layer | Test Type | Mock |
|-------|-----------|------|
| Domain/Entities | Unit | None |
| Application/Use Cases | Unit | Repository mock |
| Infrastructure | Integration | Test DB / HTTP mock |
| Presentation/API | Integration/E2E | Test container |

## Fixtures and Factories

**From `commands/qa-prompt.prompt.md`:**
Test data is inline per test case, not centralized in factory files:

```python
# Inline test data
payload = {
    "customerId": "550e8400-e29b-41d4-a716-446655440000",
    "items": [
        {"productId": "prod-123", "quantity": 2, "price": 49.90, "currency": "BRL"}
    ]
}
```

**Fixtures directory:** `tests/functional/fixtures/` and `tests/shared/` for shared test data and helpers (`commands/qa-prompt.prompt.md`).

## Coverage

**From `agents/unit-tester.agent.md`:**
> Cobertura mínima: happy path + 2 edge cases por função/componente

**No formal coverage percentage target** is defined. The coverage requirement is qualitative (happy path + 2 edge cases minimum), not a specific percentage threshold.

## Test Types

### Unit Tests (from `agents/unit-tester.agent.md`)

**Backend scope:**
- **Entities**: Tests without mocks, pure logic, value objects
- **Use Cases**: Tests with mock of repositories/ports, input/output DTO validation
- **Helpers/utils**: Pure functions, pipes, transforms
- **Middleware**: next/done, error handling, auth guards

**Frontend scope:**
- **Components**: Render, user interaction, states (loading, empty, error, edge)
- **Hooks**: Return values, side effects, cleanup
- **Utils**: Formatters, validators, mappers
- **Server Actions**: Return values, validation, error handling

### API Tests (from `agents/api-tester.agent.md`)

**Coverage per endpoint:**
> Testar happy path + mínimo 3 cenários de erro por endpoint

**Checklist:**
- Validate response schema (not just status code)
- Test auth: no token, invalid token, expired token
- Test authorization: user without permission receives 403
- Use `describe`/`it` organized by resource/endpoint
- Test data must be isolated (cleanup after each test)

**Pattern from `commands/qa-prompt.prompt.md`:**

```python
# tests/api/endpoints/test_create_order.py
import requests

BASE_URL = "http://localhost:3000/api"

def test_create_order_success():
    payload = {
        "customerId": "550e8400-e29b-41d4-a716-446655440000",
        "items": [{"productId": "prod-123", "quantity": 2, "price": 49.90, "currency": "BRL"}]
    }
    response = requests.post(f"{BASE_URL}/orders", json=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 201
    data = response.json()
    assert "orderId" in data
    assert data["status"] == "confirmed"
    assert data["total"] == 99.8
    assert data["currency"] == "BRL"

def test_create_order_validation_error():
    payload = {"customerId": "uuid-invalido", "items": []}
    response = requests.post(f"{BASE_URL}/orders", json=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    data = response.json()
    assert "error" in data
    assert "Validation failed" in data["error"]
```

### E2E Tests (from `agents/e2e-tester.agent.md`)

**Principles:**
- Each spec tests a complete flow (not isolated actions)
- Use `data-testid` for selectors — never CSS classes or text
- Page Object Model for organizing selectors and actions
- Tests are independent: each spec prepares its own state
- Screenshots on failure for debugging
- Coverage: happy path + minimum 2 edge cases per flow

### Integration Tests (from `commands/qa-prompt.prompt.md`)

**Pattern:** Combined Playwright + API for testing complete flows:

```python
# tests/integration/flows/test_complete_order_flow.py
from playwright.sync_api import sync_playwright
import requests

BASE_URL = "http://localhost:3000"

def test_complete_purchase_flow():
    # Setup: create test data via API
    api_base = f"{BASE_URL}/api"
    product_response = requests.post(f"{api_base}/products", json={"name": "Produto Teste", "price": 99.90, "currency": "BRL"})
    product_id = product_response.json()["id"]

    user_response = requests.post(f"{api_base}/auth/register", json={"email": "comprador@teste.com", "password": "senha123"})
    token = user_response.json()["token"]

    # Complete flow via browser
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state={"cookies": [{"name": "token", "value": token, "domain": "localhost", "path": "/"}]})
        page = context.new_page()

        page.goto(f"{BASE_URL}/products/{product_id}")
        page.wait_for_load_state("networkidle")
        page.click("[data-testid=add-to-cart]")
        page.wait_for_selector("[data-testid=cart-count]")
        assert page.inner_text("[data-testid=cart-count]") == "1"

        page.click("[data-testid=checkout-button]")
        page.wait_for_url(f"{BASE_URL}/checkout")
        page.click("[data-testid=confirm-order]")
        page.wait_for_selector("[data-testid=order-confirmation]")

        # Verify in backend
        verify_response = requests.get(f"{api_base}/orders/{order_id}", headers={"Authorization": f"Bearer {token}"})
        assert verify_response.status_code == 200
        assert verify_response.json()["status"] == "confirmed"

        browser.close()
```

## Frontend Component Testing (prescribed)

**From `agents/unit-tester.agent.md`:**
> Component tests com `@testing-library/react`, `userEvent` (não `fireEvent`)

**States to cover per component:**
> Componentes testam loading, empty, error e success states

## Web Testing with Playwright (from `skills/webapp-testing/SKILL.md`)

**Framework:** Native Python Playwright scripts

**Helper script:** `scripts/with_server.py` — Manages server lifecycle

**Workflow:**
1. Read help: `python scripts/with_server.py --help`
2. Use server manager + Playwright script
3. Always wait for `networkidle` after navigation
4. Screenshot for inspection when needed

**Pattern:**
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')
    # automation logic
    browser.close()
```

**Best practices:**
- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Type Testing (from `skills/typescript-expert/SKILL.md`)

**Framework:** Vitest type testing (`expectTypeOf`)

**Pattern:**
```typescript
// in avatar.test-d.ts
import { expectTypeOf } from 'vitest'
import type { Avatar } from './avatar'

test('Avatar props are correctly typed', () => {
  expectTypeOf<Avatar>().toHaveProperty('size')
  expectTypeOf<Avatar['size']>().toEqualTypeOf<'sm' | 'md' | 'lg'>()
})
```

**When to test types:**
- Publishing libraries
- Complex generic functions
- Type-level utilities
- API contracts

## Validation Hooks (prescribed)

**From `agents/unit-tester.agent.md` — mandatory pre-commit checks:**
- [ ] Tests compile and pass (`npm run test`)
- [ ] Minimum coverage per file: happy path + 2 edge cases
- [ ] Entities/Value Objects tested without mocks
- [ ] Use Cases with mock of interfaces (not concrete classes)
- [ ] Components test loading, empty, error and success states
- [ ] Tests are isolated: no dependency between them
- [ ] Mocks reset between tests (`vi.clearAllMocks()` or `jest.clearAllMocks()`)

**From `agents/qa-engineer.agent.md` — QA validation:**
- [ ] Every bug has steps to reproduce, screenshot/log, environment and layer label
- [ ] Functional tests cover happy path + minimum 2 edge cases per flow
- [ ] API tests verify status code, body, headers and schemas
- [ ] Integrated front+back tests validate contract between layers
- [ ] Agents notified via `task` for each bug reported

## Agent Validation Flow for Testing

**From `agents/backend-dev.agent.md` and `agents/frontend-dev.agent.md`:**

The orchestration flow for development always includes testing at step 5:

```
1. Discovery → 2. Consult expert → 3. (specialist) → 4. Implement → 
5. Write Unit Tests (unit-tester subagent) → 6. Code Review → 
7. Lint & Type Check → 8. Deploy → 9. Verify (run tests, type check, lint)
```

## Testing Philosophy

**From `skills/solid/SKILL.md`:**
Following TDD (Red-Green-Refactor):
1. **RED** — Write a failing test that describes the behavior
2. **GREEN** — Write the simplest code to make it pass
3. **REFACTOR** — Clean up, remove duplication (Rule of Three)

**The Three Laws of TDD:**
1. Cannot write production code unless it makes a failing test pass
2. Cannot write more test code than is sufficient to fail
3. Cannot write more production code than is sufficient to pass

**F.I.R.S.T. Principles:** Fast, Independent, Repeatable, Self-Validating, Timely

---

*Testing analysis: 2026-07-03*
