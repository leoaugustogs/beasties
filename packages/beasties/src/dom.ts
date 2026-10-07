/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import type { AttributeSelector, Selector } from 'css-what'

import type { ChildNode, Node, NodeWithChildren } from 'domhandler'
import type { Logger } from './util'

import { _compileUnsafe, selectAll, selectOne } from 'css-select'
import { parse as selectorParser } from 'css-what'
import render from 'dom-serializer'
import { Element, Text } from 'domhandler'
import { DomUtils, parseDocument } from 'htmlparser2'
import { version } from '../package.json'

type ParsedDocument = ReturnType<typeof parseDocument>

function buildCache(container: Node) {
  container._classCache = new Set()
  container._idCache = new Set()
  const queue = [container]

  while (queue.length) {
    const node = queue.shift()!

    if (node.hasAttribute?.('class')) {
      const classList = node.getAttribute('class').trim().split(' ')
      classList.forEach((cls) => {
        container._classCache!.add(cls)
      })
    }

    if (node.hasAttribute?.('id')) {
      const id = node.getAttribute('id').trim()
      container._idCache!.add(id)
    }

    if ('children' in node) {
      queue.push(...(node as NodeWithChildren).children.filter(child => child.type === 'tag'))
    }
  }
}

/**
 * Parse HTML into a mutable, serializable DOM Document.
 * The DOM implementation is an htmlparser2 DOM enhanced with basic DOM mutation methods.
 * @param html   HTML to parse into a Document instance
 */
export function createDocument(html: string, logger?: Logger): HTMLDocument {
  const document = parseDocument(html, { decodeEntities: false })

  extendDocument(document)

  // Extend Element.prototype with DOM manipulation methods. `htmlparser2` may
  // resolve a different copy of `domhandler` than we do, in which case parsed
  // nodes do not inherit from the `Element` imported here.
  const parsedPrototype = Object.getPrototypeOf(document.children.find(child => child.type === 'tag') ?? Element.prototype)
  extendElement(parsedPrototype, logger)
  if (parsedPrototype !== Element.prototype) {
    extendElement(Element.prototype, logger)
  }

  // Beasties containers are the viewport to evaluate critical CSS.
  let beastiesContainers: (Node | HTMLDocument)[] = document.querySelectorAll('[data-beasties-container]') as Node[]

  if (!beastiesContainers.length) {
    document.documentElement?.setAttribute('data-beasties-container', '')
    beastiesContainers = [document.documentElement || document]
  }

  document.beastiesContainers = beastiesContainers
  for (const container of beastiesContainers) {
    buildCache(container)
  }

  return document
}

/**
 * Serialize a Document to an HTML String
 */
export function serializeDocument(document: HTMLDocument): string {
  return render(document, { decodeEntities: false })
}

declare module 'domhandler' {
  interface Node {
    nodeName: string
    id: string
    className: string
    insertBefore: (child: ChildNode, referenceNode: ChildNode | null) => ChildNode
    appendChild: (child: ChildNode) => ChildNode
    removeChild: (child: ChildNode) => void
    remove: () => void
    textContent: string
    setAttribute: (name: string, value: string) => void
    removeAttribute: (name: string) => void
    getAttribute: (name: string) => string
    hasAttribute: (name: string) => boolean
    getAttributeNode: (name: string) => undefined | { specified: true, value: string }
    exists: (sel: string) => boolean
    querySelector: (sel: string) => Node
    querySelectorAll: (sel: string) => Node[]
    // internal properties
    $$external?: boolean
    $$name?: string
    $$reduce?: boolean
    $$links?: ChildNode[]
    _classCache?: Set<string>
    _idCache?: Set<string>
    _selectorIndex?: DocumentIndex
  }
}

/**
 * Methods and descriptors to mix into Element.prototype
 * @private
 */
const extendedMarker = Symbol.for('beasties.element-extended')

