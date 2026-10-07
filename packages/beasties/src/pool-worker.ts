import type { Options } from './types'
import { parentPort, workerData } from 'node:worker_threads'
import { is } from 'css-select'
import Beasties from './index'

interface WorkerData {
  options: Options
  additionalStyleSelector?: string[]
  css?: Record<string, string>
  hasResolver: boolean
  cacheResolved: boolean
}

const data = workerData as WorkerData
const port = parentPort!

let nextRequest = 0
const pendingCss = new Map<number, (css: string | undefined) => void>()
const resolved = new Map<string, Promise<string | undefined>>()

function requestCss(href: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = nextRequest++
    pendingCss.set(id, resolve)
    port.postMessage({ type: 'css', id, href })
  })
}

class WorkerBeasties extends Beasties {
  override async getCssAsset(href: string, style?: unknown): Promise<string | undefined> {
    if (data.css && Object.hasOwn(data.css, href))
      return data.css[href]
    if (!data.hasResolver)
      return super.getCssAsset(href, style)
    if (!data.cacheResolved)
      return requestCss(href)
    let css = resolved.get(href)
    if (!css) {
      css = requestCss(href)
      resolved.set(href, css)
    }
    return css
  }

  // not in beasties' typings; see Beasties#getAffectedStyleTags
  override getAffectedStyleTags(document: any): any[] {
    const extra = data.additionalStyleSelector
    const styles = super.getAffectedStyleTags(document)
    if (!extra?.length)
      return styles
    return [...document.querySelectorAll('style')].filter(
      (style: any) => style.$$external || extra.some(selector => is(style, selector)),
    )
  }
}

const beasties = new WorkerBeasties(data.options)

port.on('message', async (message: any) => {
  if (message.type === 'css') {
    const resolve = pendingCss.get(message.id)
    pendingCss.delete(message.id)
    resolve?.(message.css)
  }
  else if (message.type === 'process') {
    try {
      port.postMessage({ type: 'result', id: message.id, html: await beasties.process(message.html) })
    }
    catch (error) {
      port.postMessage({ type: 'error', id: message.id, message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack })
    }
  }
})

port.postMessage({ type: 'ready' })
