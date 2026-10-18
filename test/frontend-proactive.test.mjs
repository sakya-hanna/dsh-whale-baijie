import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'whale-widget.js'), 'utf8')

function extract(name) {
  const idx = SRC.indexOf('function ' + name + '(')
  if (idx < 0) throw new Error('missing function ' + name)
  let i = SRC.indexOf('{', idx)
  let depth = 0
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(idx, i + 1) }
  }
  throw new Error('unbalanced ' + name)
}

function makeBubbleHarness() {
  const code = [
    'var bubbleOn = true',
    'var __pushed = []',
    'var __done = 0',
    'var __cleared = 0',
    'function whaleSysPush(item) { __pushed.push(item); return true }',
    'function whaleSysDone() { __done++ }',
    'function whaleSysSwapNext() { return false }',
    'function bubbleClearAll() { __cleared++ }',
    'function bubbleCloseVisual() {}',
    'var bubbleScene = null',
    'var bubbleShown = false',
    'var bubbleRandomActive = false',
    'var bubbleRandomLines = null',
    'var bubbleLiveMods = null',
    'var localStorage = (function(){ var m = {}; return { getItem: function(k){ return m[k] == null ? null : m[k] }, setItem: function(k,v){ m[k] = String(v) }, removeItem: function(k){ delete m[k] } } })()',
    extract('proactiveClaim'),
    extract('proactiveRelease'),
    extract('showProactiveBubble'),
    extract('hideProactiveBubble'),
    'return {',
    '  show: showProactiveBubble,',
    '  hide: hideProactiveBubble,',
    '  get pushed() { return __pushed },',
    '  get done() { return __done },',
    '  get cleared() { return __cleared },',
    '  set bubbleOn(v) { bubbleOn = v },',
    '};',
  ].join('\n')
  return new Function(code)()
}

test('showProactiveBubble queues a proactive item with rank after cost', () => {
  const h = makeBubbleHarness()
  const ok = h.show({ id: 1, text: '欸嘿嘿，弟弟辛苦啦～', ttlMs: 7000, emotion: 'happy' })
  assert.equal(ok, true)
  assert.equal(h.pushed.length, 1)
  assert.equal(h.pushed[0].kind, 'proactive')
  assert.equal(h.pushed[0].rank, 3.5)
  assert.equal(h.pushed[0].ttlMs, 7000)
  assert.equal(h.pushed[0].text, '欸嘿嘿，弟弟辛苦啦～')
})

test('same event id is not shown twice, other ids are', () => {
  const h = makeBubbleHarness()
  assert.equal(h.show({ id: 7, text: 'A' }), true)
  assert.equal(h.show({ id: 7, text: 'A' }), false)
  assert.equal(h.show({ id: 8, text: 'B' }), true)
  assert.equal(h.pushed.length, 2)
})

test('bubbleOn=false suppresses the bubble', () => {
  const h = makeBubbleHarness()
  h.bubbleOn = false
  assert.equal(h.show({ id: 1, text: 'A' }), false)
  assert.equal(h.pushed.length, 0)
})

test('hideProactiveBubble clears scene and advances the queue', () => {
  const h = makeBubbleHarness()
  h.hide()
  assert.equal(h.cleared, 1)
  assert.equal(h.done, 1)
})

test('whaleSysOpenItem renders a proactive scene with its ttl', () => {
  const code = [
    'var whaleSysItem = null',
    'var captured = null',
    'function sceneOpen(kind, fn, ttl) { captured = { kind, fn, ttl }; try { fn() } catch (e) {} }',
    'function bubbleRenderCostMods() {}',
    'function bubbleRenderWaitMods() {}',
    'var bubbleRenderModules = function (mods) { captured.mods = mods }',
    'var turnCostCloseMs = 5000',
    'var USAGE_ALERT_TTL = 6500',
    extract('whaleSysOpenItem'),
    'return { open: whaleSysOpenItem, get captured() { return captured } }',
  ].join('\n')
  const h = new Function(code)()
  h.open({ kind: 'proactive', text: '欸嘿嘿', ttlMs: 9000 })
  assert.equal(h.captured.kind, 'proactive')
  assert.equal(h.captured.ttl, 9000)
  assert.equal(h.captured.mods[0].text, '欸嘿嘿')
})

test('bubbleAutoClose routes proactive to hideProactiveBubble', () => {
  const code = [
    'var bubbleTtlTimer = null',
    'var bubbleTtlPending = false',
    'var bubbleTtlDeadline = 0',
    'var bubbleAudioUntil = 0',
    'var bubbleScene = { kind: "proactive", ttlMs: 5000 }',
    'var __hidden = 0',
    'function bubbleAudioBusy() { return false }',
    'function bubbleTtlClear() {}',
    'function whaleSysSwapNext() { return false }',
    'function hideProactiveBubble() { __hidden++ }',
    'function hideCostBubble() {}',
    'function hideUsageAlertBubble() {}',
    'function hideWaitBubble() {}',
    'function hideBubble() {}',
    extract('bubbleAutoClose'),
    'return { close: bubbleAutoClose, get hidden() { return __hidden } }',
  ].join('\n')
  const h = new Function(code)()
  h.close()
  assert.equal(h.hidden, 1)
})
