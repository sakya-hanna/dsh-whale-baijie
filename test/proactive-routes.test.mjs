import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createProactiveService } from '../lib/proactive.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-proactive-routes-'))
}

function fakeCtx(text) {
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return null
    },
  }
}

function fakeReq(method, url, body) {
  const req = body == null ? Readable.from([]) : Readable.from([body])
  req.method = method
  req.url = url
  return req
}

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body += chunk == null ? '' : String(chunk) },
  }
  return res
}

function findRoute(service, pathname) {
  return service.routes().find((r) => r.path === pathname)
}

test('GET config returns defaults and stats', async () => {
  const dir = tmpDir()
  const service = createProactiveService({ ctx: fakeCtx('{"speak":true,"text":"好"}'), dataDir: dir, setTimeoutFn: (fn) => queueMicrotask(fn) })
  const route = findRoute(service, '/dsh-whale/proactive.json')
  const res = fakeRes()
  await route.handler(fakeReq('GET', '/dsh-whale/proactive.json'), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.config.probability, 0.25)
  assert.equal(payload.defaults.probability, 0.25)
  assert.ok(payload.stats)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('PUT config persists normalized values', async () => {
  const dir = tmpDir()
  const service = createProactiveService({ ctx: fakeCtx('{"speak":true,"text":"好"}'), dataDir: dir, setTimeoutFn: (fn) => queueMicrotask(fn) })
  const route = findRoute(service, '/dsh-whale/proactive.json')
  const res = fakeRes()
  await route.handler(fakeReq('PUT', '/dsh-whale/proactive.json', JSON.stringify({ config: { enabled: true, probability: 2 } })), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.config.enabled, true)
  assert.equal(payload.config.probability, 1)
  const disk = JSON.parse(fs.readFileSync(path.join(dir, '.dshw-proactive.json'), 'utf8'))
  assert.equal(disk.config.probability, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('events route returns new events after since', async () => {
  const dir = tmpDir()
  const service = createProactiveService({
    ctx: fakeCtx('{"speak":true,"text":"欸嘿嘿，弟弟辛苦啦～"}'),
    dataDir: dir,
    setTimeoutFn: (fn) => queueMicrotask(fn),
    random: () => 0,
  })
  service.updateConfig({ enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  const session = { id: 's1', header: {} }
  service.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  service.handleEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做完了吗？' }] } })
  service.handleEvent(session, { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content: [{ type: 'text', text: '做完了。' }] } } })
  service.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))

  const route = findRoute(service, '/dsh-whale/proactive-events.json')
  const res = fakeRes()
  await route.handler(fakeReq('GET', '/dsh-whale/proactive-events.json?since=0'), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.events.length, 1)
  assert.equal(payload.events[0].text, '欸嘿嘿，弟弟辛苦啦～')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('test route returns generated text without consuming cooldown', async () => {
  const dir = tmpDir()
  const service = createProactiveService({
    ctx: fakeCtx('{"speak":true,"text":"姐姐在这儿呢","emotion":"calm"}'),
    dataDir: dir,
    setTimeoutFn: (fn) => queueMicrotask(fn),
  })
  const route = findRoute(service, '/dsh-whale/proactive-test.json')
  const res = fakeRes()
  await route.handler(fakeReq('POST', '/dsh-whale/proactive-test.json', JSON.stringify({ config: { enabled: true, probability: 1 } })), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.text, '姐姐在这儿呢')
  assert.equal(service._state.shownAt.length, 0)
  assert.equal(service._state.events.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
