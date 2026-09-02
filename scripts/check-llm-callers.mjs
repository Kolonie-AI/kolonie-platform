import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = 'scripts/llm-callers.json'
const CHAT = '/chat/completions'
const EMBEDDINGS = '/embeddings'
const ROUTE_HELPERS = new Set(['gatewayRoutedFetch', 'gatewayOnlyFetch'])
const IGNORED_CALLS = new Set(['endsWith', 'includes', 'startsWith'])

const normalize = (value) => value.replace(/\s+/g, '')
const keyOf = ({ file, symbol }) => `${file}:${symbol}`
const readerKey = ({ file, symbol, variable }) => `${file}:${symbol}:${variable}`

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

function symbolOf(node, sourceFile) {
  let nearestVariable
  let nearestMethod
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name !== undefined) return parent.name.text
    if (nearestVariable === undefined && ts.isVariableDeclaration(parent)) {
      nearestVariable = parent.name.getText(sourceFile)
    }
    if (
      nearestMethod === undefined &&
      (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) &&
      parent.name !== undefined
    ) {
      nearestMethod = parent.name.getText(sourceFile)
    }
  }
  return nearestVariable ?? nearestMethod ?? '<module>'
}

function routeSymbol(node, sourceFile) {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile)
    if (ts.isFunctionDeclaration(parent) && parent.name !== undefined) return parent.name.text
  }
  return '<module>'
}

function endpointOf(node, sourceFile, initializers) {
  const text = ts.isIdentifier(node)
    ? (initializers.get(node.text) ?? node.getText(sourceFile))
    : node.getText(sourceFile)
  if (text.includes(CHAT)) return CHAT
  if (text.includes(EMBEDDINGS)) return EMBEDDINGS
  return undefined
}

function processEnvironment(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'process' &&
    expression.name.text === 'env'
  )
}

function environmentVariable(node, sourceFile) {
  if (ts.isPropertyAccessExpression(node) && processEnvironment(node.expression)) {
    return node.name.text.includes('MODEL') ? node.name.text : undefined
  }
  if (!ts.isElementAccessExpression(node) || node.argumentExpression === undefined) return undefined
  const environment =
    processEnvironment(node.expression) ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'env')
  if (!environment) return undefined
  const argument = node.argumentExpression
  const variable = ts.isStringLiteralLike(argument)
    ? argument.text
    : normalize(argument.getText(sourceFile))
  return variable.includes('MODEL') ? variable : undefined
}

function sourceInventory(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const chatClients = new Map()
  const embeddingClients = new Map()
  const modelReaders = new Map()
  const routes = new Map()
  const initializers = new Map()

  function collectInitializers(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      initializers.set(node.name.text, node.initializer.getText(sourceFile))
    }
    ts.forEachChild(node, collectInitializers)
  }
  collectInitializers(sourceFile)

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const call = calledName(node.expression)
      const first = node.arguments[0]
      if (first !== undefined && !IGNORED_CALLS.has(call ?? '')) {
        const endpoint = endpointOf(first, sourceFile, initializers)
        if (endpoint === CHAT) {
          const entry = { file, symbol: symbolOf(node, sourceFile) }
          chatClients.set(keyOf(entry), entry)
        } else if (endpoint === EMBEDDINGS) {
          const entry = { file, symbol: symbolOf(node, sourceFile) }
          embeddingClients.set(keyOf(entry), entry)
        }
      }
      if (call !== undefined && ROUTE_HELPERS.has(call)) {
        const symbol = routeSymbol(node, sourceFile)
        const firstText = first?.getText(sourceFile) ?? ''
        const resolved = ts.isIdentifier(first)
          ? (initializers.get(first.text) ?? firstText)
          : firstText
        const entry = { file, symbol, helper: call, source: normalize(resolved) }
        routes.set(keyOf(entry), entry)
      }
    }

    const variable = environmentVariable(node, sourceFile)
    if (variable !== undefined) {
      const entry = { file, symbol: symbolOf(node, sourceFile), variable }
      modelReaders.set(readerKey(entry), entry)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { chatClients, embeddingClients, modelReaders, routes }
}

function entriesByKey(entries, key) {
  return new Map(entries.map((entry) => [key(entry), entry]))
}

function manifestSource(sources, file) {
  return sources[file]
}

