'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AccessError, operatorSource } from '@/lib/operator/source'
import type { OperatorMode } from '@/lib/operator/mode'
import type { components } from '@/lib/operator/api'
import { OwnerLogin } from './owner-login'
import type { OperatorEvent, OwnerAction } from '@/lib/operator/types'
import { apply, emptyProjection, type Projection } from '@/lib/operator/project'

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

export type CatchUp = { fromSeq: number; toSeq: number; offlineAt: string; reason: 'simulated' | 'network' }

type State = { events: OperatorEvent[]; live: Projection; loaded: boolean }
type Action = { type: 'batch'; events: OperatorEvent[] } | { type: 'reset' }

function storeReducer(s: State, a: Action): State {
  if (a.type === 'reset') return { events: [], live: emptyProjection, loaded: false }
  const fresh = a.events.filter((e) => e.seq > s.live.lastSeq)
  if (!fresh.length) return s.loaded ? s : { ...s, loaded: true }
  return { events: [...s.events, ...fresh], live: fresh.reduce(apply, s.live), loaded: true }
}

type Ctx = {
  mode: OperatorMode
  name: string
  catalog?: components['schemas']['CatalogInfo']
  state: Projection
  events: OperatorEvent[]
  loaded: boolean
  connection: Connection
  catchUp: CatchUp | null
  dismissCatchUp: () => void
  simulateDisconnect: (ms?: number) => void
  resetScenario: () => Promise<void>
  send: (body: OwnerAction) => Promise<{ ok: boolean; error?: string }>
  supplyCredential: (requestId: string, value?: string) => Promise<{ ok: boolean; error?: string }>
}

const OperatorContext = createContext<Ctx | null>(null)

export function OperatorProvider({ mode, children }: { mode: OperatorMode; children: React.ReactNode }) {
  const source = useMemo(() => operatorSource(mode), [mode])
  const [store, dispatch] = useReducer(storeReducer, { events: [], live: emptyProjection, loaded: false })
  const [connection, setConnection] = useState<Connection>('connecting')
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null)
  const [name, setName] = useState('')
  const [catalog, setCatalog] = useState<Ctx['catalog']>()
  const [access, setAccess] = useState<'loading' | 'ready' | 'login' | 'unavailable'>('loading')
  const [generation, reload] = useReducer((n: number) => n + 1, 0)
  const disconnect = useRef<(ms: number) => void>(() => {})

  useEffect(() => {
    const abort = new AbortController()
    let stream: EventSource | undefined
    let retry: ReturnType<typeof setTimeout>
    let flushTimer: ReturnType<typeof setTimeout>
    let cursor = 0
    let epoch: string | undefined
    let missed: Omit<CatchUp, 'toSeq'> | undefined
    let buffer: OperatorEvent[] = []
    let initialized = false
    setAccess('loading')
    setConnection('connecting')
    setCatchUp(null)
    dispatch({ type: 'reset' })

    function flushEvents() {
      clearTimeout(flushTimer)
      if (buffer.length) dispatch({ type: 'batch', events: buffer })
      buffer = []
    }
    function caughtUp() {
      flushEvents()
      setAccess('ready')
      setConnection('live')
      if (missed) {
        setCatchUp({ ...missed, toSeq: cursor })
        missed = undefined
      }
    }
    function stopStream() {
      stream?.close()
      stream = undefined
      flushEvents()
    }
    function pause(reason: CatchUp['reason'], ms: number) {
      clearTimeout(retry)
      stopStream()
      missed ??= { fromSeq: cursor, offlineAt: new Date().toISOString(), reason }
      setConnection(reason === 'simulated' ? 'offline' : 'reconnecting')
      if (mode === 'live') setAccess('unavailable')
      retry = setTimeout(connect, ms)
    }
    async function connect() {
      try {
        if (!initialized) {
          const snapshot = await source.snapshot(abort.signal)
          if (abort.signal.aborted) return
          cursor = snapshot.cursor
          epoch = snapshot.epoch
          setName(snapshot.name)
          setCatalog(snapshot.catalog)
          dispatch({ type: 'batch', events: snapshot.events })
          initialized = true
        } else {
          await source.checkSession(abort.signal)
          if (abort.signal.aborted) return
        }
        function reset() {
          if (stream !== current) return
          stopStream()
          reload()
        }
        const current = source.subscribe(cursor, epoch, {
          event(event) {
            if (stream !== current || event.seq <= cursor) return
            if (event.seq !== cursor + 1) return reset()
            cursor = event.seq
            buffer.push(event)
            if (buffer.length === 1) flushTimer = setTimeout(flushEvents, 0)
          },
          reset,
          caughtUp() { if (stream === current) caughtUp() },
        })
        stream = current
        current.onerror = () => {
          if (stream === current) pause('network', 1200)
        }
      } catch (error) {
        if (abort.signal.aborted) return
        if (error instanceof AccessError && error.status === 401) {
          setAccess('login')
          dispatch({ type: 'reset' })
        } else {
          pause('network', 1200)
        }
      }
    }
    disconnect.current = ms => pause('simulated', ms)
    void connect()
    return () => {
      abort.abort()
      stream?.close()
      stream = undefined
      clearTimeout(retry)
      clearTimeout(flushTimer)
      disconnect.current = () => {}
    }
  }, [source, mode, generation])

  const send = useCallback(async (action: OwnerAction) => {
    try {
      await source.submit(action)
      return { ok: true }
    } catch (error) {
      if (error instanceof AccessError && error.status === 401) reload()
      return { ok: false, error: error instanceof AccessError ? error.message : 'Could not reach the operator.' }
    }
  }, [source])
  if (mode === 'live' && access === 'login') return <OwnerLogin onLogin={reload} />
  if (mode === 'live' && access !== 'ready') {
    return <main className="mx-auto max-w-md p-6" role="status">
      {access === 'unavailable' ? 'Operator unavailable. Reconnecting…' : 'Connecting to the operator…'}
    </main>
  }
  const value: Ctx = {
    mode, name, catalog, state: store.live, events: store.events, loaded: store.loaded, connection, catchUp,
    dismissCatchUp: () => setCatchUp(null),
    simulateDisconnect: (ms = 14_000) => disconnect.current(ms),
    resetScenario: async () => {
      if (mode === 'demo' && (await send({ kind: 'reset' })).ok) reload()
    },
    send,
    supplyCredential: async (requestId, value) => {
      try {
        await source.supplyCredential(requestId, value)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof AccessError ? error.message : 'Could not supply the credential.' }
      }
    },
  }
  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>
}

export function useOperator() {
  const ctx = useContext(OperatorContext)
  if (!ctx) throw new Error('useOperator must be used inside OperatorProvider')
  return ctx
}
