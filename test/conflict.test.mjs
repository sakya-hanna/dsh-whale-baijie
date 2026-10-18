import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProactiveService } from '../lib/proactive.mjs'
import { createInteractiveService } from '../lib/interactive.mjs'

function gate() {
  let until = 0
  let kind = ''
  return {
    isBusy: () => Date.now() < until,
    acquire: (k, ttl) => {
      if (Date.now() < until) return false
      until = Date.now() + Math.max(1000, ttl)
      kind = k
      return true
    },
    release: () => { until = 0; kind = '' },
    state: () => ({ kind, until }),
  }
}

function ctx() {
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) }
      if (name === 'llm') {
        return {
          async *stream(opts) {
            const isInteractive = String(opts.system || '').includes('两选一')
            yield {
              type: 'text-delta',
              text: isInteractive
                ? '{"prompt":"闲聊问题","options":[{"label":"甲甲","reply":"甲回复甲回复"},{"label":"乙乙","reply":"乙回复乙回复"}]}'
                : '{"speak":true,"text":"评论一句","emotion":"calm"}',
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return null
    },
  }
}

function proactiveService(g, dir) {
  return createProactiveService({
    ctx: ctx(), dataDir: dir, log: () => {}, now: () => 1000000, random: () => 0,
    isOccupied: () => g.isBusy(),
    onShown: (kind, ttl) => g.acquire(kind, ttl),
    onRelease: () => g.release(),
  })
}

function interactiveService(g, dir) {
  const timers = []
  const s = createInteractiveService({
    ctx: ctx(), dataDir: dir, log: () => {}, now: () => 1000000, random: () => 0,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeoutFn: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
    isOccupied: () => g.isBusy(),
    onShown: (kind, ttl) => g.acquire(kind, ttl),
    onRelease: () => g.release(),
    isWaitPending: () => false,
  })
  s._dir = dir
  s._timers = timers
  return s
}

function pushTurn(service) {
  const session = { id: 's1', header: {} }
  service.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  service.handleEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我做一件事，做完告诉我。' }] } })
  service.handleEvent(session, { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content: [{ type: 'text', text: '已经做完了，改动了两个文件。' }] } } })
  service.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

function fireInteractive(s) {
  s.updateConfig({ enabled: true, llmProbability: 0, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 5, windowHours: 1 })
  s.updateItems([{ prompt: '固定问题', options: [{ label: '甲甲', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] }])
  s.presence(true)
  s.start()
  const t = s._timers.find((x) => x.fn)
  if (!t) throw new Error('no timer')
  t.fn()
}

test('interactive first blocks the turn-end comment', async () => {
  const g = gate()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-conflict-'))
  const inter = interactiveService(g, dir)
  fireInteractive(inter)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(inter._state.events.length, 1)
  const pro = proactiveService(g, dir)
  pro.updateConfig({ enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(pro)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(pro._state.events.length, 0)
  assert.ok(pro._state.recent.some((r) => r.reason === 'occupied'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('comment first blocks the random interactive trigger', async () => {
  const g = gate()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-conflict-'))
  const pro = proactiveService(g, dir)
  pro.updateConfig({ enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(pro)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(pro._state.events.length, 1)
  const inter = interactiveService(g, dir)
  fireInteractive(inter)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(inter._state.events.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