function extendElement(element: typeof Element.prototype, logger?: Logger) {
  // `Element.prototype` is shared with any other copy of beasties that resolves
  // the same `domhandler`, and the descriptors below are non-configurable, so a
  // second copy must not reapply them.
  const appliedVersion = (element as unknown as Record<symbol, unknown>)[extendedMarker]
    ?? (Object.hasOwn(element, 'nodeName') ? 'an older version' : undefined)

  if (typeof appliedVersion === 'string') {
    if (appliedVersion !== version) {
      logger?.warn?.(
        `Multiple versions of beasties are patching the same \`domhandler\` instance (${appliedVersion} applied it, ${version} loaded after). `
        + `Deduplicate beasties to a single version if you see unexpected DOM errors.`,
      )
    }
    return
  }

  Object.defineProperties(element, {
    nodeName: {
      get() {
        return this.tagName.toUpperCase()
      },
    },

    id: {
      get() {
        return this.getAttribute('id')
      },
      set(value) {
        this.setAttribute('id', value)
      },
    },

    className: {
      get() {
        return this.getAttribute('class')
      },
      set(value) {
        this.setAttribute('class', value)
      },
    },

    insertBefore: {
      value(child: ChildNode, referenceNode: ChildNode | null) {
        if (!referenceNode)
          return this.appendChild(child)
        DomUtils.prepend(referenceNode, child)
        return child
      },
    },

    appendChild: {
      value(child: ChildNode) {
        DomUtils.appendChild(this, child)
        return child
      },
    },

    removeChild: {
      value(child: ChildNode) {
        DomUtils.removeElement(child)
      },
    },

    remove: {
      value() {
        DomUtils.removeElement(this)
      },
    },

    textContent: {
      get() {
        return DomUtils.getText(this)
      },

      set(text) {
        this.children = []
        DomUtils.appendChild(this, new Text(text))
      },
    },

    setAttribute: {
      value(name: string, value: string) {
        this.attribs ??= {}
        value ??= ''
        this.attribs[name] = value
      },
    },

    removeAttribute: {
      value(name: string) {
        if (this.attribs != null) {
          delete this.attribs[name]
        }
      },
    },

    getAttribute: {
      value(name: string) {
        return this.attribs != null && this.attribs[name]
      },
    },

    hasAttribute: {
      value(name: string) {
        return this.attribs != null && this.attribs[name] != null
      },
    },

    getAttributeNode: {
      value(name: string) {
        const value = this.getAttribute(name)
        if (value != null)
          return { specified: true, value }
      },
    },

    exists: {
      value(sel: string) {
        return cachedQuerySelector(sel, this)
      },
    },

    querySelector: {
      value(sel: string) {
        return selectOne(sel, this)
      },
    },

    querySelectorAll: {
      value(sel: string) {
        return selectAll(sel, this)
      },
    },
  })

  Object.defineProperty(element, extendedMarker, { value: version, configurable: true })
}

export interface HTMLDocument extends ParsedDocument {
  nodeType: 9
  contentType: 'text/html'
  nodeName: '#document'
  documentElement?: HTMLDocument
  head: Element
  body: Element
  createElement: (name: string) => Element
  createTextNode: (text: string) => Text
  exists: (sel: string) => boolean
  querySelector: (sel: string) => Node
  querySelectorAll: (sel: string) => Node[]
  /**
   * @deprecated
   */
  beastiesContainer: HTMLDocument | Node
  beastiesContainers: (HTMLDocument | Node)[]
}

function extendDocument(document: ParsedDocument): asserts document is HTMLDocument {
  Object.defineProperties(document, {
    // document is just an Element in htmlparser2, giving it a nodeType of ELEMENT_NODE.
    // TODO: verify if these are needed for css-select
    nodeType: {
      get() {
        return 9
      },
    },

    contentType: {
      get() {
        return 'text/html'
      },
    },

    nodeName: {
      get() {
        return '#document'
      },
    },

    documentElement: {
      get() {
        // Find the first <html> element within the document
        return (this as NodeWithChildren).children.find(
          child => 'tagName' in child && String(child.tagName).toLowerCase() === 'html',
        )
      },
    },

    head: {
      get() {
        return this.querySelector('head')
      },
    },

    body: {
      get() {
        return this.querySelector('body')
      },
    },

    createElement: {
      value(name: string) {
        return new Element(name, {})
      },
    },

    createTextNode: {
      value(text: string) {
        // there is no dedicated createTextNode equivalent exposed in htmlparser2's DOM
        return new Text(text)
      },
    },

    exists: {
      value(sel: string) {
        return cachedQuerySelector(sel, this)
      },
    },

    querySelector: {
      value(sel: string) {
        return selectOne(sel, this)
      },
    },

    querySelectorAll: {
      value(sel: string) {
        if (sel === ':root') {
          return this
        }
        return selectAll(sel, this)
      },
    },

    beastiesContainer: {
      get() {
        return this.beastiesContainers?.[0]
      },
    },
  })
}

