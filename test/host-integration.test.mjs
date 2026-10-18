import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('plugin apply registers proactive routes without throwing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-host-'))
  process.env.DSH_HOME = home
  const routes = []
  const handlers = new Map()
  const webServer = {
    register(route) { routes.push(route); return () => {} },
    tapIndex() { return () => {} },
  }
  const ctx = {
    webServer,
    get(name) {
      if (name === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'credentials') return { get: async () => null }
      if (name === 'sessionTitle') return { get: () => '' }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: '{"speak":true,"text":"好"}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return null
    },
    on(name, fn) { handlers.set(name, fn); return () => {} },
    effect(fn) { try { fn() } catch (err) {} return () => {} },
    logger: { info() {}, warn() {}, error() {} },
  }
  const root = {
    on() { return () => {} },
    effect(fn) { try { fn() } catch (err) {} return () => {} },
    inject(deps, cb) { cb(ctx); return () => {} },
  }
  const mod = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href + '?t=' + Date.now())
  assert.equal(typeof mod.default.apply, 'function')
  mod.default.apply(root)
  assert.ok(routes.some((r) => r.path === '/dsh-whale/proactive.json'))
  assert.ok(routes.some((r) => r.path === '/dsh-whale/proactive-events.json'))
  assert.ok(routes.some((r) => r.path === '/dsh-whale/proactive-test.json'))
  assert.ok(handlers.has('session/event'))
  fs.rmSync(home, { recursive: true, force: true })
})
