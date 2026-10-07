import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import Beasties from '../src'

const root = fileURLToPath(new URL('..', import.meta.url))
const CSS = [
  '.a .b{color:red}',
  '.c{color:blue}',
  '.d{color:green}',
  '.never{color:pink}',
  '[grid-template-areas:\'x\'\'y\']{display:grid}',
  '.k\\[grid\\:\\\'a\\\'\\]{display:grid}',
].join('')
const COMPONENT = '.comp-used{color:red}.comp-unused{color:blue}'

function page(i: number) {
  return `<html><head><link rel="stylesheet" href="/entry.css"><style data-component-css>${COMPONENT}</style><style>.c{x:${i}}.never{x:1}</style></head>`
    + `<body><div class="a"><i class="b">${i}</i></div>${i % 2 ? '<p class="c comp-used">c</p>' : '<p class="d">d</p>'}</body></html>`
}

const options = { preload: 'media', reduceInlineStyles: false, allowRules: [/\\['"]/], logLevel: 'silent' } as const

class Reference extends Beasties {
  async getCssAsset(href: string) {
    return href === '/entry.css' ? CSS : undefined
  }

  getAffectedStyleTags(document: any) {
    return [...document.querySelectorAll('style')].filter((s: any) => s.$$external || s.hasAttribute('data-component-css'))
  }
}

describe('beastiesPool', () => {
  let BeastiesPool: typeof import('../src/pool').BeastiesPool
  beforeAll(async () => {
    // the pool starts worker threads from the built pool-worker.mjs
    execSync('pnpm build', { cwd: root, stdio: 'ignore' })
    expect(existsSync(`${root}/dist/pool-worker.mjs`)).toBe(true)
    BeastiesPool = (await import(/* @vite-ignore */ `${root}/dist/pool.mjs`)).BeastiesPool
  }, 60_000)

  it('matches Beasties for 32 concurrent calls (resolver on the main thread, RegExp option, extra style selector)', async () => {
    const reference = new Reference(options)
    const pool = new BeastiesPool({
      workers: 2,
      options,
      additionalStyleSelector: 'style[data-component-css]',
      resolveCss: href => (href === '/entry.css' ? CSS : undefined),
    })
    try {
      const pages = Array.from({ length: 32 }, (_, i) => page(i))
      const results = await Promise.all(pages.map(html => pool.process(html)))
      for (const [i, html] of pages.entries())
        expect(results[i]).toBe(await reference.process(html))
      // the extra selector and the RegExp both took effect
      expect(results[1]).not.toContain('comp-unused')
      expect(results[1]).toContain('.k\\[grid')
    }
    finally {
      await pool.close()
    }
  })

  it('resolves each stylesheet once per worker, and accepts an href map', async () => {
    let calls = 0
    const pool = new BeastiesPool({
      workers: 1,
      options,
      resolveCss: (href) => {
        calls++
        return href === '/entry.css' ? CSS : undefined
      },
    })
    const mapped = new BeastiesPool({ workers: 1, options, css: { '/entry.css': CSS } })
    try {
      const a = await Promise.all([0, 1, 2, 3].map(i => pool.process(page(i))))
      const b = await Promise.all([0, 1, 2, 3].map(i => mapped.process(page(i))))
      expect(b).toEqual(a)
      expect(calls).toBe(1)
    }
    finally {
      await pool.close()
      await mapped.close()
    }
  })

  it('rejects after close() and for queued work', async () => {
    const pool = new BeastiesPool({ workers: 1, options, css: { '/entry.css': CSS } })
    const queued = pool.process(page(1))
    const assertion = expect(queued).rejects.toThrow(/closed/)
    await pool.close()
    await assertion
    await expect(pool.process(page(2))).rejects.toThrow(/closed/)
  })

  it('reduces plain inline styles as well as the additional selector', async () => {
    const opts = { preload: 'media', logLevel: 'silent' } as const // reduceInlineStyles stays true
    const reference = new (class extends Beasties {
      async getCssAsset(href: string) {
        return href === '/entry.css' ? CSS : undefined
      }

      getAffectedStyleTags(document: any) {
        return [...document.querySelectorAll('style')]
      }
    })(opts)
    const pool = new BeastiesPool({ workers: 1, options: opts, css: { '/entry.css': CSS }, additionalStyleSelector: 'style[data-component-css]' })
    try {
      const html = page(1)
      const out = await pool.process(html)
      expect(out).toBe(await reference.process(html))
      expect(out).not.toContain('.never')
    }
    finally {
      await pool.close()
    }
  })

  it('fails instead of hanging when no worker can start', async () => {
    const pool = new BeastiesPool({ workers: 2, options, workerFile: `${root}/dist/does-not-exist.mjs` })
    const queued = pool.process(page(1))
    await expect(queued).rejects.toThrow()
    await expect(pool.process(page(2))).rejects.toThrow()
    await pool.close()
  })
})
