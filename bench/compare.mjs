// Equivalence + timing on the site's built pages.
//   node bench/compare.mjs [--pool N] [--limit N] [--upstream <path to beasties dist/index.mjs>]
// Runs upstream beasties (default: the 0.5.4 installed in the nuxt site) and this fork on every
// page, asserts byte-identical output, prints total and per-page timings.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { loadCorpus, SITE_OPTIONS } from './common.mjs'

const args = process.argv.slice(2)
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const limit = Number(arg('--limit', 0)) || undefined
const poolSize = Number(arg('--pool', 0))
const upstreamPath = arg('--upstream', createRequire('/home/des/Documents/pro/com-vastdata-nuxt3/package.json').resolve('beasties'))

const { entry, css, pages } = loadCorpus(limit)
const sha = s => crypto.createHash('sha1').update(s).digest('hex')
const siteLike = Base => class extends Base {
  async getCssAsset(href) { return href.includes('entry.') ? css : undefined }
  getAffectedStyleTags(d) { return [...d.querySelectorAll('style')].filter(s => s.$$external || s.hasAttribute('data-component-css')) }
}

async function runSerial(Base) {
  const b = new (siteLike(Base))(SITE_OPTIONS)
  const out = []; const times = []
  const t0 = performance.now()
  for (const p of pages) { const t = performance.now(); out.push(await b.process(p.html)); times.push(performance.now() - t) }
  return { out, total: performance.now() - t0, times }
}

const up = (await import(upstreamPath)).default
const fork = (await import('../packages/beasties/dist/index.mjs')).default
const results = {}
console.log(`${pages.length} pages, entry.css ${(css.length / 1024).toFixed(0)} KB, upstream ${upstreamPath}`)
const cacheFile = arg('--cache')   // reuse upstream's output/timings from an earlier run (same corpus)
const cacheKey = sha(upstreamPath + css + pages.map(p => p.html).join(''))
const cached = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null
if (cached?.key === cacheKey) { results.upstream = cached.result; console.log('upstream: from cache', cacheFile) }
else {
  results.upstream = await runSerial(up)
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, result: results.upstream }))
}
results.fork = await runSerial(fork)

if (poolSize) {
  const { BeastiesPool } = await import('../packages/beasties/dist/pool.mjs')
  const pool = new BeastiesPool({
    workers: poolSize,
    options: SITE_OPTIONS,
    additionalStyleSelector: 'style[data-component-css]',
    resolveCss: async href => (href.includes('entry.') ? css : undefined),
  })
  await pool.ready()
  // 32 in flight, like Nitro's prerender concurrency
  const out = new Array(pages.length); const times = new Array(pages.length)
  let next = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < pages.length) {
      const i = next++
      const t = performance.now(); out[i] = await pool.process(pages[i].html); times[i] = performance.now() - t
    }
  }))
  results[`pool(${poolSize})`] = { out, total: performance.now() - t0, times }
  await pool.close()
}

const ref = results.upstream.out
let ok = true
for (const [name, r] of Object.entries(results)) {
  if (name === 'upstream') continue
  const diffs = pages.filter((p, i) => r.out[i] !== ref[i]).map(p => p.name)
  console.log(`${name}: ${pages.length - diffs.length}/${pages.length} identical, ${diffs.length} diffs`, diffs.slice(0, 5))
  if (diffs.length) ok = false
}
const outBytes = ref.reduce((a, s) => a + s.length, 0)
console.log(`output sha1 ${sha(ref.join('\n'))} (${(outBytes / 1e6).toFixed(1)} MB)`)
console.log('\nvariant'.padEnd(12), 'total s'.padStart(9), 'ms/page'.padStart(9), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8))
for (const [name, r] of Object.entries(results)) {
  const s = [...r.times].sort((a, b) => a - b)
  console.log(name.padEnd(12), (r.total / 1000).toFixed(2).padStart(9), (r.total / pages.length).toFixed(1).padStart(9), s[s.length >> 1].toFixed(1).padStart(8), s[Math.floor(s.length * .95)].toFixed(1).padStart(8))
}
process.exit(ok ? 0 : 1)
