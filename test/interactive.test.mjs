import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  interactiveDefaults, normalizeConfig, normalizeItem, validateLlmOutput,
  createInteractiveService,
} from '../lib/interactive.mjs'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-interactive-')) }

function fakeCtx(reply, selection = { provider: 'deepseek', model: 'deepseek-flash' }) {
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      if (name === 'llm') {
        return {
          async *stream() {
            const text = typeof reply === 'function' ? reply() : reply
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return null
    },
  }
}

function makeService(opts = {}) {
  const dir = tmpDir()
  const timers = []
  const service = createInteractiveService(Object.assign({
    ctx: fakeCtx('{"prompt":"测试问题","options":[{"label":"甲甲","reply":"甲回复甲回复"},{"label":"乙乙","reply":"乙回复乙回复"}]}'),
    dataDir: dir,
    log: () => {},
    now: () => opts.now || 1000000,
    random: () => 0,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeoutFn: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
    isOccupied: () => !!opts.occupied,
    onShown: () => opts.onShown === false ? false : true,
    isWaitPending: () => false,
  }, opts))
  service._dir = dir
  service._timers = timers
  return service
}

test('config and item validation', () => {
  const d = interactiveDefaults()
  assert.equal(d.llmProbability, 0.5)
  const c = normalizeConfig({ llmProbability: 2, randomMinMinutes: 90, randomMaxMinutes: 10, maxPerWindow: 0 })
  assert.equal(c.llmProbability, 1)
  assert.equal(c.randomMinMinutes, 90)
  assert.equal(c.randomMaxMinutes, 90)
  assert.equal(c.maxPerWindow, 1)

  const good = normalizeItem({ prompt: '问一句', options: [{ label: '甲甲', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] })
  assert.equal(good.ok, true)
  const bad = normalizeItem({ prompt: '问一句', options: [{ label: '甲甲', reply: '甲回复甲回复' }] })
  assert.equal(bad.ok, false)
  const three = normalizeItem({ prompt: '问一句', options: [
    { label: '甲甲', reply: '甲回复甲回复' },
    { label: '乙乙', reply: '乙回复乙回复' },
    { label: '丙丙', reply: '丙回复丙回复' },
  ] })
  assert.equal(three.ok, false)
})

test('LLM output must have exactly two options', () => {
  const ok = validateLlmOutput('{"prompt":"问一句","options":[{"label":"甲甲","reply":"甲回复甲回复"},{"label":"乙乙","reply":"乙回复乙回复"}]}')
  assert.equal(ok.ok, true)
  assert.equal(ok.item.options.length, 2)
  const bad = validateLlmOutput('{"prompt":"问一句","options":[{"label":"甲甲","reply":"甲回复甲回复"}]}')
  assert.equal(bad.ok, false)
  const three = validateLlmOutput('{"prompt":"问一句","options":[{"label":"甲甲","reply":"甲回复甲回复"},{"label":"乙乙","reply":"乙回复乙回复"},{"label":"丙丙","reply":"丙回复丙回复"}]}')
  assert.equal(three.ok, false)
})

test('scheduler publishes a fixed item with two options', async () => {
  const service = makeService()
  service.updateConfig({ enabled: true, llmProbability: 0, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 5, windowHours: 1 })
  service.updateItems([{ prompt: '固定问题', options: [{ label: '甲甲', label2: '', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] }].map((x) => ({ prompt: x.prompt, options: x.options.map((o) => ({ label: o.label, reply: o.reply })) })))
  service.presence(true)
  service.start()
  const first = service._timers.find((t) => t.fn)
  assert.ok(first)
  first.fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(service._state.events.length, 1)
  assert.equal(service._state.events[0].source, 'fixed')
  assert.equal(service._state.events[0].options.length, 2)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('manual trigger uses the same source picker and publishes', async () => {
  const service = makeService()
  service.updateConfig({ enabled: true, llmProbability: 0, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 5, windowHours: 1 })
  service.updateItems([{ prompt: '固定问题', options: [{ label: '甲甲', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] }])
  const r = await service.triggerNow()
  assert.equal(r.ok, true)
  assert.equal(r.event.source, 'fixed')
  assert.equal(r.event.options.length, 2)
  assert.equal(service._state.triggers.length, 0) // 手动「试一个」不占自动窗口次数
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('window cap blocks a second trigger and reschedules', async () => {
  const service = makeService()
  service.updateConfig({ enabled: true, llmProbability: 0, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 1, windowHours: 1 })
  service.updateItems([{ prompt: '固定问题', options: [{ label: '甲甲', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] }])
  service.presence(true)
  service.start()
  service._timers.find((t) => t.fn).fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(service._state.events.length, 1)
  const second = service._timers.filter((t) => t.fn).pop()
  assert.ok(second)
  second.fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(service._state.events.length, 1)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('occupied gate drops the trigger', async () => {
  const service = makeService({ occupied: true })
  service.updateConfig({ enabled: true, llmProbability: 0, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 5, windowHours: 1 })
  service.updateItems([{ prompt: '固定问题', options: [{ label: '甲甲', reply: '甲回复甲回复' }, { label: '乙乙', reply: '乙回复乙回复' }] }])
  service.presence(true)
  service.start()
  const first = service._timers.find((t) => t.fn)
  first.fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(service._state.events.length, 0)
  assert.ok(service._state.history.some((h) => h.reason === 'occupied'))
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('LLM mode publishes generated item and choice records reply', async () => {
  const service = makeService()
  service.updateConfig({ enabled: true, llmProbability: 1, minGapMinutes: 1, randomMinMinutes: 1, randomMaxMinutes: 1, maxPerWindow: 5, windowHours: 1 })
  service.presence(true)
  service.start()
  service._timers.find((t) => t.fn).fn()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(service._state.events.length, 1)
  const ev = service._state.events[0]
  assert.equal(ev.source, 'llm')
  assert.equal(ev.options.length, 2)
  const chosen = service.choose(ev.id, 0)
  assert.equal(chosen.ok, true)
  assert.equal(chosen.reply, '甲回复甲回复')
  assert.equal(service._state.stats.answered, 1)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