// TODO: we sould probable move this case as part of the class
// so that it's disposed with it.
const selectorTokensCache = new Map<string, null | AttributeSelector[]>()

function cachedQuerySelector(sel: string, node: Node) {
  let selectorTokens = selectorTokensCache.get(sel)
  if (selectorTokens === undefined) {
    selectorTokens = parseRelevantSelectors(sel)
    selectorTokensCache.set(sel, selectorTokens)
  }

  if (selectorTokens && node._classCache && node._idCache) {
    for (const token of selectorTokens) {
      if (token.name === 'class' && !node._classCache.has(token.value)) {
        return false
      }
      if (token.name === 'id' && !node._idCache.has(token.value)) {
        return false
      }
    }
    return true
  }

  return fastSelectorExists(sel, node)
}

// ---------------------------------------------------------------------------
// Indexed matching for selectors the class/id cache above cannot answer.
//
// `selectOne(sel, container)` walks every element of the document for every selector. Tailwind
// style sheets have thousands of descendant selectors (`.group .group-hover\:x`), so that walk
// dominated processing time. Instead the right-most compound of the selector is looked up in a
// per-document class/id index, and the compiled selector (compiled once, shared by all documents)
// is only run on those candidates. The answer is the same as selectOne's: the index holds exactly
// the elements selectOne would visit (descendants of the container, skipping <template> contents),
// and every candidate is still checked by css-select itself.
// ---------------------------------------------------------------------------

interface SelectorPlan {
  /** relative to a container that is nested in another element (`:scope sel`) */
  test: (element: any) => boolean
  /** for a container whose parent is not an element, i.e. <html>: unscoped, ancestors count */
  testUnscoped: (element: any) => boolean
  /** classes/ids (positive, top-level) anywhere in the selector: all must exist in the document */
  classes: string[]
  ids: string[]
  /** classes/ids of the right-most compound, used to pick candidates */
  lastClasses: string[]
  lastIds: string[]
}

interface DocumentIndex {
  classes: Map<string, any[]>
  ids: Map<string, any[]>
  /** classes/ids of the container and its ancestors, which an unscoped selector can match too */
  outerClasses: Set<string>
  outerIds: Set<string>
}

const WHITESPACE_SPLIT_RE = /\s+/
const EMPTY: any[] = []

// `selectOne(sel, container)` compiles `sel` relative to the container (as `:scope sel`), so a
// match chain has to lie strictly inside it. The shared compiled selectors get the same scoping
// through a stand-in context element that `equals` resolves to the container being queried.
const SCOPE_STAND_IN = new Element('scope-stand-in', {})
SCOPE_STAND_IN.parent = new Element('scope-stand-in-parent', {}) as any
let currentContainer: Node | undefined
const planOptions = {
  equals: (a: Node, b: Node) => (a === SCOPE_STAND_IN ? b === currentContainer : a === b),
}

const selectorPlanCache = new Map<string, SelectorPlan | null>()
const TRAVERSALS = new Set(['descendant', 'child', 'sibling', 'adjacent'])

function planSelector(sel: string): SelectorPlan | null {
  let groups: Selector[][]
  let test: SelectorPlan['test']
  let testUnscoped: SelectorPlan['test']
  try {
    groups = selectorParser(sel)
    // same compilation `selectOne(sel, node)` performs; errors are left for selectOne to throw
    // compileToken rewrites the tokens it is given (scoping), so it gets its own parse
    test = _compileUnsafe<any, any>(selectorParser(sel), { ...planOptions }, SCOPE_STAND_IN) as SelectorPlan['test']
    testUnscoped = _compileUnsafe<any, any>(selectorParser(sel), { ...planOptions }) as SelectorPlan['test']
  }
  catch {
    return null
  }
  // comma lists, leading combinators (relative to the context) and pseudos keep the generic path
  if (groups.length !== 1)
    return null
  const tokens = groups[0]!
  if (!tokens.length || TRAVERSALS.has(tokens[0]!.type))
    return null

  const plan: SelectorPlan = { test, testUnscoped, classes: [], ids: [], lastClasses: [], lastIds: [] }
  for (const token of tokens) {
    if (TRAVERSALS.has(token.type)) {
      plan.lastClasses = []
      plan.lastIds = []
    }
    else if (token.type === 'attribute') {
      if (token.name === 'class' && token.action === 'element' && token.namespace == null) {
        plan.classes.push(token.value)
        plan.lastClasses.push(token.value)
      }
      else if (token.name === 'id' && token.action === 'equals' && token.namespace == null) {
        plan.ids.push(token.value)
        plan.lastIds.push(token.value)
      }
    }
    else if (token.type !== 'tag' && token.type !== 'universal') {
      return null
    }
  }
  return plan
}

