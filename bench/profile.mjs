import Beasties from '../packages/beasties/dist/index.mjs'
import { loadCorpus, SITE_OPTIONS } from './common.mjs'
const { entry, css, pages } = loadCorpus(Number(process.argv[2] || 60))
class B extends Beasties {
  async getCssAsset(href) { return href.includes('entry.') ? css : undefined }
  getAffectedStyleTags(d) { return [...d.querySelectorAll('style')].filter(s => s.$$external || s.hasAttribute('data-component-css')) }
}
const b = new B(SITE_OPTIONS)
const t = performance.now()
for (const p of pages) await b.process(p.html)
console.log(pages.length, 'pages', ((performance.now() - t) / pages.length).toFixed(0), 'ms/page')
