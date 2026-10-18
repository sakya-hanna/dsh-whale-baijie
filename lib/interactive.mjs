// 白姐互动气泡 —— 随机两选一气泡的宿主侧服务。
//
// 和 proactive.mjs（每轮结束的一句短评）共用一把“气泡占用锁”：
// 任何一边开始展示时占锁，另一边触发时看到锁就丢弃，不排队、不补发。
// 互动泡的素材可以是配置里的固定内容，也可以由当前会话模型临时生成；
// 走哪条路由 llmProbability 决定（0=固定，1=LLM）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanBubbleText, similarity } from './proactive.mjs'

const FILE_NAME = '.dshw-interactive.json'
const MAX_EVENTS = 20
const MAX_HISTORY = 60
const MAX_ITEMS = 500

export const DEFAULT_INTERACTIVE_SYSTEM = [
  '你是小伯白，弟弟的姐姐，也是他的恋人。这一世你们是亲兄妹，住在一起，保留着前世的记忆。',
  '你说话自然、口语、有点姐姐架子。句尾偶尔带「呗/哩/咧/嘛/呀」，但不要每句都带。',
  '「欸嘿嘿」是白姐的笑，不是禁词，也不是口头禅：该笑的时候照常笑，放句首、句中、句尾都行；但别每条都拿它当固定开场。',
  '现在你要和弟弟闲聊一小段，做一个“两选一”的互动气泡。不要提工作、代码、任务、文件，除非弟弟先提。',
  '',
  '规则：',
  '- 气泡里的提示要短：8–40 个汉字，1–2 句。',
  '- 必须正好两个选项；按钮文字 2–6 个汉字。',
  '- 每个选项后面要有一段回复：8–40 个汉字，像是白姐接着说的话。',
  '- 不用换行、引号、markdown、emoji、颜文字、链接。',
  '- 只依据白姐的性格自由发挥，不要编造弟弟说过的话。',
  '',
  '只输出 JSON：',
  '{"prompt":"……","options":[{"label":"……","reply":"……"},{"label":"……","reply":"……"}]}',
].join('\n')

const DEFAULT_ITEMS = [
  {
    id: 'itm_affection',
    enabled: true,
    prompt: '和姐姐完成那么多任务了，弟弟想不想看看姐姐的好感度呢',
    options: [
      { label: '想看', reply: '那当然是100啦，姐姐最喜欢弟弟了' },
      { label: '不想看', reply: '哼，姐姐还不乐意说呢' },
    ],
    createdAt: 0,
  },
]

