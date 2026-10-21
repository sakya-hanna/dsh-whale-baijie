import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 音乐伴舞（宿主侧）：读 Windows 系统媒体会话（SMTC）+ 取同步歌词。
//
// 为什么在宿主而不是浏览器：浏览器的 Media Session API 只暴露**本页**的媒体，
// 读不到网易云/QQ 音乐在系统里播的歌。宿主是 Node（跑在用户机器上），可以起一个
// PowerShell 常驻探针读 SMTC —— 与仓库既有做法一致（更新检查也是 exec 子进程）。
//
// 为什么探针写文件、宿主读文件：不经过子进程管道（Node 在某些受限环境/安全软件下
// 拿不到管道会 EPERM），也不受控制台编码影响；探针每拍原子写一个 JSON 文件，
// 宿主每拍读一次，失败一律降级成「没在放」。
//
// 失败面：非 Windows / 没有 PowerShell / WinRT 不可用 / 没有播放器上报会话，
// 一律降级成 { available:false } 或 { playing:false }，绝不抛给路由层。

const IS_WIN = process.platform === 'win32'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROBE_SCRIPT = path.join(PACKAGE_ROOT, 'assets', 'music-now-playing.ps1')

const POLL_INTERVAL_MS = 300
const LRC_CACHE_LIMIT = 40
const LYRICS_TIMEOUT_MS = 6000
const STALE_MS = 6000

