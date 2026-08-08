/**
 * Bridge to the document worker.
 *
 * Owns the worker lifecycle, correlates request/response by taskId, and mirrors
 * worker-executed operations into the same job tray as server-executed ones — so
 * the user sees one consistent list of "things happening", with the executor
 * labelled rather than hidden.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkerRequest, WorkerResponse } from './pdf.worker'
import { useJobs } from '../../app/jobs'

export interface SplitAttempt {
  documentId: string
  documentName: string
  byteSize: number
  pageCount: number
  afterIndex: number
  /** ETag of the version the user was viewing — optimistic concurrency. */
  etag: string
}

export function useDocumentWorker(): {
  trySplit: (args: SplitAttempt) => Promise<'done' | 'refused' | 'cancelled' | 'error'>
} {
  const worker = useRef<Worker | null>(null)
  const jobs = useJobs()
  const qc = useQueryClient()
  const seq = useRef(0)

  // One worker for the workspace's lifetime. Spawning per operation would pay
  // the ~10-30ms startup cost every time and lose the warmed JIT.
  useEffect(() => {
    worker.current = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })
    return () => {
      worker.current?.terminate()
      worker.current = null
    }
  }, [])

  const trySplit = useCallback(
    (args: SplitAttempt): Promise<'done' | 'refused' | 'cancelled' | 'error'> => {
      const w = worker.current
      if (!w) return Promise.resolve('error')

      const taskId = `wtask-${++seq.current}`
      const jobId = `worker-${taskId}`

      jobs.trackWorkerJob({
        id: jobId,
        kind: 'split',
        documentId: args.documentId,
        documentName: args.documentName,
        state: 'queued',
        progress: 0,
        message: 'Starting in worker',
        startedAt: seq.current,
        executor: 'worker',
      })

      return new Promise((resolve) => {
        const onMessage = (e: MessageEvent<WorkerResponse>): void => {
          const msg = e.data
          if (!('taskId' in msg) || msg.taskId !== taskId) return

          switch (msg.type) {
            case 'progress':
              jobs.updateWorkerJob({
                id: jobId,
                kind: 'split',
                documentId: args.documentId,
                documentName: args.documentName,
                state: 'running',
                progress: msg.progress,
                message: msg.message,
                startedAt: seq.current,
                executor: 'worker',
              })
              break

            case 'refused':
              // The worker declined on size grounds. Remove the tray entry —
              // the caller will start a server job, and showing a phantom
              // "failed" worker job would be misleading.
              jobs.dismiss(jobId)
              w.removeEventListener('message', onMessage)
              resolve('refused')
              break

            case 'done': {
              w.removeEventListener('message', onMessage)

              // The worker computed the result; the server publishes it. Compute
              // can happen anywhere, but the version, ETag and audit entry are
              // the server's to issue — so a client-side operation is not
              // "done" until this commit succeeds.
              jobs.updateWorkerJob({
                id: jobId,
                kind: 'split',
                documentId: args.documentId,
                documentName: args.documentName,
                state: 'running',
                progress: 100,
                message: 'Publishing new version',
                startedAt: seq.current,
                executor: 'worker',
              })

              void (async () => {
                try {
                  const res = await fetch(`/api/documents/${args.documentId}/commit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      kind: 'split',
                      afterIndex: args.afterIndex,
                      ifMatch: args.etag,
                    }),
                  })

                  if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string }
                    jobs.updateWorkerJob({
                      id: jobId,
                      kind: 'split',
                      documentId: args.documentId,
                      documentName: args.documentName,
                      state: 'failed',
                      progress: 100,
                      message: res.status === 412 ? 'Version conflict' : 'Could not publish',
                      error: body.error ?? `Commit failed (${res.status})`,
                      startedAt: seq.current,
                      executor: 'worker',
                    })
                    resolve('error')
                    return
                  }

                  const { version } = (await res.json()) as { version: string }
                  jobs.updateWorkerJob({
                    id: jobId,
                    kind: 'split',
                    documentId: args.documentId,
                    documentName: args.documentName,
                    state: 'succeeded',
                    progress: 100,
                    message: `Split in worker (${msg.elapsedMs}ms compute), published`,
                    resultVersion: version,
                    startedAt: seq.current,
                    executor: 'worker',
                  })
                  void qc.invalidateQueries({ queryKey: ['manifest', args.documentId] })
                  void qc.invalidateQueries({ queryKey: ['doc-history', args.documentId] })
                  void qc.invalidateQueries({ queryKey: ['documents'] })
                  resolve('done')
                } catch (err) {
                  jobs.updateWorkerJob({
                    id: jobId,
                    kind: 'split',
                    documentId: args.documentId,
                    documentName: args.documentName,
                    state: 'failed',
                    progress: 100,
                    message: 'Could not publish',
                    error: err instanceof Error ? err.message : String(err),
                    startedAt: seq.current,
                    executor: 'worker',
                  })
                  resolve('error')
                }
              })()
              break
            }

            case 'cancelled':
              jobs.updateWorkerJob({
                id: jobId,
                kind: 'split',
                documentId: args.documentId,
                documentName: args.documentName,
                state: 'cancelled',
                progress: 0,
                message: 'Cancelled by user',
                startedAt: seq.current,
                executor: 'worker',
              })
              w.removeEventListener('message', onMessage)
              resolve('cancelled')
              break

            case 'error':
              jobs.updateWorkerJob({
                id: jobId,
                kind: 'split',
                documentId: args.documentId,
                documentName: args.documentName,
                state: 'failed',
                progress: 0,
                message: 'Worker error',
                error: msg.error,
                startedAt: seq.current,
                executor: 'worker',
              })
              w.removeEventListener('message', onMessage)
              resolve('error')
              break
          }
        }

        w.addEventListener('message', onMessage)

        const req: WorkerRequest = {
          type: 'split',
          taskId,
          byteSize: args.byteSize,
          pageCount: args.pageCount,
          afterIndex: args.afterIndex,
        }
        w.postMessage(req)
      })
    },
    [jobs, qc],
  )

  return { trySplit }
}