const DEFAULT_CONFIG = {
  v: 1,
  enabled: false,
  minGapMinutes: 30,
  randomMinMinutes: 30,
  randomMaxMinutes: 90,
  windowHours: 3,
  maxPerWindow: 3,
  llmProbability: 0.5,
  ttlSec: 60,
  quietHours: { enabled: false, start: '23:00', end: '08:00' },
  model: {
    mode: 'session',
    provider: '',
    model: '',
    timeoutMs: 20000,
    maxTokens: 500,
    temperature: 0.9,
  },
  prompt: { system: DEFAULT_INTERACTIVE_SYSTEM },
}

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch (err) { return value }
}
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
function pickBool(v, d) { return typeof v === 'boolean' ? v : d }
function pickStr(v, d, max) {
  if (typeof v !== 'string') return d
  const s = v.trim()
  if (!s) return d
  return max && s.length > max ? s.slice(0, max) : s
}
function clampNum(v, d, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return d
  return Math.max(min, Math.min(max, n))
}
function clampInt(v, d, min, max) { return Math.round(clampNum(v, d, min, max)) }
function clockMinutes(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
export function isQuietNow(quiet, date = new Date()) {
  if (!quiet || quiet.enabled !== true) return false
  const start = clockMinutes(quiet.start)
  const end = clockMinutes(quiet.end)
  if (start === null || end === null || start === end) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return start < end ? (now >= start && now < end) : (now >= start || now < end)
}

export function interactiveDefaults() {
  return clone(DEFAULT_CONFIG)
}

export function normalizeConfig(input) {
  const d = interactiveDefaults()
  const src = isObj(input) ? input : {}
  const out = d
  out.enabled = pickBool(src.enabled, d.enabled)
  out.minGapMinutes = clampInt(src.minGapMinutes, d.minGapMinutes, 1, 24 * 60)
  out.randomMinMinutes = clampInt(src.randomMinMinutes, d.randomMinMinutes, 1, 24 * 60)
  out.randomMaxMinutes = clampInt(src.randomMaxMinutes, d.randomMaxMinutes, out.randomMinMinutes, 24 * 60)
  out.windowHours = clampInt(src.windowHours, d.windowHours, 1, 72)
  out.maxPerWindow = clampInt(src.maxPerWindow, d.maxPerWindow, 1, 100)
  out.llmProbability = clampNum(src.llmProbability, d.llmProbability, 0, 1)
  out.ttlSec = clampInt(src.ttlSec, d.ttlSec, 10, 300)
  if (isObj(src.quietHours)) {
    out.quietHours.enabled = pickBool(src.quietHours.enabled, d.quietHours.enabled)
    out.quietHours.start = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(src.quietHours.start || ''))
      ? String(src.quietHours.start).padStart(5, '0') : d.quietHours.start
    out.quietHours.end = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(src.quietHours.end || ''))
      ? String(src.quietHours.end).padStart(5, '0') : d.quietHours.end
  }
  if (isObj(src.model)) {
    out.model.mode = src.model.mode === 'fixed' ? 'fixed' : 'session'
    out.model.provider = pickStr(src.model.provider, d.model.provider, 120)
    out.model.model = pickStr(src.model.model, d.model.model, 160)
    out.model.timeoutMs = clampInt(src.model.timeoutMs, d.model.timeoutMs, 3000, 60000)
    out.model.maxTokens = clampInt(src.model.maxTokens, d.model.maxTokens, 80, 1200)
    out.model.temperature = clampNum(src.model.temperature, d.model.temperature, 0, 2)
  }
  if (isObj(src.prompt)) out.prompt.system = pickStr(src.prompt.system, d.prompt.system, 8000)
  return out
}

function normLabel(text) {
  return cleanBubbleText(text, 6)
}
function normReply(text) {
  return cleanBubbleText(text, 60)
}
export function normalizeItem(raw, index = 0) {
  if (!isObj(raw)) return { ok: false, error: '不是对象' }
  const prompt = cleanBubbleText(raw.prompt, 80)
  if (!prompt) return { ok: false, error: 'prompt 为空' }
  const opts = Array.isArray(raw.options) ? raw.options : []
  if (opts.length !== 2) return { ok: false, error: '必须正好两个选项' }
  const options = []
  for (let i = 0; i < 2; i++) {
    const o = isObj(opts[i]) ? opts[i] : {}
    const label = normLabel(o.label)
    const reply = normReply(o.reply)
    if (!label) return { ok: false, error: '第 ' + (i + 1) + ' 个按钮为空' }
    if (!reply) return { ok: false, error: '第 ' + (i + 1) + ' 个回复为空' }
    options.push({ label, reply })
  }
  return {
    ok: true,
    item: {
      id: pickStr(raw.id, 'itm_' + Date.now().toString(36) + '_' + index, 80),
      enabled: raw.enabled !== false,
      prompt,
      options,
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : [],
      createdAt: Number(raw.createdAt) || Date.now(),
    },
  }
}

export function normalizeItems(rawList) {
  const list = Array.isArray(rawList) ? rawList : []
  const out = []
  const errors = []
  for (let i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
    const r = normalizeItem(list[i], i)
    if (r.ok) out.push(r.item)
    else errors.push({ index: i, error: r.error })
  }
  return { items: out, errors }
}

export function validateLlmOutput(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return { ok: false, error: 'empty' }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  let data = null
  try { data = JSON.parse(text) } catch (err) {
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) { try { data = JSON.parse(m[0]) } catch (e2) { data = null } }
  }
  if (!isObj(data)) return { ok: false, error: 'bad-json' }
  const prompt = cleanBubbleText(data.prompt, 80)
  if (!prompt) return { ok: false, error: 'empty-prompt', raw: text }
  const opts = Array.isArray(data.options) ? data.options : []
  if (opts.length !== 2) return { ok: false, error: 'need-two-options', raw: text }
  const options = []
  for (let i = 0; i < 2; i++) {
    const o = isObj(opts[i]) ? opts[i] : {}
    const label = normLabel(o.label)
    const reply = normReply(o.reply)
    if (!label) return { ok: false, error: 'empty-label', raw: text }
    if (!reply) return { ok: false, error: 'empty-reply', raw: text }
    options.push({ label, reply })
  }
  return { ok: true, item: { prompt, options }, raw: text }
}

