# Cloud Orchestrator Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side Cloud Orchestrator Hub to manage multi-tenant workspaces and billing, utilizing Supabase Auth and Edge Functions for a zero-server footprint.

**Architecture:** This is a Static Site Generation (SSG) frontend. It uses Supabase client-side API for authentication and database querying with RLS. Privileged actions (like Stripe checkouts) are offloaded to Supabase Edge Functions. Cross-domain sessions are enabled by configuring the cookie domain.

**Tech Stack:** Next.js (Static Export), React, @supabase/supabase-js, Vitest, React Testing Library.

---

### Task 1: Setup Dependencies and Test Environment

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: Install required packages**
```bash
pnpm add @supabase/supabase-js
pnpm add -D vitest @testing-library/react @testing-library/dom jsdom @testing-library/jest-dom
```
Expected: Packages installed successfully.

- [ ] **Step 2: Write vitest configuration**
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
```

- [ ] **Step 3: Write test setup file**
```typescript
// tests/setup.ts
import '@testing-library/jest-dom'
```

- [ ] **Step 4: Commit**
```bash
git add package.json pnpm-lock.yaml vitest.config.ts tests/setup.ts
git commit -m "chore: setup supabase and vitest"
```

### Task 2: Supabase Client Configuration

**Files:**
- Create: `tests/lib/supabase/client.test.ts`
- Create: `src/lib/supabase/client.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/lib/supabase/client.test.ts
import { describe, it, expect } from 'vitest'
import { supabase } from '../../../src/lib/supabase/client'

describe('Supabase Client', () => {
  it('should be initialized', () => {
    expect(supabase).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm exec vitest run tests/lib/supabase/client.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**
```typescript
// src/lib/supabase/client.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321'
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-key'

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    // Cross-domain cookie configuration
    cookieOptions: {
      domain: '.worldwideview.dev',
      path: '/',
      sameSite: 'lax',
      secure: true,
    }
  }
})
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm exec vitest run tests/lib/supabase/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/lib/supabase/client.test.ts src/lib/supabase/client.ts
git commit -m "feat: configure supabase client with cross-domain auth"
```

### Task 3: Login Page

**Files:**
- Create: `tests/app/login.test.tsx`
- Create: `src/app/login/page.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// tests/app/login.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import LoginPage from '../../src/app/login/page'

describe('Login Page', () => {
  it('renders login heading', () => {
    render(<LoginPage />)
    expect(screen.getByRole('heading', { name: /login/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm exec vitest run tests/app/login.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**
```tsx
// src/app/login/page.tsx
'use client'

import React, { useState } from 'react'
import { supabase } from '../../lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    await supabase.auth.signInWithOtp({ email })
    alert('Check your email for the login link!')
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Login</h1>
      <form onSubmit={handleLogin}>
        <input 
          type="email" 
          placeholder="Email address" 
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required 
        />
        <button type="submit">Send Magic Link</button>
      </form>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm exec vitest run tests/app/login.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/app/login.test.tsx src/app/login/page.tsx
git commit -m "feat: add login page with supabase auth"
```

### Task 4: Hub Layout (Protected Route)

**Files:**
- Create: `tests/app/hub/layout.test.tsx`
- Create: `src/app/hub/layout.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// tests/app/hub/layout.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import HubLayout from '../../../src/app/hub/layout'

// Mock useRouter
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() })
}))

