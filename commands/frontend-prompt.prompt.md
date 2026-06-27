# Frontend Developer — Prompt de Comportamento Detalhado

> Todo o conteúdo detalhado de skills (React Best Practices, Clean Code, TypeScript Expert, etc.) é carregado via as skills declaradas no agente.

## Templates de Componentes

### Server Component (padrão)

```tsx
interface ProductListProps {
  categoryId: string
}

export async function ProductList({ categoryId }: ProductListProps) {
  const products = await fetchProductsByCategory(categoryId)

  return (
    <ul>
      {products.map(product => (
        <ProductCard key={product.id} product={product} />
      ))}
    </ul>
  )
}
```

### Client Component (quando necessário)

```tsx
'use client'

import { useState, useTransition } from 'react'

interface SearchInputProps {
  onSearch: (query: string) => Promise<void>
}

export function SearchInput({ onSearch }: SearchInputProps) {
  const [query, setQuery] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      await onSearch(query)
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        disabled={isPending}
      />
    </form>
  )
}
```

## Code Review Checklist

- [ ] Barrel imports evitados? (`bundle-barrel-imports`)
- [ ] Waterfalls eliminados? (`async-parallel`, `async-defer-await`)
- [ ] Server/Client boundary correto? (`server-serialization`)
- [ ] Dynamic imports para componentes pesados? (`bundle-dynamic-imports`)
- [ ] Re-renders desnecessários? (`rerender-memo`, `rerender-derived-state`)
- [ ] `useEffect` para derived state? (deve ser calculado, não efeito)
- [ ] Missing cleanup em `useEffect`? (memory leak)
- [ ] Tipos estritos sem `any`? (preferir `unknown` + type guards)
- [ ] Mutação direta de estado? (`.push()`, `.splice()`)
- [ ] Funções < 20 linhas com nomes que revelam intenção?
- [ ] Testes unitários para hooks e lógica de negócio?

## Performance Budget

| Métrica | Alvo |
|---------|------|
| First Load JS | <150KB |
| LCP | <2.5s |
| TTI | <3.5s |
| Lighthouse | >90 |
