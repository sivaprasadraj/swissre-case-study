/**
 * DOCUMENT WORKER.
 *
 * What runs here and why:
 *
 *   - Thumbnail/preview rasterisation and any per-page geometry work. These are
 *     CPU-bound loops that would otherwise land on the main thread between
 *     paint frames and drop the viewer below 60fps.
 *   - Annotation spatial indexing. Hit-testing hundreds of annotation rects per
 *     pointer-move is exactly the kind of tight loop that belongs off-thread.
 *   - Client-side split/merge for SMALL documents only, as an explicit
 *     fallback. This is the interesting case: it demonstrates that we CAN do
 *     structural work client-side, and simultaneously demonstrates why we
 *     don't for large files — the bytes have to be in memory to do it.
 *
 * What deliberately does NOT run here: structural mutation of 150 MB - 1 GB
 * documents. Doing that in the browser means downloading the whole file, holding
 * it (plus the output) in memory, and re-uploading. The bytes already live next
 * to the server. Sending an instruction instead of a gigabyte is not an
 * optimisation, it's the only sane design.
 *
 * Cancellation is cooperative: the worker checks a flag between chunks. There is
 * no way to preempt a running task in JS, so long loops must be chunked to be
 * cancellable at all — which is itself a reason to chunk them.
 */

/// <reference lib="webworker" />

export type WorkerRequest =
  | {
      type: 'split'
      taskId: string
      /** Simulated byte size, so the demo can show the size-based decision. */
      byteSize: number
      pageCount: number
      afterIndex: number
    }
  | {
      type: 'merge'
      taskId: string
      byteSize: number
      inputs: { id: string; pageCount: number; byteSize: number }[]
    }
  | {
      type: 'index-annotations'
      taskId: string
      annotations: { id: string; pageId: string; rect: { x: number; y: number; w: number; h: number } }[]
    }
  | { type: 'cancel'; taskId: string }

export type WorkerResponse =
  | { type: 'progress'; taskId: string; progress: number; message: string }
  | { type: 'done'; taskId: string; result: unknown; elapsedMs: number }
  | { type: 'error'; taskId: string; error: string }
  | { type: 'cancelled'; taskId: string }
  | {
      type: 'refused'
      taskId: string
      reason: string
      /** What the client should do instead. */
      delegateTo: 'server'
    }

/**
 * The threshold that encodes the client-vs-server decision.
 *
 * 25 MB is roughly where holding source + output + working copy in a browser tab
 * stops being comfortable on a mid-tier corporate laptop (~4 GB usable, shared
 * with everything else the user has open). Above it we refuse and tell the
 * caller to delegate. Refusing loudly is better than trying and OOM-ing the tab,
 * which loses the user's unsaved annotations too.
 */
const CLIENT_SIDE_BYTE_LIMIT = 25 * 1024 * 1024

const cancelled = new Set<string>()

/** Yield to the event loop so cancel messages can actually be received. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function post(msg: WorkerResponse): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const msg = e.data

  if (msg.type === 'cancel') {
    cancelled.add(msg.taskId)
    return
  }

  const { taskId } = msg
  // Logical clock rather than Date.now(), so output is deterministic in tests.
  let tick = 0
  const started = tick

  try {
    if (msg.type === 'index-annotations') {
      // Build a per-page bucket index. Turns hit-testing from O(n) over all
      // annotations into O(k) over one page's worth.
      const index = new Map<string, typeof msg.annotations>()
      for (const a of msg.annotations) {
        const bucket = index.get(a.pageId) ?? []
        bucket.push(a)
        index.set(a.pageId, bucket)
      }
      post({
        type: 'done',
        taskId,
        result: { pages: index.size, annotations: msg.annotations.length },
        elapsedMs: 0,
      })
      return
    }

    // Both split and merge are size-gated.
    if (msg.byteSize > CLIENT_SIDE_BYTE_LIMIT) {
      post({
        type: 'refused',
        taskId,
        reason:
          `Document is ${(msg.byteSize / 1024 / 1024).toFixed(0)} MB, above the ` +
          `${CLIENT_SIDE_BYTE_LIMIT / 1024 / 1024} MB client-side limit. ` +
          `Client-side structural edits require the whole file in memory; ` +
          `delegating to the server, where the bytes already are.`,
        delegateTo: 'server',
      })
      return
    }

    const stages =
      msg.type === 'split'
        ? [
            'Parsing page tree',
            `Extracting pages 1-${msg.afterIndex}`,
            'Rebuilding cross-reference table',
            'Serialising output',
          ]
        : [
            'Parsing target document',
            `Appending ${msg.inputs.length} input document(s)`,
            'Rebuilding cross-reference table',
            'Serialising output',
          ]

    // Chunked work loop. Each iteration is small enough that a cancel lands
    // within ~40ms, which is what makes the Cancel button honest.
    const totalChunks = 24
    for (let chunk = 0; chunk < totalChunks; chunk++) {
      if (cancelled.has(taskId)) {
        cancelled.delete(taskId)
        post({ type: 'cancelled', taskId })
        return
      }

      // Stand-in for real byte manipulation; the shape of the loop is the point.
      let acc = 0
      for (let i = 0; i < 250_000; i++) acc += Math.sqrt(i % 977)
      if (acc < 0) throw new Error('unreachable')

      tick += 40
      const stageIndex = Math.min(stages.length - 1, Math.floor((chunk / totalChunks) * stages.length))
      post({
        type: 'progress',
        taskId,
        progress: Math.round(((chunk + 1) / totalChunks) * 100),
        message: stages[stageIndex]!,
      })

      await yieldToLoop()
    }

    const result =
      msg.type === 'split'
        ? { pageCount: msg.afterIndex, byteSize: Math.round(msg.byteSize * (msg.afterIndex / msg.pageCount)) }
        : {
            pageCount: msg.inputs.reduce((a, i) => a + i.pageCount, 0),
            byteSize: msg.byteSize + msg.inputs.reduce((a, i) => a + i.byteSize, 0),
          }

    post({ type: 'done', taskId, result, elapsedMs: tick - started })
  } catch (err) {
    post({ type: 'error', taskId, error: err instanceof Error ? err.message : String(err) })
  }
}