describe('Hub Layout', () => {
  it('renders children', () => {
    render(<HubLayout><div>Hub Content</div></HubLayout>)
    expect(screen.getByText('Hub Content')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm exec vitest run tests/app/hub/layout.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**
```tsx
// src/app/hub/layout.tsx
'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase/client'

export default function HubLayout({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        router.push('/login')
      } else {
        setLoading(false)
      }
    }
    checkSession()
  }, [router])

  if (loading) return <div>Loading Hub...</div>

  return (
    <div>
      <nav style={{ padding: '1rem', background: '#eee' }}>
        <h2>Cloud Orchestrator Hub</h2>
      </nav>
      <main>{children}</main>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm exec vitest run tests/app/hub/layout.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/app/hub/layout.test.tsx src/app/hub/layout.tsx
git commit -m "feat: add protected hub layout"
```

### Task 5: Workspace Dashboard

**Files:**
- Create: `tests/app/hub/page.test.tsx`
- Create: `src/app/hub/page.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// tests/app/hub/page.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import HubDashboard from '../../../src/app/hub/page'

describe('Hub Dashboard', () => {
  it('renders dashboard heading', () => {
    render(<HubDashboard />)
    expect(screen.getByRole('heading', { name: /workspaces/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm exec vitest run tests/app/hub/page.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**
```tsx
// src/app/hub/page.tsx
'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase/client'

interface Tenant {
  id: string
  name: string
  slug: string
  tier: string
}

export default function HubDashboard() {
  const [tenants, setTenants] = useState<Tenant[]>([])

  useEffect(() => {
    const fetchTenants = async () => {
      const { data } = await supabase.from('Tenant').select('*')
      if (data) setTenants(data)
    }
    fetchTenants()
  }, [])

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Your Workspaces</h1>
      <ul>
        {tenants.map(tenant => (
          <li key={tenant.id}>
            {tenant.name} - <a href={`https://${tenant.slug}.app.worldwideview.dev`}>Launch</a>
          </li>
        ))}
      </ul>
      <button onClick={() => alert('Provisioning to be implemented')}>Create Workspace</button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm exec vitest run tests/app/hub/page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/app/hub/page.test.tsx src/app/hub/page.tsx
git commit -m "feat: add workspace dashboard"
```

### Task 6: Billing Panel

**Files:**
- Create: `tests/app/hub/billing/page.test.tsx`
- Create: `src/app/hub/billing/page.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// tests/app/hub/billing/page.test.tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import BillingPage from '../../../../src/app/hub/billing/page'

describe('Billing Page', () => {
  it('renders billing heading', () => {
    render(<BillingPage />)
    expect(screen.getByRole('heading', { name: /billing/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm exec vitest run tests/app/hub/billing/page.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**
```tsx
// src/app/hub/billing/page.tsx
'use client'

import React from 'react'
import { supabase } from '../../../lib/supabase/client'

export default function BillingPage() {
  const handleUpgrade = async (tier: string) => {
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: { tier, tenantId: 'placeholder-tenant-id' }
    })
    
    if (data?.url) {
      window.location.href = data.url
    } else {
      console.error('Failed to create checkout session', error)
    }
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Billing</h1>
      <div>
        <h3>Pro Tier</h3>
        <button onClick={() => handleUpgrade('pro')}>Upgrade to Pro</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm exec vitest run tests/app/hub/billing/page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add tests/app/hub/billing/page.test.tsx src/app/hub/billing/page.tsx
git commit -m "feat: add billing panel with checkout integration"
```

### Task 7: Supabase Edge Function for Stripe

**Files:**
- Create: `supabase/functions/create-checkout-session/index.ts`

- [ ] **Step 1: Write the edge function implementation**
```typescript
// supabase/functions/create-checkout-session/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
// Note: In a real environment, you'd import stripe from esm.sh
// import Stripe from 'https://esm.sh/stripe@11.1.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { tier, tenantId } = await req.json()
    
    // Placeholder for actual Stripe integration
    // const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', { apiVersion: '2022-11-15' })
    // const session = await stripe.checkout.sessions.create({ ... })

    return new Response(
      JSON.stringify({ url: `https://stripe.com/checkout/mock?tier=${tier}&tenant=${tenantId}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
```

- [ ] **Step 2: Commit**
```bash
git add supabase/functions/create-checkout-session/index.ts
git commit -m "feat: add edge function for stripe checkout sessions"
```
