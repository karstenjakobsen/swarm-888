'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { OperatorEvent } from '@/lib/operator/types'
import { apply, emptyProjection, replay, verdictDigest, type Projection } from '@/lib/operator/project'

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

export type CatchUp = { fromSeq: number; toSeq: number; offlineAt: string; reason: 'simulated' | 'network' }

type State = { events: OperatorEvent[]; live: Projection; loaded: boolean }
type Action = { type: 'batch'; events: OperatorEvent[] } | { type: 'reset' } | { type: 'loaded' }

function storeReducer(s: State, a: Action): State {
  if (a.type === 'reset') return { events: [], live: emptyProjection, loaded: false }
  if (a.type === 'loaded') return s.loaded ? s : { ...s, loaded: true }
  const fresh = a.events.filter((e) => e.seq > s.live.lastSeq)
  if (!fresh.length) return s.loaded ? s : { ...s, loaded: true }
  return { events: [...s.events, ...fresh], live: fresh.reduce(apply, s.live), loaded: true }
}

type Ctx = {
  state: Projection
  events: OperatorEvent[]
  loaded: boolean
  connection: Connection
  consistent: boolean
  catchUp: CatchUp | null
  dismissCatchUp: () => void
  simulateDisconnect: (ms?: number) => void
  resetScenario: () => Promise<void>
  send: (body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  applyDemoCredential: (requestId: string) => Promise<{ ok: boolean; error?: string }>
}

const OperatorContext = createContext<Ctx | null>(null)

export function OperatorProvider({ children }: { children: React.ReactNode }) {
  const [store, dispatch] = useReducer(storeReducer, { events: [], live: emptyProjection, loaded: false })
  const [connection, setConnection] = useState<Connection>('connecting')
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null)

  const esRef = useRef<EventSource | null>(null)
  const lastSeq = useRef(0)
  const epoch = useRef<string | null>(null)
  const simulated = useRef(false)
  const offline = useRef<{ seq: number; at: string; reason: CatchUp['reason'] } | null>(null)
  const awaitingCatchUp = useRef(false)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    esRef.current?.close()
    const qs = new URLSearchParams({ after: String(lastSeq.current) })
    if (epoch.current) qs.set('epoch', epoch.current)
    const es = new EventSource(`/api/events?${qs}`)
    esRef.current = es
    let buffer: OperatorEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      flushTimer = null
      const batch = buffer
      buffer = []
      dispatch({ type: 'batch', events: batch })
      if (awaitingCatchUp.current && offline.current) {
        awaitingCatchUp.current = false
        setCatchUp({
          fromSeq: offline.current.seq,
          toSeq: lastSeq.current,
          offlineAt: offline.current.at,
          reason: offline.current.reason,
        })
        offline.current = null
      }
    }

    es.addEventListener('hello', (m) => {
      const { epoch: next, from } = JSON.parse((m as MessageEvent).data) as { epoch: string; from: number }
      if (epoch.current && epoch.current !== next) {
        dispatch({ type: 'reset' })
        lastSeq.current = 0
        offline.current = null
      }
      epoch.current = next
      if (from === 0 && lastSeq.current > 0) {
        dispatch({ type: 'reset' })
        lastSeq.current = 0
      }
      setConnection('live')
      if (offline.current) awaitingCatchUp.current = true
      flushTimer ??= setTimeout(flush, 80)
    })
    es.addEventListener('op', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as OperatorEvent
      if (e.seq <= lastSeq.current) return
      lastSeq.current = e.seq
      buffer.push(e)
      flushTimer ??= setTimeout(flush, 60)
    })
    es.onerror = () => {
      es.close()
      if (simulated.current) return
      offline.current ??= { seq: lastSeq.current, at: new Date().toISOString(), reason: 'network' }
      setConnection('reconnecting')
      if (retry.current) clearTimeout(retry.current)
      retry.current = setTimeout(connect, 1500)
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (retry.current) clearTimeout(retry.current)
    }
  }, [connect])

  const simulateDisconnect = useCallback(
    (ms = 14_000) => {
      simulated.current = true
      esRef.current?.close()
      offline.current = { seq: lastSeq.current, at: new Date().toISOString(), reason: 'simulated' }
      setCatchUp(null)
      setConnection('offline')
      setTimeout(() => {
        simulated.current = false
        setConnection('reconnecting')
        connect()
      }, ms)
    },
    [connect],
  )

  const send = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      return { ok: res.ok, error: json.error }
    } catch {
      return { ok: false, error: 'Could not reach the operator.' }
    }
  }, [])

  const applyDemoCredential = useCallback(async (requestId: string) => {
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
        cache: 'no-store',
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      return { ok: res.ok, error: json.error }
    } catch {
      return { ok: false, error: 'Could not reach the operator.' }
    }
  }, [])

  const resetScenario = useCallback(async () => {
    await send({ kind: 'reset' })
    setCatchUp(null)
    connect()
  }, [send, connect])

  const consistent = useMemo(
    () => verdictDigest(store.live) === verdictDigest(replay(store.events)),
    [store.live, store.events],
  )

  const value: Ctx = {
    state: store.live,
    events: store.events,
    loaded: store.loaded,
    connection,
    consistent,
    catchUp,
    dismissCatchUp: () => setCatchUp(null),
    simulateDisconnect,
    resetScenario,
    send,
      applyDemoCredential,
  }

  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>
}

export function useOperator() {
  const ctx = useContext(OperatorContext)
  if (!ctx) throw new Error('useOperator must be used inside OperatorProvider')
  return ctx
}
