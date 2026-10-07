// Shared corpus loader: the site's built pages (read-only) with entry.css re-injected.
import fs from 'node:fs'
import path from 'node:path'

export const PUB = process.env.PUB || '/home/des/Documents/pro/com-vastdata-nuxt3/.output/public'
export const ENTRY_RE = /^entry\..*\.css$/

export function loadCorpus(limit) {
  const entry = fs.readdirSync(`${PUB}/_nuxt`).find(f => ENTRY_RE.test(f))
  const css = fs.readFileSync(`${PUB}/_nuxt/${entry}`, 'utf8')
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '_nuxt') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'index.html') files.push(p)
    }
  }
  walk(PUB)
  files.sort()
  const pages = files.slice(0, limit || files.length).map((f) => {
    let html = fs.readFileSync(f, 'utf8')
    // the built pages were already processed once: drop the deferred entry link and its inlined
    // style so the page looks like Nitro's pre-beasties render, then add the blocking link
    html = html.replace(/<link\b[^>]*href="\/_nuxt\/entry\.[^"]+\.css"[^>]*>/g, '')
    html = html.replace(/<style>[^<]*<\/style>/g, '')
    html = html.replace('</head>', `<link rel="stylesheet" href="/_nuxt/${entry}" crossorigin></head>`)
    return { name: path.relative(PUB, path.dirname(f)) || '/', html }
  })
  return { entry, css, pages }
}

// The site's options (server/plugins/critical-css.ts)
export const SITE_OPTIONS = {
  preload: 'media',
  reduceInlineStyles: false,
  mergeStylesheets: false,
  fonts: false,
  keyframes: 'critical',
  allowRules: [/\\['"]/],
  pruneSource: false,
  logLevel: 'silent',
}
