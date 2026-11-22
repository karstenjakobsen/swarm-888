'use client'

import { useState } from 'react'
import { AccessError, post } from '@/lib/operator/source'
import type { components } from '@/lib/operator/api'

export function OwnerLogin({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">Owner sign-in</h1>
      <form className="flex flex-col gap-3" onSubmit={async e => {
        e.preventDefault()
        const form = e.currentTarget
        const key = String(new FormData(form).get('key') ?? '')
        const login: components['schemas']['OwnerLogin'] = { key }
        setBusy(true)
        try {
          await post('/api/session', login)
          form.reset()
          onLogin()
        } catch (err) {
          setError(err instanceof AccessError && err.status === 401 ? 'Invalid owner key.' : 'Operator unavailable.')
        } finally { setBusy(false) }
      }}>
        <label htmlFor="owner-key">Owner key</label>
        <input className="rounded-lg border p-3" id="owner-key" name="key" type="password" autoComplete="current-password" required />
        <button className="rounded-lg bg-primary p-3 text-primary-foreground" disabled={busy}>Sign in</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  )
}
