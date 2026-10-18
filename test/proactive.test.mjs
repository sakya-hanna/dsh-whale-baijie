import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  proactiveDefaults, normalizeConfig, maskSensitive, truncateChars,
  summarizeToolArgs, similarity, cleanBubbleText, parseModelOutput,
  isQuietNow, composeUserPrompt, createProactiveService,
} from '../lib/proactive.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-proactive-'))
}

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
  const service = createProactiveService(Object.assign({
    ctx: fakeCtx('{"speak":true,"text":"欸嘿嘿，弟弟辛苦啦～","emotion":"happy"}'),
    dataDir: dir,
    log: () => {},
    now: () => opts.now || 1000000,
    random: () => 0,
    setTimeoutFn: (fn) => { queueMicrotask(fn) },
  }, opts))
  service._dir = dir
  return service
}

function pushTurn(service, { user = '帮我把这个功能做出来，先调研一下开源项目。', assistant = '我先看了几个项目，然后把宿主侧的触发链接上了。', tool = true } = {}) {
  const session = { id: 's1', header: {} }
  service.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  service.handleEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } })
  if (tool) service.handleEvent(session, { type: 'tool/call', data: { name: 'web_search', arguments: '{"query":"AstrBot meme_manager"}' } })
  service.handleEvent(session, { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content: [{ type: 'text', text: assistant }] } } })
  service.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('defaults and normalizeConfig clamp values', () => {
  const d = proactiveDefaults()
  assert.equal(d.probability, 0.25)
  assert.equal(d.mode, 'review')
  const n = normalizeConfig({
    probability: 9, mode: 'always', minIntervalSec: -1, maxPerHour: 999,
    model: { mode: 'fixed', provider: 'p', model: 'm', timeoutMs: 1, maxTokens: 9999 },
    quietHours: { enabled: true, start: '9:05', end: '25:00' },
  })
  assert.equal(n.probability, 1)
  assert.equal(n.mode, 'always')
  assert.equal(n.minIntervalSec, 0)
  assert.equal(n.maxPerHour, 120)
  assert.equal(n.model.timeoutMs, 3000)
  assert.equal(n.model.maxTokens, 800)
  assert.equal(n.quietHours.start, '09:05')
  // '25:00' 不是合法时钟 ⇒ 回落到默认的 08:00，而不是写进配置。
  assert.equal(n.quietHours.end, '08:00')
})

test('maskSensitive hides keys and home paths', () => {
  const home = 'C:\\Users\\tester'
  const s = maskSensitive('key sk-abcdef123456 path ' + home + '\\project\\a.js', { home })
  assert.ok(s.includes('***'))
  assert.ok(s.includes('%USERPROFILE%'))
  assert.ok(!s.includes('sk-abcdef123456'))
})

test('truncateChars and tool args', () => {
  assert.equal(truncateChars('一二三四五', 3), '一二三')
  const a = summarizeToolArgs('read', '{"path":"C:\\\\x\\\\a.js","offset":1}')
  assert.ok(a.includes('path='))
  assert.ok(!a.includes('offset'))
})

test('cleanBubbleText strips markdown, urls, emoji and overlong text', () => {
  const s = cleanBubbleText('```text\n白姐：欸嘿嘿，弟弟辛苦啦 😊 https://example.com\n```')
  assert.equal(s, '欸嘿嘿，弟弟辛苦啦')
  const long = cleanBubbleText('这是一句很长的话。'.repeat(10), 40)
  assert.ok(Array.from(long).length <= 40)
})

test('parseModelOutput handles json, fences, decline and plain text', () => {
  const a = parseModelOutput('{"speak":true,"text":"欸嘿嘿","emotion":"shy"}')
  assert.equal(a.ok, true)
  assert.equal(a.text, '欸嘿嘿')
  assert.equal(a.emotion, 'shy')

  const b = parseModelOutput('```json\n{"speak":false,"text":""}\n```')
  assert.equal(b.ok, true)
  assert.equal(b.speak, false)

  const c = parseModelOutput('欸嘿嘿，弟弟今天也来啦～')
  assert.equal(c.ok, true)
  assert.equal(c.format, 'text')

  const d = parseModelOutput('{"speak":true,"text":""}')
  assert.equal(d.ok, false)
})