/** 解析 LRC：`[mm:ss.xx]词`，一行多时间戳展开；返回按时间升序的 [{t,text}]。 */
export function parseLrc(raw) {
  const out = []
  const text = String(raw == null ? '' : raw)
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of text.split(/\r?\n/)) {
    const stamps = []
    let m
    re.lastIndex = 0
    while ((m = re.exec(line)) !== null) {
      const min = Number(m[1]) || 0
      const sec = Number(m[2]) || 0
      const fracRaw = m[3] || '0'
      // 小数位按长度换算：.5 = 半秒、.50 = 0.5、.500 = 0.5、.05 = 0.05
      const frac = Number(fracRaw) / Math.pow(10, fracRaw.length)
      stamps.push(min * 60 + sec + frac)
    }
    if (!stamps.length) continue
    const content = line.replace(re, '').trim()
    if (!content) continue
    for (const t of stamps) out.push({ t, text: content })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** 取「当前该显示的那一句」：t 不超过 position 的最后一句；position 缺失返回第一句。 */
export function pickLine(lines, position) {
  if (!Array.isArray(lines) || !lines.length) return null
  const pos = Number(position)
  if (!Number.isFinite(pos) || pos < 0) return lines[0]
  let lo = 0
  let hi = lines.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= pos) { hit = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return hit >= 0 ? lines[hit] : lines[0]
}

/** 解析探针写出的一行 JSON；坏行/缺字段返回 null。 */
export function parseProbeLine(line) {
  const s = String(line == null ? '' : line).trim()
  if (!s || s[0] !== '{') return null
  try {
    const v = JSON.parse(s)
    if (!v || typeof v !== 'object') return null
    return {
      playing: !!v.playing,
      title: String(v.title || '').trim(),
      artist: String(v.artist || '').trim(),
      app: String(v.app || '').trim(),
      position: Number(v.position) || 0,
      duration: Number(v.duration) || 0,
    }
  } catch (err) {
    return null
  }
}

/** 歌词查询 URL（lrclib 免费、无需 key）。 */
export function lyricsUrl(track) {
  const title = String((track && track.title) || '').trim()
  const artist = String((track && track.artist) || '').trim()
  if (!title) return ''
  const q = new URLSearchParams({ track_name: title })
  if (artist) q.set('artist_name', artist)
  const dur = Math.round(Number(track && track.duration) || 0)
  if (dur > 5) q.set('duration', String(dur))
  return 'https://lrclib.net/api/get?' + q.toString()
}

/** 网易云搜索 URL（lrclib 缺同步词时的兜底源；中文/日文歌覆盖明显更好）。 */
export function neteaseSearchUrl(track) {
  const title = String((track && track.title) || '').trim()
  const artist = String((track && track.artist) || '').trim()
  const q = [title, artist].filter(Boolean).join(' ')
  if (!q) return ''
  return 'https://music.163.com/api/search/get?s=' + encodeURIComponent(q) + '&type=1&limit=5'
}

/** 网易云歌词 URL。 */
export function neteaseLyricUrl(id) {
  const sid = String(id == null ? '' : id).trim()
  if (!/^\d+$/.test(sid)) return ''
  return 'https://music.163.com/api/song/lyric?id=' + sid + '&lv=-1&tv=-1'
}

// 制作人员名单行（作词/作曲/编曲…）不是歌词：网易云 LRC 每首开头都有一串，必须滤掉。
const CREDIT_RE = /^(作词|作曲|编曲|制作人|监制|混音|母带|吉他|贝斯|鼓|和声|录音|出品|发行|词|曲|lyrics|composer|arranger|producer)\s*[:：]/i

function cleanLines(list) {
  if (!Array.isArray(list)) return []
  return list.filter((l) => l && l.text && !CREDIT_RE.test(String(l.text).trim()))
}

/**
 * 音乐服务：探针生命周期 + 歌词缓存 + 快照。
 * @param {{ dataDir?: string, log?: (m:string)=>void, fetchImpl?: Function }} opts
 */
export function createMusicService(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const dataDir = opts.dataDir || path.join(os.tmpdir(), 'dsh-whale')
  const probeFile = path.join(dataDir, 'now-playing.json')
  const state = {
    available: IS_WIN,
    playing: false,
    title: '',
    artist: '',
    app: '',
    position: 0,
    duration: 0,
    updatedAt: 0,
  }
  const cache = new Map() // key -> lines[] | null
  let proc = null
  let stopped = false
  let restartTimer = null
  let pollTimer = null
  let lyricsInFlight = null
  let lines = null
  let linesKey = ''
  let lyricSource = ''

  function snapshot() {
    const now = Date.now()
    // 探针停更超过 6 秒：当作「没在放」，避免拔掉播放器后宠物一直跳舞。
    const stale = state.updatedAt > 0 && now - state.updatedAt > STALE_MS
    const playing = !!state.playing && !stale
    const line = playing && lines ? pickLine(lines, state.position) : null
    return {
      ok: true,
      available: state.available,
      playing,
      title: playing ? state.title : '',
      artist: playing ? state.artist : '',
      app: playing ? state.app : '',
      position: playing ? state.position : 0,
      duration: playing ? state.duration : 0,
      line: line ? line.text : '',
      lineAt: line ? line.t : 0,
      hasLyrics: !!(lines && lines.length),
      lyricSource: playing ? lyricSource : '',
    }
  }

  function trackKey() {
    return (state.title + '\u0000' + state.artist).trim().toLowerCase()
  }

  async function withTimeout(fn, ms) {
    const ac = new AbortController()
    const timer = setTimeout(() => { try { ac.abort() } catch (err) {} }, ms)
    try { return await fn(ac.signal) } finally { clearTimeout(timer) }
  }

  async function fetchLrclib(track, signal) {
    const url = lyricsUrl(track)
    if (!url) return null
    const res = await fetchImpl(url, { signal, headers: { accept: 'application/json' } })
    if (!res || !res.ok) return null
    const body = await res.json()
    const parsed = cleanLines(parseLrc(body && body.syncedLyrics))
    return parsed.length ? parsed : null
  }

  async function fetchNetease(track, signal) {
    const searchUrl = neteaseSearchUrl(track)
    if (!searchUrl) return null
    const headers = {
      accept: 'application/json',
      referer: 'https://music.163.com/',
      'user-agent': 'Mozilla/5.0',
    }
    const res = await fetchImpl(searchUrl, { signal, headers })
    if (!res || !res.ok) return null
    const body = await res.json()
    const songs = (body && body.result && body.result.songs) || []
    if (!songs.length) return null
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s\-–—_()（）[\]【】]/g, '')
    const want = norm(track.title)
    const pick = songs.find((s) => norm(s && s.name) === want) || songs[0]
    const lyricUrl = neteaseLyricUrl(pick && pick.id)
    if (!lyricUrl) return null
    const lres = await fetchImpl(lyricUrl, { signal, headers })
    if (!lres || !lres.ok) return null
    const lbody = await lres.json()
    const raw = (lbody && lbody.lrc && lbody.lrc.lyric) || ''
    const parsed = cleanLines(parseLrc(raw))
    return parsed.length ? parsed : null
  }

  async function loadLyrics() {
    const key = trackKey()
    if (!key || key === linesKey) return
    if (cache.has(key)) {
      lines = cache.get(key)
      linesKey = key
      return
    }
    if (typeof fetchImpl !== 'function') { lines = null; linesKey = key; return }
    if (lyricsInFlight) { try { await lyricsInFlight } catch (err) {} }
    if (linesKey === key) return
    lyricsInFlight = (async () => {
      const track = { title: state.title, artist: state.artist, duration: state.duration }
      let parsed = null
      let source = 'none'
      // 先 lrclib（同步词质量好）→ 没有再走网易云（中文/日文覆盖更好）
      for (const [name, fn] of [['lrclib', fetchLrclib], ['netease', fetchNetease]]) {
        try {
          const got = await withTimeout((signal) => fn(track, signal), LYRICS_TIMEOUT_MS)
          if (got && got.length) { parsed = got; source = name; break }
        } catch (err) { /* 这个源失败/超时：换下一个 */ }
      }
      try {
        cache.set(key, parsed)
        if (cache.size > LRC_CACHE_LIMIT) {
          const first = cache.keys().next().value
          if (first !== undefined) cache.delete(first)
        }
        if (trackKey() === key) { lines = parsed; linesKey = key; lyricSource = source }
        log('lyrics ' + (parsed ? source : 'miss') + ': ' + track.title + ' / ' + track.artist)
      } finally {
        lyricsInFlight = null
      }
    })()
    try { await lyricsInFlight } catch (err) {}
  }

  function onProbeLine(line) {
    const v = parseProbeLine(line)
    if (!v) return
    const prevKey = trackKey()
    state.playing = v.playing
    state.title = v.title
    state.artist = v.artist
    state.app = v.app
    state.position = v.position
    state.duration = v.duration
    state.updatedAt = Date.now()
    const key = trackKey()
    if (key && key !== prevKey) {
      lines = null
      linesKey = ''
      loadLyrics()
    }
  }

  function pollProbeFile() {
    try {
      const raw = fs.readFileSync(probeFile, 'utf8')
      const line = String(raw).split(/\r?\n/).filter((s) => s.trim()).pop() || ''
      if (line) onProbeLine(line)
    } catch (err) {
      // 文件还没生成 / 被占用：这一拍跳过（探针下一拍会原子覆盖）
    }
  }

  function stopProc() {
    if (!proc) return
    const p = proc
    proc = null
    try { p.kill() } catch (err) {}
  }

  function startProbe() {
    if (!IS_WIN || stopped) return
    stopProc()
    try { fs.mkdirSync(dataDir, { recursive: true }) } catch (err) {}
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PROBE_SCRIPT, '-OutFile', probeFile, '-ParentPid', String(process.pid),
      ], { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      state.available = false
      log('probe spawn failed: ' + String((err && err.message) || err))
      return
    }
    proc = child
    child.on('error', (err) => {
      state.available = false
      log('probe error: ' + String((err && err.message) || err))
    })
    child.on('exit', () => {
      if (proc === child) proc = null
      if (stopped) return
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = setTimeout(() => { restartTimer = null; startProbe() }, 5000)
      try { restartTimer.unref && restartTimer.unref() } catch (err) {}
    })
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => { if (!stopped) pollProbeFile() }, POLL_INTERVAL_MS)
    try { pollTimer.unref && pollTimer.unref() } catch (err) {}
    // 立刻读一次（上一次运行留下的文件可能还是新鲜的）
    pollProbeFile()
  }

  function routes() {
    return [{
      kind: 'exact',
      path: '/dsh-whale/now-playing.json',
      handler: (req, res) => {
        try {
          const body = JSON.stringify(snapshot())
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(body)
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ ok: false, playing: false, error: String((err && err.message) || err) }))
        }
      },
    }]
  }

  return {
    start() {
      if (!IS_WIN) return { available: false }
      startProbe()
      return { available: true, intervalMs: POLL_INTERVAL_MS, probeFile }
    },
    dispose() {
      stopped = true
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      stopProc()
    },
    routes,
    snapshot,
    // 测试用：不走真实探针，直接喂一行探针输出
    _feed(line) { onProbeLine(line) },
    _state: state,
  }
}

