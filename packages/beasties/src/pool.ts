import type { Options } from './types'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

export interface BeastiesPoolOptions {
  /** Worker threads to start. @default `max(1, availableParallelism() - 1)` */
  workers?: number
  /**
   * Options for the Beasties instance in every worker. They cross the thread boundary by
   * structured clone: `RegExp` (e.g. in `allowRules`) works, functions (`nonce`, a custom
   * `logger`) and `fs` do not.
   */
  options?: Options
  /**
   * Extra `<style>` tags to reduce next to the ones generated from linked stylesheets, as a CSS
   * selector (or several), e.g. `'style[data-component-css]'`. This replaces overriding
   * `getAffectedStyleTags`.
   */
  additionalStyleSelector?: string | string[]
  /**
   * Stylesheet contents by `href` (exactly as written in the `<link>`), looked up in the worker
   * before anything else.
   */
  css?: Record<string, string>
  /**
   * Resolve the contents of a linked stylesheet on the main thread; replaces overriding
   * `getCssAsset`. Return `undefined` to leave a stylesheet alone. Runs at most once per `href` and
   * worker unless `cacheResolved` is `false`, so side effects run on the main thread but not per page.
   */
  resolveCss?: (href: string) => string | undefined | Promise<string | undefined>
  /** Keep resolved stylesheets (and misses) in each worker. @default true */
  cacheResolved?: boolean
}

interface Job {
  id: number
  html: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

interface Slot {
  worker: Worker
  job?: Job
  ready: boolean
}

/**
 * Runs `Beasties#process` on worker threads, so documents are processed in parallel. Safe to call
 * `process` any number of times concurrently: calls queue up and each worker takes one at a time.
 * Output is identical to `new Beasties(options).process(html)`.
 */
export class BeastiesPool {
  #slots: Slot[] = []
  #queue: Job[] = []
  #nextId = 0
  #closed = false
  #ready: Promise<void>
  readonly #options: BeastiesPoolOptions

  constructor(options: BeastiesPoolOptions = {}) {
    this.#options = options
    const size = Math.max(1, options.workers ?? Math.max(1, availableParallelism() - 1))
    const ready: Promise<void>[] = []
    for (let i = 0; i < size; i++) {
      ready.push(this.#spawn())
    }
    this.#ready = Promise.all(ready).then(() => {})
    // surfaced through process()/ready(), never as an unhandled rejection
    this.#ready.catch(() => {})
  }

  /** Resolves once every worker has started. `process` works without waiting for it. */
  ready(): Promise<void> {
    return this.#ready
  }

  get size(): number {
    return this.#slots.length
  }

  process(html: string): Promise<string> {
    if (this.#closed)
      return Promise.reject(new Error('BeastiesPool is closed'))
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextId++, html, resolve, reject })
      this.#dispatch()
    })
  }

  /** Stops the workers. Pending and queued calls reject. */
  async close(): Promise<void> {
    this.#closed = true
    const error = new Error('BeastiesPool closed')
    for (const job of this.#queue.splice(0))
      job.reject(error)
    await Promise.all(this.#slots.splice(0).map((slot) => {
      slot.job?.reject(error)
      slot.job = undefined
      return slot.worker.terminate()
    }))
  }

  #spawn(): Promise<void> {
    const { options, additionalStyleSelector, css, resolveCss, cacheResolved } = this.#options
    const extra = additionalStyleSelector === undefined ? undefined : [additionalStyleSelector].flat()
    const worker = new Worker(new URL('./pool-worker.mjs', import.meta.url), {
      workerData: {
        options: options ?? {},
        additionalStyleSelector: extra,
        css,
        hasResolver: !!resolveCss,
        cacheResolved: cacheResolved !== false,
      },
    })
    const slot: Slot = { worker, ready: false }
    this.#slots.push(slot)

    return new Promise<void>((resolveReady, rejectReady) => {
      worker.on('message', async (message: any) => {
        switch (message.type) {
          case 'ready':
            slot.ready = true
            resolveReady()
            this.#dispatch()
            break
          case 'css': {
            let css: string | undefined
            try {
              css = await resolveCss!(message.href)
            }
            catch (error) {
              // a failing resolver is treated as "no such stylesheet"; the page is still processed
              console.error(`[beasties-pool] resolveCss(${message.href}) failed:`, error)
            }
            worker.postMessage({ type: 'css', id: message.id, css })
            break
          }
          case 'result':
          case 'error': {
            const job = slot.job
            slot.job = undefined
            if (job) {
              if (message.type === 'result') {
                job.resolve(message.html)
              }
              else {
                const error = new Error(message.message)
                error.stack = message.stack
                job.reject(error)
              }
            }
            this.#dispatch()
            break
          }
        }
      })
      worker.on('error', (error) => {
        rejectReady(error)
        this.#lost(slot, error)
      })
      worker.on('exit', (code) => {
        if (!this.#closed)
          this.#lost(slot, new Error(`beasties worker exited with code ${code}`))
      })
    })
  }

  #lost(slot: Slot, error: Error) {
    const index = this.#slots.indexOf(slot)
    if (index === -1)
      return
    this.#slots.splice(index, 1)
    slot.job?.reject(error)
    slot.job = undefined
    if (!this.#closed && slot.ready) {
      // replace a worker that died while running; one that failed to start is not retried
      this.#spawn().catch(() => {})
    }
  }

  #dispatch() {
    for (const slot of this.#slots) {
      if (!this.#queue.length)
        return
      if (slot.ready && !slot.job) {
        const job = this.#queue.shift()!
        slot.job = job
        slot.worker.postMessage({ type: 'process', id: job.id, html: job.html })
      }
    }
  }
}