test('similarity catches near duplicates', () => {
  assert.ok(similarity('欸嘿嘿，弟弟辛苦啦～', '欸嘿嘿 弟弟辛苦啦') > 0.8)
  assert.ok(similarity('欸嘿嘿，弟弟辛苦啦～', '今天天气不错') < 0.3)
})

test('isQuietNow supports overnight windows', () => {
  const q = { enabled: true, start: '23:00', end: '08:00' }
  assert.equal(isQuietNow(q, new Date(2026, 9, 18, 23, 30)), true)
  assert.equal(isQuietNow(q, new Date(2026, 9, 18, 7, 59)), true)
  assert.equal(isQuietNow(q, new Date(2026, 9, 18, 8, 0)), false)
  assert.equal(isQuietNow(q, new Date(2026, 9, 18, 12, 0)), false)
})

test('composeUserPrompt fills placeholders and appends context when template has none', () => {
  const cfg = proactiveDefaults()
  const prompt = composeUserPrompt({
    userText: '弟弟的提问', assistantText: '助手的做法', tools: [{ name: 'read', args: 'path=a.js' }],
    tokens: 123, cost: 0.01, durationMs: 5000, sessionName: '测试',
  }, cfg)
  assert.ok(prompt.includes('弟弟的提问'))
  assert.ok(prompt.includes('read(path=a.js)'))
  assert.ok(prompt.includes('123'))

  const noPlaceholder = normalizeConfig({ prompt: { user: '只说一句话。' } })
  const p2 = composeUserPrompt({ userText: 'U', assistantText: 'A', tools: [] }, noPlaceholder)
  assert.ok(p2.includes('只说一句话。'))
  assert.ok(p2.includes('[弟弟说] U'))
})

test('service generates one event for a completed human turn', async () => {
  const service = makeService()
  service.updateConfig({ enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  const st = service._state
  assert.equal(st.events.length, 1)
  assert.equal(st.events[0].text, '欸嘿嘿，弟弟辛苦啦～')
  assert.equal(st.stats.shown, 1)
  const got = service.getEvents(0)
  assert.equal(got.events.length, 1)
  assert.equal(got.reset, false)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('review mode can decline without emitting a bubble', async () => {
  const service = makeService({ ctx: fakeCtx('{"speak":false,"text":""}') })
  service.updateConfig({ enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(service._state.events.length, 0)
  assert.equal(service._state.stats.declined, 1)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('always mode uses text even when speak is false', async () => {
  const service = makeService({ ctx: fakeCtx('{"speak":false,"text":"姐姐在这儿呢"}') })
  service.updateConfig({ enabled: true, probability: 1, mode: 'always', minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(service._state.events.length, 1)
  assert.equal(service._state.events[0].text, '姐姐在这儿呢')
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('min interval blocks a second bubble', async () => {
  let t = 1000000
  const service = makeService({ now: () => t })
  service.updateConfig({ enabled: true, probability: 1, minIntervalSec: 90, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0 })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  t += 1000
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(service._state.events.length, 1)
  assert.ok(service._state.recent.some((r) => r.reason === 'min-interval'))
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('voice slot blocks the bubble when synthesis is not ready', async () => {
  const service = makeService({ synthesize: async () => null })
  service.updateConfig({
    enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0,
    voice: { enabled: true, provider: 'local-test', waitForAudio: true },
  })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(service._state.events.length, 0)
  assert.equal(service._state.stats.failed, 1)
  fs.rmSync(service._dir, { recursive: true, force: true })
})

test('voice slot attaches fragment id when synthesis succeeds', async () => {
  const service = makeService({ synthesize: async () => ({ fragId: 'tts_1', mime: 'audio/wav' }) })
  service.updateConfig({
    enabled: true, probability: 1, minIntervalSec: 0, maxPerHour: 0, maxPerDay: 0, minTurnChars: 0,
    voice: { enabled: true, provider: 'local-test', waitForAudio: true },
  })
  pushTurn(service)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(service._state.events.length, 1)
  assert.equal(service._state.events[0].sound, 'frag:tts_1')
  fs.rmSync(service._dir, { recursive: true, force: true })
})
