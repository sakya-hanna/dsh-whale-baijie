import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseLrc,
  pickLine,
  parseProbeLine,
  lyricsUrl,
  neteaseSearchUrl,
  neteaseLyricUrl,
  createMusicService,
} from '../lib/music.mjs'

test('parseLrc: 一行多时间戳、小数位换算、跳过无词行', () => {
  const raw = [
    '[ti:测试]',
    '[00:01.50]第一句',
    '[00:05.5][01:05.500]重复句',
    '[00:09]无小数',
    '没有时间戳的行',
    '[00:12.05]',
  ].join('\n')
  const lines = parseLrc(raw)
  assert.deepEqual(lines.map((l) => l.t), [1.5, 5.5, 9, 65.5])
  assert.equal(lines[0].text, '第一句')
  assert.equal(lines[1].text, '重复句')
  assert.equal(lines[3].text, '重复句')
})

test('parseLrc: 空/非字符串输入返回空数组', () => {
  assert.deepEqual(parseLrc(''), [])
  assert.deepEqual(parseLrc(null), [])
})

test('pickLine: 首句前回退第一句，边界取当前句', () => {
  const lines = [{ t: 1, text: 'a' }, { t: 5, text: 'b' }, { t: 9, text: 'c' }]
  assert.equal(pickLine(lines, 0).text, 'a')
  assert.equal(pickLine(lines, 1).text, 'a')
  assert.equal(pickLine(lines, 4.9).text, 'a')
  assert.equal(pickLine(lines, 5).text, 'b')
  assert.equal(pickLine(lines, 100).text, 'c')
  assert.equal(pickLine([], 1), null)
  assert.equal(pickLine(null, 1), null)
})

test('parseProbeLine: 坏行返回 null，好行归一字段', () => {
  assert.equal(parseProbeLine(''), null)
  assert.equal(parseProbeLine('not json'), null)
  assert.equal(parseProbeLine('{"playing":'), null)
  const v = parseProbeLine('{"playing":true,"title":" 歌 ","artist":"人","app":"a.exe","position":"12.5","duration":200}')
  assert.deepEqual(v, {
    playing: true, title: '歌', artist: '人', app: 'a.exe', position: 12.5, duration: 200,
  })
  assert.equal(parseProbeLine('{"playing":false}').playing, false)
})

test('lyricsUrl: 编码参数，短时长不带 duration', () => {
  const url = lyricsUrl({ title: '夜に駆ける', artist: 'YOASOBI', duration: 261.4 })
  assert.match(url, /^https:\/\/lrclib\.net\/api\/get\?/)
  assert.match(url, /track_name=%E5%A4%9C%E3%81%AB%E9%A7%86%E3%81%91%E3%82%8B/)
  assert.match(url, /artist_name=YOASOBI/)
  assert.match(url, /duration=261/)
  assert.equal(lyricsUrl({ title: '', artist: 'x' }), '')
  assert.ok(!lyricsUrl({ title: 'a', artist: 'b', duration: 2 }).includes('duration='))
})

test('service: 喂探针行后快照反映播放状态；歌词就绪后给出当前句', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return {
      ok: true,
      json: async () => ({
        syncedLyrics: '[00:00.00]第一句\n[00:10.00]第二句',
      }),
    }
  }
  const svc = createMusicService({ fetchImpl })
  svc._feed('{"playing":true,"title":"测试歌","artist":"测试人","position":11,"duration":200}')
  await new Promise((r) => setTimeout(r, 20))

  const snap = svc.snapshot()
  assert.equal(snap.playing, true)
  assert.equal(snap.title, '测试歌')
  assert.equal(snap.hasLyrics, true)
  assert.equal(snap.line, '第二句')
  assert.equal(calls.length, 1)
  svc.dispose()
})

test('service: 探针说没在播时快照清空曲目', async () => {
  const svc = createMusicService({ fetchImpl: async () => ({ ok: false }) })
  svc._feed('{"playing":true,"title":"A","artist":"B","position":3,"duration":100}')
  svc._feed('{"playing":false}')
  const snap = svc.snapshot()
  assert.equal(snap.playing, false)
  assert.equal(snap.title, '')
  svc.dispose()
})

test('netease URL: 搜索带词曲、歌词只认数字 id', () => {
  const s = neteaseSearchUrl({ title: '夜に駆ける', artist: 'YOASOBI' })
  assert.match(s, /^https:\/\/music\.163\.com\/api\/search\/get\?s=/)
  assert.match(s, /%E5%A4%9C/)
  assert.equal(neteaseSearchUrl({ title: '' }), '')
  assert.equal(neteaseLyricUrl(12345), 'https://music.163.com/api/song/lyric?id=12345&lv=-1&tv=-1')
  assert.equal(neteaseLyricUrl('12ab'), '')
})

test('service: lrclib 没有同步词时回退网易云，并滤掉制作名单行', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.includes('lrclib.net')) return { ok: false, json: async () => ({}) }
    if (url.includes('/api/search/get')) {
      return { ok: true, json: async () => ({ result: { songs: [{ id: 42, name: '夜に駆ける' }] } }) }
    }
    if (url.includes('/api/song/lyric')) {
      return {
        ok: true,
        json: async () => ({
          lrc: { lyric: '[00:00.00]作词 : Ayase\n[00:01.00]作曲 : Ayase\n[00:10.00]沈むように溶けてゆくように' },
        }),
      }
    }
    return { ok: false, json: async () => ({}) }
  }
  const svc = createMusicService({ fetchImpl })
  svc._feed('{"playing":true,"title":"夜に駆ける","artist":"YOASOBI","position":12,"duration":260}')
  await new Promise((r) => setTimeout(r, 30))
  const snap = svc.snapshot()
  assert.equal(snap.hasLyrics, true)
  assert.equal(snap.lyricSource, 'netease')
  assert.equal(snap.line, '沈むように溶けてゆくように')
  assert.ok(seen.some((u) => u.includes('/api/song/lyric?id=42')))
  svc.dispose()
})

