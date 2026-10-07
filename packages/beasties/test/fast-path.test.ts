import { selectOne } from 'css-select'
import { describe, expect, it, vi } from 'vitest'
import Beasties from '../src'
import { parseStylesheet } from '../src/css'
import { createDocument, invalidateSelectorIndex } from '../src/dom'

vi.mock('../src/css', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/css')>()
  return { ...original, parseStylesheet: vi.fn(original.parseStylesheet) }
})

// selectors with combinators / several compounds take the indexed path (a lone `.a.b` is answered
// by the class/id cache, which is upstream behaviour kept as is)
const SELECTORS = [
  '.a .b',
  '.a > .b',
  '.a + .b',
  '.a ~ .b',
  '.row .cell',
  '.wrapper .cell',
  'main .cell',
  '.scope .cell',
  '.outer .inner',
  'div .b',
  '.a div',
  '#x .b',
  '.a #y',
  '.a *',
  '* .b',
  '.a .b .c',
  '.a > .b > .c',
  '.missing .b',
  '.a .missing',
  'span.cell',
  '.a span',
  '[data-x] .b',
  '.a [data-x]',
  'html .b',
  'body .b',
  'div [class~="Foo" i]',
  'div [id="Y" i]',
  '.a [class~="B" i]',
  '.tpl .inside',
  '.t .b',
  '.dark .b',
  'p:not(.x) .b',
  '.a > > .b',
  '> .b',
]

const HTML = `<!doctype html><html class="dark"><head><link class="b" rel="stylesheet" href="/s.css"></head><body>
<div class="wrapper"><main class="scope" data-beasties-container>
  <div class="row"><span class="cell" id="y">x</span></div>
  <div class="a"><p class="b">p</p><div class="outer"><i class="inner c" data-x="1">i</i></div></div>
  <template><div class="tpl"><b class="inside">t</b></div></template>
</main></div>
<div class="a"><i class="b">outside</i><section id="x"><u class="b">u</u></section></div>
</body></html>`

function reference(sel: string, container: any): boolean {
  return !!selectOne(sel, container)
}

describe('indexed selector matching', () => {
  for (const [name, html] of [
    ['default container (html)', HTML.replace(' data-beasties-container', '')],
    ['inner container', HTML],
  ] as const) {
    it(`agrees with css-select: ${name}`, () => {
      const doc = createDocument(html)
      for (const container of doc.beastiesContainers) {
        for (const sel of SELECTORS) {
          let expected: boolean | string
          try {
            expected = reference(sel, container)
          }
          catch (e) {
            expected = (e as Error).message
          }
          let actual: boolean | string
          try {
            actual = container.exists(sel)
          }
          catch (e) {
            actual = (e as Error).message
          }
          // a lone class/id compound is answered by the pre-existing cache, which is looser
          if (typeof expected === 'boolean' && /^(?:[.#][\w-]+)+$/.test(sel))
            continue
          expect({ sel, actual }).toEqual({ sel, actual: expected })
        }
      }
    })
  }

  it('keeps matching siblings of <html> when the container is <html>', () => {
    const doc = createDocument('<div class="x"></div><html><head></head><body><p class="b">p</p></body></html>')
    const container = doc.beastiesContainers[0]!
    for (const sel of ['.x ~ * .b', '.x + html .b', '.x ~ html .b', 'div ~ html .b', '.x + body .b']) {
      expect({ sel, actual: container.exists(sel) }).toEqual({ sel, actual: !!selectOne(sel, container) })
    }
    expect(container.exists('.x ~ * .b')).toBe(true)
  })

  it('sees DOM changes after the index is invalidated', () => {
    const doc = createDocument('<html><body><div class="a"><i class="b">x</i></div></body></html>')
    const container = doc.beastiesContainers[0]!
    expect(container.exists('.a .b')).toBe(true)
    container.querySelector('i').remove()
    invalidateSelectorIndex(container)
    expect(container.exists('.a .b')).toBe(false)
  })

  it('does not match elements removed since the index was built', () => {
    const doc = createDocument('<html><body><div class="a"><i class="b">x</i></div></body></html>')
    const container = doc.beastiesContainers[0]!
    expect(container.exists('.a .b')).toBe(true)
    container.querySelector('i').remove()
    // stale index entry, detached element: not reported
    expect(container.exists('div .b')).toBe(false)
  })
})

describe('stylesheet parse cache', () => {
  const CSS = '.a .b{color:red}.c{color:blue}.d{color:green}@media (min-width:1px){.a .e{top:0}}'
  const pages = [
    '<html><body><div class="a"><i class="b e">1</i></div></body></html>',
    '<html><body><p class="c d">2</p></body></html>',
    '<html><body><div class="a"><i class="b">1</i></div></body></html>',
    '<html><body><p class="c d">2</p></body></html>',
  ]

  function make(options: ConstructorParameters<typeof Beasties>[0]) {
    return new (class extends Beasties {
      async getCssAsset() { return CSS }
    })({ logLevel: 'silent', ...options })
  }
  const withLink = (h: string) => h.replace('<html>', '<html><head><link rel="stylesheet" href="/s.css"></head>')

  it('gives the same output as parsing every time, in any order', async () => {
    const cached = make({})
    const fresh = make({ stylesheetCacheSize: 0 })
    for (const page of pages) {
      expect(await cached.process(withLink(page))).toBe(await fresh.process(withLink(page)))
    }
  })

  it('parses a shared stylesheet once and never mutates the cached tree', async () => {
    const cached = make({})
    vi.mocked(parseStylesheet).mockClear()
    for (const page of pages) await cached.process(withLink(page))
    expect(parseStylesheet).toHaveBeenCalledTimes(1)
    const again = await cached.process(withLink(pages[0]!))
    expect(parseStylesheet).toHaveBeenCalledTimes(1)
    expect(again).toBe(await make({ stylesheetCacheSize: 0 }).process(withLink(pages[0]!)))
  })

  it('evicts beyond stylesheetCacheSize and re-parses', async () => {
    let css = '.a{color:red}'
    const b = new (class extends Beasties {
      async getCssAsset() { return css }
    })({ logLevel: 'silent', stylesheetCacheSize: 1 })
    const page = withLink(pages[0]!)
    vi.mocked(parseStylesheet).mockClear()
    await b.process(page)
    await b.process(page)
    expect(parseStylesheet).toHaveBeenCalledTimes(1)
    css = '.zzz{color:red}'
    await b.process(page)
    css = '.a{color:red}'
    await b.process(page)
    expect(parseStylesheet).toHaveBeenCalledTimes(3)
  })
})
