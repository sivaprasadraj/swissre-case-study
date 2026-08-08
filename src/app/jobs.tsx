/**
 * LONG-RUNNING OPERATION TRACKING.
 *
 * Every structural document operation is a job, not a request. The UI never
 * blocks on one: the user starts a split and keeps working while it runs.
 *
 * This is the one place a reducer is genuinely the right tool. Jobs have a real
 * state machine (queued → running → succeeded | failed | cancelled), several
 * concurrent instances, and transitions driven from outside React by an
 * EventSource. Expressing that as scattered useState calls would be a mess;
 * expressing it in a global Redux store would be overkill because nothing
 * outside the workspace cares. A scoped reducer + context is the right size.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Job, JobKind } from '../domain/types'

type Action =
  | { type: 'upsert'; job: Job }
  | { type: 'dismiss'; id: string }
  | { type: 'dismissFinished' }

interface State {
  jobs: Job[]
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'upsert': {
      const idx = state.jobs.findIndex((j) => j.id === action.job.id)
      if (idx < 0) return { jobs: [action.job, ...state.jobs] }
      const next = state.jobs.slice()
      next[idx] = action.job
      return { jobs: next }
    }
    case 'dismiss':
      return { jobs: state.jobs.filter((j) => j.id !== action.id) }
    case 'dismissFinished':
      return { jobs: state.jobs.filter((j) => j.state === 'queued' || j.state === 'running') }
  }
}

export interface StartOpArgs {
  documentId: string
  kind: JobKind
  afterIndex?: number
  pageIds?: string[]
  sourceIds?: string[]
  simulateFailureFor?: string
  /** ETag of the version the user was looking at — optimistic concurrency. */
  ifMatch?: string
}

interface JobsApi {
  jobs: Job[]
  activeCount: number
  start: (args: StartOpArgs) => Promise<Job | null>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => void
  dismissFinished: () => void
  /** Registers a worker-executed job so the tray shows client-side work too. */
  trackWorkerJob: (job: Job) => void
  updateWorkerJob: (job: Job) => void
}

const JobsContext = createContext<JobsApi | null>(null)

export function JobsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, { jobs: [] })
  const qc = useQueryClient()
  const streams = useRef(new Map<string, EventSource>())

  // Close every stream on unmount — an orphaned EventSource keeps reconnecting
  // forever and is a genuine leak.
  useEffect(
    () => () => {
      streams.current.forEach((s) => s.close())
      streams.current.clear()
    },
    [],
  )

  const attachStream = useCallback(
    (job: Job): void => {
      const es = new EventSource(`/api/jobs/${job.id}/events`)
      streams.current.set(job.id, es)

      es.onmessage = (ev) => {
        const updated = JSON.parse(ev.data as string) as Job
        dispatch({ type: 'upsert', job: updated })

        if (
          updated.state === 'succeeded' ||
          updated.state === 'failed' ||
          updated.state === 'cancelled'
        ) {
          es.close()
          streams.current.delete(job.id)

          // The operation published a new document version, so anything derived
          // from the old one is stale. Invalidate rather than patch: the server
          // is authoritative about what the new version contains.
          if (updated.state === 'succeeded') {
            void qc.invalidateQueries({ queryKey: ['manifest', updated.documentId] })
            void qc.invalidateQueries({ queryKey: ['documents'] })
            void qc.invalidateQueries({ queryKey: ['doc-history', updated.documentId] })
          }
        }
      }

      es.onerror = () => {
        // EventSource retries on its own; we only surface a stall if the job
        // never reached a terminal state.
        const current = state.jobs.find((j) => j.id === job.id)
        if (current && (current.state === 'queued' || current.state === 'running')) {
          dispatch({
            type: 'upsert',
            job: { ...current, message: 'Connection interrupted — reconnecting…' },
          })
        }
      }
    },
    [qc, state.jobs],
  )

  const start = useCallback(
    async (args: StartOpArgs): Promise<Job | null> => {
      const res = await fetch(`/api/documents/${args.documentId}/operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: args.kind,
          afterIndex: args.afterIndex,
          pageIds: args.pageIds,
          sourceIds: args.sourceIds,
          simulateFailureFor: args.simulateFailureFor,
          ifMatch: args.ifMatch,
        }),
      })

      if (res.status === 403) {
        const body = (await res.json()) as { error: string }
        // A 403 here means the UI and the server disagreed. Surface it as a
        // failed job rather than a crash — see design doc: defense in depth.
        dispatch({
          type: 'upsert',
          job: {
            id: `denied-${args.documentId}-${args.kind}`,
            kind: args.kind,
            documentId: args.documentId,
            documentName: args.documentId,
            state: 'failed',
            progress: 0,
            message: 'Not permitted',
            error: body.error,
            startedAt: 0,
            executor: 'server',
          },
        })
        return null
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({ error: 'Request failed' }))) as {
          error: string
        }
        dispatch({
          type: 'upsert',
          job: {
            id: `error-${args.documentId}-${args.kind}`,
            kind: args.kind,
            documentId: args.documentId,
            documentName: args.documentId,
            state: 'failed',
            progress: 0,
            message: 'Could not start',
            error: body.error,
            startedAt: 0,
            executor: 'server',
          },
        })
        return null
      }

      const job = (await res.json()) as Job
      dispatch({ type: 'upsert', job })
      attachStream(job)
      return job
    },
    [attachStream],
  )

  const cancel = useCallback(async (id: string): Promise<void> => {
    // Optimistically reflect the cancel; the stream confirms it. Cancelling is
    // safe to show immediately because the worst case is the job had already
    // finished, and the next event corrects us.
    await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
    streams.current.get(id)?.close()
    streams.current.delete(id)
    const res = await fetch(`/api/jobs/${id}`)
    if (res.ok) dispatch({ type: 'upsert', job: (await res.json()) as Job })
  }, [])

  const api = useMemo<JobsApi>(
    () => ({
      jobs: state.jobs,
      activeCount: state.jobs.filter((j) => j.state === 'queued' || j.state === 'running').length,
      start,
      cancel,
      dismiss: (id) => dispatch({ type: 'dismiss', id }),
      dismissFinished: () => dispatch({ type: 'dismissFinished' }),
      trackWorkerJob: (job) => dispatch({ type: 'upsert', job }),
      updateWorkerJob: (job) => dispatch({ type: 'upsert', job }),
    }),
    [state.jobs, start, cancel],
  )

  return <JobsContext.Provider value={api}>{children}</JobsContext.Provider>
}

export function useJobs(): JobsApi {
  const api = useContext(JobsContext)
  if (!api) throw new Error('useJobs must be used inside JobsProvider')
  return api
}
