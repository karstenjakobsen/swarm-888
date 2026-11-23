'use client'

import { useEffect, useState } from 'react'
import type { components } from '@/lib/operator/api'
import { activateCatalogSkill, connectCatalog, previewCatalogPublish, publishCatalogBranch, pullCatalogBranch, readCatalogStatus, runCatalogAction } from '@/lib/operator/source'
import { useOperator } from './store'

type CatalogStatus = components['schemas']['CatalogStatus']
type CatalogKind = components['schemas']['CatalogConnectionInfo']['kind']
const labels: Record<CatalogKind, string> = { skill: 'Skills', connector: 'Connectors', project: 'Projects' }
const allKinds = Object.keys(labels) as CatalogKind[]
const button = 'rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-medium disabled:opacity-50'
const primary = 'rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'
const input = 'rounded-lg border border-input bg-background px-3 py-2 text-base'

export function CatalogTab() {
  const { mode, setCatalog } = useOperator()
  const [status, setStatus] = useState<CatalogStatus>()
  const [remote, setRemote] = useState('')
  const [branch, setBranch] = useState('main')
  const [deployKey, setDeployKey] = useState(false)
  const [kinds, setKinds] = useState<CatalogKind[]>(allKinds)
  const [replace, setReplace] = useState(false)
  const [preview, setPreview] = useState<{ branch: string; result: components['schemas']['CatalogPublishPreview'] }>()
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
    setPreview(undefined)
    try {
      const next = await action()
      setStatus(next)
      setCatalog(next.catalog ?? next.connections?.[0] ?? undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Catalog request failed.')
    } finally {
      setBusy(false)
    }
  }

  async function review(branch: string) {
    setBusy(true)
    setError('')
    setPreview(undefined)
    try {
      setPreview({ branch, result: await previewCatalogPublish(branch) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not preview publishing.')
    } finally {
      setBusy(false)
    }
  }

  const catalog = status?.catalog
  const publish = status?.publish_error ? 'Publish failed' : status?.published_revision ? 'Publish verified' : 'Publish unverified'
  const read = status?.read_error ? 'Read check failed' : status?.remote_revision ? 'Read verified' : 'Read unverified'

  return (
    <section aria-label="Catalog repository" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{catalog || status?.connections?.length ? 'Catalog repository' : 'Connect a catalog'}</h2>
      {status?.builtins?.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Built into the framework</h3>
          {status.builtins.map(skill => (
            <details key={skill.skill} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">{skill.skill}</summary>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{skill.path} · {skill.revision}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{skill.guide}</p>
            </details>
          ))}
        </div>
      ) : null}
      {status?.connections?.map((connection, index, connections) => (
        <section key={connection.kind} className="rounded-lg border border-border p-3">
          <h3 className="text-sm font-medium">{labels[connection.kind]}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{connection.remote} · {connection.branch} · {connection.revision}</p>
          {connection.items.length ? (
            <ul className="mt-2 divide-y divide-border">
              {connection.items.map(item => (
                <li key={item.canonical_id} className="py-2 text-sm">
                  {item.name}
                  <p className="break-all font-mono text-xs text-muted-foreground">{item.canonical_id} · {item.path}</p>
                  {item.active_revision && <p className="break-all font-mono text-xs">Active · {item.active_revision}</p>}
                  {item.guide != null && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-sm font-medium">Read guide</summary>
                      <p className="mt-2 whitespace-pre-wrap text-sm">{item.guide}</p>
                    </details>
                  )}
                  {connection.kind === 'skill' && item.guide == null && item.active_revision !== item.revision && (
                    <button className={`${button} mt-1`} disabled={busy} onClick={() => void perform(() => activateCatalogSkill(item.canonical_id, item.revision))}>Test and activate</button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-muted-foreground">No items discovered.</p>}
          {connections.findIndex(other => other.branch_id === connection.branch_id) === index && (
            <div className="mt-2 grid gap-2">
              <p className="text-xs text-muted-foreground">
                {connection.remote_revision ? 'Read verified' : 'Read unverified'} · {connection.publish_error ? 'Publish failed' : connection.published_revision ? 'Publish verified' : 'Publish unverified'}
              </p>
              {connection.publish_error && <p className="text-sm text-attention">{connection.publish_error}</p>}
              <div className="flex flex-wrap gap-2">
                <button className={button} disabled={busy} onClick={() => void perform(() => pullCatalogBranch(connection.branch_id))}>Pull branch</button>
                <button className={button} disabled={busy} onClick={() => void review(connection.branch_id)}>Preview publish</button>
              </div>
            </div>
          )}
        </section>
      ))}
      {preview && (
        <section aria-label="Publish preview" className="grid gap-3 rounded-lg border border-border p-3">
          <h3 className="font-medium">Publish preview</h3>
          <p className="break-all font-mono text-xs">{preview.result.remote_revision} → {preview.result.local_revision}</p>
          {preview.result.commits.length ? (
            <>
              <ol className="grid gap-2">
                {preview.result.commits.map(commit => (
                  <li key={commit.revision} className="text-sm">
                    {commit.subject}
                    <p className="break-all font-mono text-xs text-muted-foreground">{commit.revision}</p>
                    <ul className="mt-1">
                      {commit.paths.map(path => <li key={path} className="break-all font-mono text-xs">{path}</li>)}
                    </ul>
                  </li>
                ))}
              </ol>
              <h4 className="text-sm font-medium">Affected items</h4>
              <ul className="grid gap-1 text-sm">
                {preview.result.items.map(item => (
                  <li key={item.canonical_id} className="break-all">{item.kind} · {item.canonical_id} · {item.change} · {item.path}
                    <p className="font-mono text-xs text-muted-foreground">{item.paths.join(' · ')}</p>
                  </li>
                ))}
              </ul>
              <button className={`${primary} justify-self-start`} disabled={busy} onClick={() => void perform(() => publishCatalogBranch(preview.branch, {
                remote_revision: preview.result.remote_revision, local_revision: preview.result.local_revision,
              }))}>Publish reviewed commits</button>
            </>
          ) : <p className="text-sm text-muted-foreground">No pending commits.</p>}
        </section>
      )}
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
        ) : null}
      {mode === 'live' && status ? (
          <form className="flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault()
            void perform(() => connectCatalog({ remote, branch, deploy_key: deployKey, seed_if_empty: false, kinds, replace }))
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
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 font-medium">Catalog kinds</legend>
              {allKinds.map(kind => (
                <label key={kind} className="flex items-center gap-2">
                  <input type="checkbox" checked={kinds.includes(kind)} onChange={(event) => {
                    setKinds(event.target.checked ? [...kinds, kind] : kinds.filter(current => current !== kind))
                  }} />
                  {labels[kind]}
                </label>
              ))}
            </fieldset>
            {status.connections?.length ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />
                Switch selected kinds from their current branch
              </label>
            ) : null}
            <button className={`${primary} self-start`} disabled={busy || !kinds.length || (deployKey && !status.public_key)} type="submit">Connect catalog</button>
          </form>
        ) : mode === 'live' && !error ? <p role="status" className="text-sm text-muted-foreground">Loading catalog setup…</p> : null}
      {busy && <p role="status" className="text-sm text-muted-foreground">Working with the catalog…</p>}
      {error && <p role="alert" className="text-sm text-attention">{error}</p>}
    </section>
  )
}
