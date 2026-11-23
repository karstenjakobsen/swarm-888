'use client'

import { useEffect, useState } from 'react'
import type { components } from '@/lib/operator/api'
import { connectCatalog, readCatalogStatus, runCatalogAction } from '@/lib/operator/source'
import { useOperator } from './store'

type CatalogStatus = components['schemas']['CatalogStatus']
const button = 'rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium disabled:opacity-50'
const primary = 'rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'
const input = 'rounded-lg border border-input bg-background px-3 py-2 text-base'

export function CatalogTab() {
  const { mode, setCatalog } = useOperator()
  const [status, setStatus] = useState<CatalogStatus>()
  const [remote, setRemote] = useState('')
  const [branch, setBranch] = useState('main')
  const [deployKey, setDeployKey] = useState(false)
  const [seed, setSeed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (mode !== 'live') return
    const abort = new AbortController()
    void readCatalogStatus(abort.signal).then(setStatus, (e) => {
      if (!abort.signal.aborted) setError(e.message)
    })
    return () => abort.abort()
  }, [mode])

  async function perform(action: () => Promise<CatalogStatus>) {
    setBusy(true)
    setError('')
    try {
      const next = await action()
      setStatus(next)
      setCatalog(next.catalog ?? undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Catalog request failed.')
    } finally {
      setBusy(false)
    }
  }

  const catalog = status?.catalog
  const publish = status?.publish_error ? 'Publish failed' : status?.published_revision ? 'Publish verified' : 'Publish unverified'
  const read = status?.read_error ? 'Read check failed' : status?.remote_revision ? 'Read verified' : 'Read unverified'

  return (
    <section aria-label="Catalog repository" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{catalog ? 'Catalog repository' : 'Connect a catalog'}</h2>
      {mode === 'demo' ? <p className="text-sm text-muted-foreground">Catalog setup is available in live mode.</p>
        : catalog ? (
          <>
            <p className="break-all font-mono text-sm">{catalog.remote} · {catalog.branch}</p>
            <dl className="grid gap-3 sm:grid-cols-2">
              {[['Last remote revision', status.remote_revision], ['Local revision', status.local_revision],
                ['Active create-skill revision', status.authoring_revision], ['Last published revision', status.published_revision]].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{value || '—'}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="status">
              <p>{read}</p><p>{publish}</p>
            </div>
            {status.read_error && <p className="text-sm text-attention">{status.read_error}</p>}
            {status.publish_error && <p className="text-sm text-attention">{status.publish_error}</p>}
            <div className="flex flex-wrap gap-2">
              <button className={button} disabled={busy} onClick={() => void perform(() => runCatalogAction('check'))}>Check read access</button>
              <button className={primary} disabled={busy} onClick={() => void perform(() => runCatalogAction('publish'))}>Publish</button>
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Public deploy key</summary>
              {status.public_key ? (
                <textarea aria-label="Public deploy key" className={`${input} mt-2 min-h-20 w-full font-mono text-sm`} value={status.public_key} readOnly onFocus={e => e.target.select()} />
              ) : (
                <button className={`${button} mt-2`} type="button" disabled={busy} onClick={() => void perform(() => runCatalogAction('key'))}>Generate deploy key</button>
              )}
            </details>
          </>
        ) : status ? (
          <form className="flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault()
            void perform(() => connectCatalog({ remote, branch, deploy_key: deployKey, seed_if_empty: seed }))
          }}>
            <label className="flex flex-col gap-1 text-sm">GitHub SSH URL
              <input className={input} value={remote} onChange={(e) => setRemote(e.target.value)}
                placeholder="git@github.com:owner/catalog.git" required />
            </label>
            <label className="flex flex-col gap-1 text-sm">Branch
              <input className={input} value={branch} onChange={(e) => setBranch(e.target.value)} required />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={deployKey} onChange={(e) => setDeployKey(e.target.checked)} />
              Use a dedicated GitHub deploy key
            </label>
            {deployKey && (status.public_key ? (
              <label className="flex flex-col gap-1 text-sm">Public deploy key
                <textarea className={`${input} min-h-20 font-mono text-sm`} value={status.public_key} readOnly onFocus={e => e.target.select()} />
                <span className="text-muted-foreground">Register this key in the repository’s Deploy keys settings. Enable write access to publish.</span>
              </label>
            ) : (
              <button className={`${button} self-start`} type="button" disabled={busy} onClick={() => void perform(() => runCatalogAction('key'))}>Generate deploy key</button>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} />
              Publish the create-skill seed if the branch is empty
            </label>
            <button className={`${primary} self-start`} disabled={busy || (deployKey && !status.public_key)} type="submit">Connect catalog</button>
          </form>
        ) : !error ? <p role="status" className="text-sm text-muted-foreground">Loading catalog setup…</p> : null}
      {busy && <p role="status" className="text-sm text-muted-foreground">Working with the catalog…</p>}
      {error && <p role="alert" className="text-sm text-attention">{error}</p>}
    </section>
  )
}