function buildIndex(container: Node): DocumentIndex {
  const index: DocumentIndex = { classes: new Map(), ids: new Map(), outerClasses: new Set(), outerIds: new Set() }
  for (let outer: any = container; outer; outer = outer.parent) {
    if (outer.attribs?.class) {
      for (const cls of outer.attribs.class.split(WHITESPACE_SPLIT_RE)) index.outerClasses.add(cls)
    }
    if (outer.attribs?.id != null)
      index.outerIds.add(outer.attribs.id)
  }
  // same traversal as css-select's findOne: children of the container, not entering <template>
  const stack: any[][] = [(container as any).children]
  const positions = [0]
  while (stack.length) {
    const top = stack.length - 1
    const list = stack[top]!
    if (positions[top]! >= list.length) {
      stack.pop()
      positions.pop()
      continue
    }
    const element = list[positions[top]!++]
    if (element.type !== 'tag' && element.type !== 'script' && element.type !== 'style')
      continue
    const attribs = element.attribs
    if (attribs) {
      if (attribs.class) {
        for (const cls of attribs.class.split(WHITESPACE_SPLIT_RE)) {
          if (cls) {
            const bucket = index.classes.get(cls)
            if (!bucket)
              index.classes.set(cls, [element])
            else if (bucket[bucket.length - 1] !== element)
              bucket.push(element)
          }
        }
      }
      if (attribs.id != null) {
        const bucket = index.ids.get(attribs.id)
        if (!bucket)
          index.ids.set(attribs.id, [element])
        else
          bucket.push(element)
      }
    }
    if (element.name !== 'template' && element.children?.length) {
      stack.push(element.children)
      positions.push(0)
    }
  }
  return index
}

function isInside(element: any, container: Node): boolean {
  for (let parent = element.parent; parent; parent = parent.parent) {
    if (parent === container)
      return true
  }
  return false
}

/** Drop the per-document index; the DOM may have changed since it was built. */
export function invalidateSelectorIndex(container: Node): void {
  container._selectorIndex = undefined
}

function fastSelectorExists(sel: string, node: Node): boolean {
  let plan = selectorPlanCache.get(sel)
  if (plan === undefined) {
    plan = planSelector(sel)
    selectorPlanCache.set(sel, plan)
  }
  if (!plan || node.type !== 'tag')
    return !!selectOne(sel, node)

  // css-select scopes a selector to its context element only when that element has an element
  // parent (so for a nested data-beasties-container, not for <html>)
  const scoped = !!node.parent && (node.parent.type === 'tag' || node.parent.type === 'script' || node.parent.type === 'style')
  const test = scoped ? plan.test : plan.testUnscoped
  currentContainer = node
  const index = (node._selectorIndex ??= buildIndex(node))
  for (const cls of plan.classes) {
    if (!index.classes.has(cls) && (scoped || !index.outerClasses.has(cls)))
      return false
  }
  for (const id of plan.ids) {
    if (!index.ids.has(id) && (scoped || !index.outerIds.has(id)))
      return false
  }

  let candidates: any[] | undefined
  for (const cls of plan.lastClasses) {
    const list = index.classes.get(cls) ?? EMPTY
    if (!candidates || list.length < candidates.length)
      candidates = list
  }
  for (const id of plan.lastIds) {
    const list = index.ids.get(id) ?? EMPTY
    if (!candidates || list.length < candidates.length)
      candidates = list
  }

  if (!candidates)
    return !!selectOne(test as any, node)

  for (const element of candidates) {
    if (test(element) && isInside(element, node))
      return true
  }
  return false
}

function parseRelevantSelectors(sel: string): AttributeSelector[] | null {
  const tokens = selectorParser(sel)
  const relevantTokens: AttributeSelector[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tokenGroup = tokens[i]
    if (tokenGroup?.length !== 1) {
      return null
    }

    const token = tokenGroup[0]
    if (token?.type === 'attribute' && (token.name === 'class' || token.name === 'id')) {
      relevantTokens.push(token)
    }
  }

  return relevantTokens.length > 0 ? relevantTokens : null
}
