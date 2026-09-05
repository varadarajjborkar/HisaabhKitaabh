/**
 * Module resolution hook for the test runner.
 *
 * The app is bundled by Next, which resolves extensionless imports and the "@/"
 * alias. Node's ESM loader does neither, so the hook supplies both - that way
 * the tests exercise the real source files rather than a copy adapted to suit
 * the runner.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = resolvePath(fileURLToPath(import.meta.url), '../..')
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts']

export function resolve(specifier, context, next) {
  let spec = specifier

  if (spec.startsWith('@/')) {
    spec = pathToFileURL(resolvePath(ROOT, 'src', spec.slice(2))).href
  } else if (spec.startsWith('.') && context.parentURL) {
    spec = new URL(spec, context.parentURL).href
  } else {
    return next(specifier, context)
  }

  if (!/\.[a-z]+$/.test(spec)) {
    for (const ext of EXTENSIONS) {
      const candidate = spec + ext
      if (existsSync(fileURLToPath(candidate))) return next(candidate, context)
    }
  }
  return next(spec, context)
}