export function auditSources(sources, manifest) {
  const actual = {
    chatClients: new Map(),
    embeddingClients: new Map(),
    modelReaders: new Map(),
    routes: new Map(),
  }
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    const inventory = sourceInventory(file, text)
    for (const name of Object.keys(actual)) {
      for (const [key, value] of inventory[name]) actual[name].set(key, value)
    }
  }

  const expectedChat = entriesByKey(manifest.chatClients, keyOf)
  const expectedEmbeddings = entriesByKey(manifest.embeddingClients, keyOf)
  const expectedReaders = entriesByKey(manifest.modelReaders, readerKey)
  const expectedRoutes = entriesByKey(manifest.routes, keyOf)
  const findings = []

  for (const [key, entry] of actual.chatClients) {
    if (!expectedChat.has(key)) findings.push(`unclassified chat client at ${keyOf(entry)}`)
  }
  for (const [key, entry] of expectedChat) {
    if (!actual.chatClients.has(key))
      findings.push(`manifested chat client is absent at ${keyOf(entry)}`)
    if (!Array.isArray(entry.routes) || entry.routes.length === 0) {
      findings.push(`chat client has no route at ${keyOf(entry)}`)
    } else {
      for (const route of entry.routes) {
        if (!manifest.routes.some((candidate) => candidate.id === route)) {
          findings.push(`chat client names an absent route at ${keyOf(entry)}`)
        }
      }
    }
  }

  for (const [key, entry] of actual.embeddingClients) {
    if (!expectedEmbeddings.has(key))
      findings.push(`unclassified embedding client at ${keyOf(entry)}`)
  }
  for (const [key, entry] of expectedEmbeddings) {
    if (!actual.embeddingClients.has(key)) {
      findings.push(`manifested embedding client is absent at ${keyOf(entry)}`)
    }
  }

  for (const [key, entry] of actual.modelReaders) {
    if (!expectedReaders.has(key)) {
      findings.push(`unclassified model environment reader at ${readerKey(entry)}`)
    }
  }
  for (const [key, entry] of expectedReaders) {
    if (!actual.modelReaders.has(key)) {
      findings.push(`manifested model environment reader is absent at ${readerKey(entry)}`)
      continue
    }
    const source = manifestSource(sources, entry.file) ?? ''
    if (entry.kind === 'chat-tier-resolver') {
      if (!source.includes('CapabilityTierSchema.safeParse') || !source.includes('SERVICE_TIERS')) {
        findings.push(`chat model reader is outside the typed tier resolver at ${readerKey(entry)}`)
      }
    } else if (entry.kind === 'embedding-only') {
      const client = entry.client ?? keyOf(entry)
      if (!expectedEmbeddings.has(client)) {
        findings.push(`embedding model reader names no embedding client at ${readerKey(entry)}`)
      }
    } else {
      findings.push(`model environment reader has no approved kind at ${readerKey(entry)}`)
    }
  }

  for (const [key, entry] of actual.routes) {
    if (!expectedRoutes.has(key)) findings.push(`unclassified route at ${keyOf(entry)}`)
  }
  for (const [key, entry] of expectedRoutes) {
    const route = actual.routes.get(key)
    const expectedHelper = entry.mode === 'primary-only' ? 'gatewayOnlyFetch' : 'gatewayRoutedFetch'
    if (route === undefined || route.helper !== entry.helper || entry.helper !== expectedHelper) {
      findings.push(`unmanaged route at ${keyOf(entry)}`)
      continue
    }
    if (entry.mode === 'primary-only') {
      const decision =
        entry.decision === undefined ? undefined : manifestSource(sources, entry.decision)
      if (decision === undefined || decision.trim() === '') {
        findings.push(`primary-only route has no decision record at ${keyOf(entry)}`)
      }
    } else if (entry.mode === 'primary-fallback') {
      const source = manifestSource(sources, entry.file) ?? ''
      if (!source.includes('gatewaysFromEnvironment')) {
        findings.push(`fallback route does not use the gateway pair at ${keyOf(entry)}`)
      }
    } else {
      findings.push(`route has no approved mode at ${keyOf(entry)}`)
    }
    if (entry.tier === 'tier-1' && !route.source.includes('TIER_1')) {
      findings.push(`vision route is not tier 1 at ${keyOf(entry)}`)
    }
  }

  return [...new Set(findings)].sort()
}

function ignored(file) {
  const parts = file.split('/')
  return (
    parts.includes('dist') ||
    parts.includes('__fixtures__') ||
    parts.includes('generated') ||
    /\.(test|spec|d)\.tsx?$/.test(file) ||
    /\.generated\.tsx?$/.test(file)
  )
}

async function sourceFiles(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) await walk(relative)
      else if (/\.tsx?$/.test(relative) && !ignored(relative)) files.push(relative)
    }
  }
  await walk('apps')
  await walk('packages')
  return files.sort()
}

export async function auditRoot(root = ROOT) {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'))
  const sources = {}
  for (const file of await sourceFiles(root))
    sources[file] = await readFile(path.join(root, file), 'utf8')
  for (const route of manifest.routes) {
    if (route.decision !== undefined && sources[route.decision] === undefined) {
      try {
        sources[route.decision] = await readFile(path.join(root, route.decision), 'utf8')
      } catch {
        sources[route.decision] = undefined
      }
    }
  }
  return auditSources(sources, manifest)
}

async function main() {
  const findings = await auditRoot()
  if (findings.length === 0) {
    console.log('LLM caller inventory is complete')
    return
  }
  for (const finding of findings) console.error(finding)
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