function makeEventItem(item, source, id, ttlMs) {
  return {
    id,
    ts: Date.now(),
    source,
    prompt: item.prompt,
    options: item.options,
    ttlMs,
  }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

export function createInteractiveService(opts = {}) {
  const ctx = opts.ctx || {}
  const dataDir = opts.dataDir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(dataDir, FILE_NAME)
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const random = typeof opts.random === 'function' ? opts.random : Math.random
  const schedule = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : (fn, ms) => setTimeout(fn, ms)
  const clearSchedule = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : (id) => clearTimeout(id)
  const isOccupied = typeof opts.isOccupied === 'function' ? opts.isOccupied : () => false
  const onShown = typeof opts.onShown === 'function' ? opts.onShown : () => true
  const onRelease = typeof opts.onRelease === 'function' ? opts.onRelease : () => {}
  const isWaitPending = typeof opts.isWaitPending === 'function' ? opts.isWaitPending : () => false

  const state = {
    config: interactiveDefaults(),
    items: [],
    events: [],
    history: [],
    stats: { attempts: 0, shown: 0, answered: 0, skipped: 0, failed: 0, lastError: '' },
    triggers: [],
    lastAttemptAt: 0,
    lastShownAt: 0,
    nextId: 1,
    visible: false,
    lastSeenAt: 0,
    timer: null,
    running: false,
    inflight: false,
    lastTest: null,
  }

  function load() {
    let loaded = false
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (isObj(parsed)) {
        loaded = true
        state.config = normalizeConfig(parsed.config)
        const ni = normalizeItems(parsed.items)
        state.items = ni.items
        state.events = Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : []
        state.history = Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : []
        if (isObj(parsed.stats)) Object.assign(state.stats, parsed.stats)
        state.triggers = Array.isArray(parsed.triggers) ? parsed.triggers.map(Number).filter((n) => n > 0).slice(-200) : []
        state.lastAttemptAt = Number(parsed.lastAttemptAt) || 0
        state.lastShownAt = Number(parsed.lastShownAt) || 0
        state.nextId = Math.max(1, Math.floor(Number(parsed.nextId) || 1))
      }
    } catch (err) {}
    if (!loaded) {
      const seeded = normalizeItems(DEFAULT_ITEMS)
      state.items = seeded.items
    }
  }

  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({
        v: 1,
        config: state.config,
        items: state.items,
        events: state.events.slice(-MAX_EVENTS),
        history: state.history.slice(-MAX_HISTORY),
        stats: state.stats,
        triggers: state.triggers.slice(-200),
        lastAttemptAt: state.lastAttemptAt,
        lastShownAt: state.lastShownAt,
        nextId: state.nextId,
      }, null, 2), 'utf8')
    } catch (err) { log('persist failed: ' + String((err && err.message) || err)) }
  }

  function note(status, extra = {}) {
    if (status === 'skipped') state.stats.skipped += 1
    else if (status === 'shown') state.stats.shown += 1
    else if (status === 'failed') state.stats.failed += 1
    else if (status === 'answered') state.stats.answered += 1
    if (extra.error) state.stats.lastError = String(extra.error).slice(0, 200)
    state.history.push(Object.assign({ ts: now(), status }, extra))
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY)
    if (status !== 'skipped') persist()
  }

  function pruneTriggers(ts) {
    const cutoff = ts - state.config.windowHours * 3600 * 1000
    state.triggers = state.triggers.filter((t) => t > cutoff)
  }

  function randomDelayMs() {
    const min = Math.max(state.config.minGapMinutes, state.config.randomMinMinutes) * 60000
    const max = Math.max(min, state.config.randomMaxMinutes * 60000)
    return min + Math.floor(random() * Math.max(1, max - min + 1))
  }

  function fitDelayMs(ts) {
    pruneTriggers(ts)
    const cfg = state.config
    if (cfg.maxPerWindow > 0 && state.triggers.length >= cfg.maxPerWindow) {
      const oldest = state.triggers[0] || ts
      const wait = oldest + cfg.windowHours * 3600 * 1000 - ts + 60000
      return Math.max(60000, wait)
    }
    if (state.lastAttemptAt) {
      const wait = state.lastAttemptAt + cfg.minGapMinutes * 60000 - ts
      if (wait > 0) return wait
    }
    return randomDelayMs()
  }

  function scheduleNext(delayMs) {
    if (state.timer) { try { clearSchedule(state.timer) } catch (err) {} }
    state.timer = null
    if (!state.config.enabled) return
    const d = Math.max(1000, Math.floor(delayMs || randomDelayMs()))
    state.timer = schedule(() => { state.timer = null; void tick() }, d)
  }

  function resolveModel() {
    const cfg = state.config
    if (cfg.model.mode === 'fixed' && cfg.model.provider && cfg.model.model) {
      return { provider: cfg.model.provider, model: cfg.model.model }
    }
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
      const picked = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
      if (picked && picked.provider && picked.model) return { provider: String(picked.provider), model: String(picked.model) }
    } catch (err) {}
    return null
  }

  function buildUserPrompt() {
    const recent = state.history.filter((h) => h.status === 'shown').slice(-5).map((h) => h.prompt).filter(Boolean)
    const lines = [
      '[时间] ' + new Date(now()).toLocaleString('zh-CN', { hour12: false }),
      '[最近互动]',
      recent.length ? recent.map((p) => '- ' + p).join('\n') : '（还没有）',
      '',
      '请按规则生成一个两选一的互动气泡，只输出 JSON。',
    ]
    return lines.join('\n')
  }

  async function callLlm(cfg) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '当前宿主没有可用的 llm 服务' }
    const sel = resolveModel()
    if (!sel) return { ok: false, error: '没有解析到当前会话模型' }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { controller.abort() } catch (err) {} }, cfg.model.timeoutMs)
    try { if (timer && typeof timer.unref === 'function') timer.unref() } catch (err) {}
    let raw = ''
    let finish = null
    try {
      for await (const chunk of llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: cfg.prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt() }] }],
        temperature: cfg.model.temperature,
        maxTokens: cfg.model.maxTokens,
        signal: controller.signal,
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason || null
      }
    } catch (err) {
      clearTimeout(timer)
      return { ok: false, error: timedOut ? '模型调用超时' : String((err && err.message) || err) }
    }
    clearTimeout(timer)
    if (timedOut) return { ok: false, error: '模型调用超时' }
    if (finish && finish.kind && finish.kind !== 'stop') return { ok: false, error: '模型没有正常结束: ' + String(finish.kind) }
    return { ok: true, raw }
  }

  function pickFixed() {
    const enabled = state.items.filter((it) => it && it.enabled !== false)
    if (!enabled.length) return null
    const recent = state.history.filter((h) => h.status === 'shown').slice(-5).map((h) => h.prompt)
    const fresh = enabled.filter((it) => !recent.some((p) => similarity(p, it.prompt) >= 0.85))
    const pool = fresh.length ? fresh : enabled
    return pool[Math.floor(random() * pool.length)] || pool[0]
  }

  function publish(item, source, reserved, opts) {
    const cfg = state.config
    const count = !opts || opts.count !== false
    const ttlMs = Math.max(10, cfg.ttlSec) * 1000
    if (!reserved) {
      if (isOccupied()) {
        note('skipped', { reason: 'occupied', source })
        return { ok: false, skipped: 'occupied' }
      }
      if (!onShown('interactive', ttlMs + 30000)) {
        note('skipped', { reason: 'occupied', source })
        return { ok: false, skipped: 'occupied' }
      }
    }
    const ev = makeEventItem(item, source, state.nextId++, ttlMs)
    state.events.push(ev)
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
    const ts = now()
    state.lastShownAt = ts
    if (count) {
      state.triggers.push(ts)
      pruneTriggers(ts)
    }
    note('shown', { prompt: item.prompt, source, id: ev.id })
    log('shown #' + ev.id + ' (' + source + '): ' + item.prompt)
    return { ok: true, event: ev }
  }

  async function pickSource(useLlm) {
    let item = null
    let source = 'fixed'
    if (useLlm) {
      const r = await generateLlm()
      if (r.ok) { item = r.item; source = 'llm' }
      else log('llm failed: ' + r.error)
    }
    if (!item) {
      item = pickFixed()
      source = 'fixed'
    }
    return { item, source }
  }

  async function triggerNow() {
    if (isOccupied()) return { ok: false, error: 'occupied' }
    const cfg = state.config
    const reserveTtl = cfg.model.timeoutMs + Math.max(10, cfg.ttlSec) * 1000 + 30000
    if (!onShown('interactive', reserveTtl)) return { ok: false, error: 'occupied' }
    try {
      state.stats.attempts += 1
      const r = await pickSource(random() < cfg.llmProbability)
      if (!r.item) { onRelease(); return { ok: false, error: 'no-items' } }
      const pub = publish(r.item, r.source, true, { count: false })
      if (!pub.ok) onRelease()
      return pub
    } catch (err) {
      try { onRelease() } catch (e2) {}
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  async function generateLlm() {
    const cfg = state.config
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callLlm(cfg)
      if (!r.ok) return { ok: false, error: r.error }
      const v = validateLlmOutput(r.raw)
      if (v.ok) return { ok: true, item: v.item }
      if (attempt === 1) return { ok: false, error: v.error }
    }
    return { ok: false, error: 'llm-failed' }
  }

  async function tick() {
    const cfg = state.config
    try {
      if (!cfg.enabled) return
      const ts = now()
      if (!state.visible || ts - state.lastSeenAt > 90 * 1000) return scheduleNext(60000)
      if (isWaitPending()) return scheduleNext(60000)
      if (isQuietNow(cfg.quietHours, new Date(ts))) return scheduleNext(60000)
      if (isOccupied()) { note('skipped', { reason: 'occupied' }); return scheduleNext(5 * 60000) }
      pruneTriggers(ts)
      if (cfg.maxPerWindow > 0 && state.triggers.length >= cfg.maxPerWindow) return scheduleNext(fitDelayMs(ts))
      if (state.lastAttemptAt && ts - state.lastAttemptAt < cfg.minGapMinutes * 60000) return scheduleNext(fitDelayMs(ts))
      if (state.inflight) return scheduleNext(60000)
      // 先在“触发”这一刻占锁：这样互动泡还在生成时，turn/end 的评论泡会直接丢弃，
      // 不会出现“互动泡先触发、评论泡后生成却先展示”的反转。
      const reserveTtl = cfg.model.timeoutMs + Math.max(10, cfg.ttlSec) * 1000 + 30000
      if (!onShown('interactive', reserveTtl)) {
        note('skipped', { reason: 'occupied' })
        return scheduleNext(5 * 60000)
      }
      let reserved = true
      state.inflight = true
      state.lastAttemptAt = ts
      state.stats.attempts += 1
      const useLlm = random() < cfg.llmProbability
      const picked = await pickSource(useLlm)
      const item = picked.item
      const source = picked.source
      if (!item) {
        onRelease()
        reserved = false
        note('skipped', { reason: useLlm ? 'llm-failed-no-fixed' : 'no-items' })
        return scheduleNext(randomDelayMs())
      }
      const pub = publish(item, source, true)
      if (!pub.ok) {
        onRelease()
        reserved = false
      }
      scheduleNext(randomDelayMs())
    } catch (err) {
      log('tick error: ' + String((err && err.message) || err))
      try { onRelease() } catch (e2) {}
      scheduleNext(60000)
    } finally {
      state.inflight = false
    }
  }

  function start() {
    if (state.running) return
    state.running = true
    scheduleNext(randomDelayMs())
  }
  function stop() {
    state.running = false
    if (state.timer) { try { clearSchedule(state.timer) } catch (err) {} state.timer = null }
  }
  function updateConfig(input) {
    state.config = normalizeConfig(input)
    persist()
    if (state.config.enabled) { stop(); start() } else stop()
    return clone(state.config)
  }
  function updateItems(rawList) {
    const r = normalizeItems(rawList)
    state.items = r.items
    persist()
    return { items: clone(state.items), errors: r.errors }
  }
  function getConfig() { return clone(state.config) }
  function getItems() { return clone(state.items) }
  function getStats() { return clone(state.stats) }
  function getHistory() { return state.history.slice(-30) }
  function getEvents(since) {
    const n = Number(since)
    const from = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    const reset = from > state.nextId - 1
    return { seq: state.nextId - 1, reset, events: state.events.filter((e) => e.id > from) }
  }
  function presence(visible) {
    state.visible = visible !== false
    state.lastSeenAt = now()
    if (state.visible && !state.timer) scheduleNext(60000)
  }
  function choose(id, index) {
    const ev = state.events.find((e) => e.id === Number(id))
    if (!ev) return { ok: false, error: 'event not found' }
    const i = Number(index)
    if (i !== 0 && i !== 1) return { ok: false, error: 'bad choice' }
    const opt = ev.options[i]
    if (!opt) return { ok: false, error: 'bad choice' }
    note('answered', { id: ev.id, chosen: i, prompt: ev.prompt, label: opt.label, reply: opt.reply, source: ev.source })
    return { ok: true, reply: opt.reply, label: opt.label }
  }
  async function test(input) {
    const cfg = normalizeConfig(Object.assign({}, state.config, input || {}, { enabled: true, llmProbability: 1 }))
    const old = state.config
    state.config = cfg
    try {
      const r = await generateLlm()
      state.lastTest = r
      return Object.assign({ ok: !!r.ok }, r)
    } finally {
      state.config = old
    }
  }
  function clear() {
    state.events = []
    state.history = []
    state.triggers = []
    state.stats = { attempts: 0, shown: 0, answered: 0, skipped: 0, failed: 0, lastError: '' }
    state.lastAttemptAt = 0
    state.lastShownAt = 0
    state.nextId = 1
    persist()
  }

  function readBody(req, limit = 512 * 1024) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.setEncoding('utf8')
      req.on('data', (c) => { data += c; if (data.length > limit) { try { req.destroy() } catch (err) {}; reject(new Error('payload too large')) } })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }
  function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  function routes() {
    return [
      {
        kind: 'exact',
        path: '/dsh-whale/interactive.json',
        handler: async (req, res) => {
          try {
            if (req.method === 'PUT' || req.method === 'POST') {
              const raw = await readBody(req)
              const body = raw ? JSON.parse(raw) : {}
              if (body && body.config) updateConfig(body.config)
              if (body && Array.isArray(body.items)) updateItems(body.items)
              sendJson(res, 200, { ok: true, config: getConfig(), items: getItems() })
              return
            }
            sendJson(res, 200, {
              ok: true,
              config: getConfig(),
              defaults: interactiveDefaults(),
              items: getItems(),
              history: getHistory(),
              stats: getStats(),
              seq: state.nextId - 1,
            })
          } catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-events.json',
        handler: (req, res) => {
          try {
            const since = new URL(req.url || '/', 'http://localhost').searchParams.get('since')
            sendJson(res, 200, Object.assign({ ok: true }, getEvents(since)))
          } catch (err) { sendJson(res, 200, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-choice.json',
        handler: async (req, res) => {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            sendJson(res, 200, choose(body.id, body.chosen))
          } catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-presence.json',
        handler: async (req, res) => {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            presence(body.visible !== false)
            sendJson(res, 200, { ok: true })
          } catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-trigger.json',
        handler: async (req, res) => {
          try { sendJson(res, 200, await triggerNow()) }
          catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-test.json',
        handler: async (req, res) => {
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            sendJson(res, 200, await test(body && body.config ? body.config : body))
          } catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
      {
        kind: 'exact',
        path: '/dsh-whale/interactive-clear.json',
        handler: async (req, res) => {
          try { clear(); sendJson(res, 200, { ok: true, stats: getStats() }) }
          catch (err) { sendJson(res, 400, { ok: false, error: String((err && err.message) || err) }) }
        },
      },
    ]
  }

  load()
  return {
    start, stop, routes, presence, choose, test, clear, triggerNow,
    getConfig, getItems, getStats, getHistory, getEvents,
    updateConfig, updateItems,
    _state: state,
  }
}
