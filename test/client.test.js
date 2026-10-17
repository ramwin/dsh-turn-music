/**
 * Browser-half logic test: no jsdom, no browser — just the globals the bundle
 * touches, so the turn-finished edge can be asserted on the real code.
 *
 * The client bundle is loaded the way the shell loads it
 * (`window.__ModuleLoader__.load({factory})`) and then driven through a fake
 * `sessions.list` store.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/** Minimal DOM element stand-in: enough for the reminder chip. */
function fakeElement(tag) {
  return {
    tagName: tag,
    style: { cssText: '' },
    children: [],
    textContent: '',
    setAttribute() {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
    addEventListener(type, fn) {
      this['on' + type] = fn
    },
    removeEventListener() {},
  }
}

/**
 * Load the bundle and return a harness.
 * @param config - host config the fake `/config` endpoint answers with.
 */
function loadClient(config) {
  const plays = []
  const pauses = []
  let captured = null
  let storeSubscribe = null
  let storeSnapshot = { byId: {} }
  const effects = []

  class FakeAudio {
    constructor() {
      this.src = ''
      this.loop = false
      this.volume = 1
      this.currentTime = 0
      this.listeners = {}
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn
    }
    play() {
      plays.push({ src: this.src, loop: this.loop, volume: this.volume })
      return Promise.resolve()
    }
    pause() {
      pauses.push(this.src)
    }
  }

  const window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  const document = {
    createElement: fakeElement,
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const sessionList = {
    getSnapshot: () => storeSnapshot,
    subscribe(fn) {
      storeSubscribe = fn
      return () => {
        storeSubscribe = null
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: sessionList }
      return null
    },
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
    slots: { inject() {} },
  }

  const factory = new Function(
    'window',
    'document',
    'Audio',
    'fetch',
    'location',
    'URL',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'console',
    SOURCE,
  )
  factory(
    window,
    document,
    FakeAudio,
    async () => ({
      json: async () => ({
        ok: true,
        config: { enabled: true, file: '', volume: 70, loop: true, maxSeconds: 0, onlyCurrent: false, muteSubagent: true, ...config },
        audio: { source: 'bundled', name: 'ringtone.mp3', version: 1, url: '/dsh-turn-music/audio?v=1' },
      }),
    }),
    { href: 'http://127.0.0.1:3080/' },
    URL,
    setTimeout,
    clearTimeout,
    () => 0,
    () => {},
    console,
  )

  const exportsObject = captured.factory((id) => {
    if (id === 'react') return { createElement() {}, useState() {}, useEffect() {} }
    throw new Error('unexpected require: ' + id)
  })
  exportsObject.apply(ctx)

  return {
    plays,
    pauses,
    effects,
    /** Push a new session-list snapshot into the watcher. */
    update(next) {
      storeSnapshot = next
      if (storeSubscribe) storeSubscribe()
    },
  }
}

// Let the async /config fetch settle before assertions.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test('回合从 running 变成 false 时触发播放，baseline 不响', async () => {
  const harness = loadClient({})
  await settle()

  // baseline: a session already running when the page opened must not ring
  harness.update({ byId: { s1: { running: true } } })
  assert.equal(harness.plays.length, 0, '基线快照不应播放')

  harness.update({ byId: { s1: { running: false } } })
  assert.equal(harness.plays.length, 1, 'running -> false 应当播放一次')
  assert.match(harness.plays[0].src, /\/dsh-turn-music\/audio/)
  assert.equal(harness.plays[0].volume, 0.7, '音量按配置换算成 0-1')
  assert.equal(harness.plays[0].loop, true)
})

test('子代理会话默认静音，父会话照常响', async () => {
  const harness = loadClient({})
  await settle()

  harness.update({ byId: { child: { running: true, origin: 'subagent' }, parent: { running: true } } })
  harness.update({ byId: { child: { running: false, origin: 'subagent' }, parent: { running: true } } })
  assert.equal(harness.plays.length, 0, '子代理结束不应响')

  harness.update({ byId: { child: { running: false, origin: 'subagent' }, parent: { running: false } } })
  assert.equal(harness.plays.length, 1, '父会话结束应当响')
})

test('enabled=false 时完全不播', async () => {
  const harness = loadClient({ enabled: false })
  await settle()
  harness.update({ byId: { s1: { running: true } } })
  harness.update({ byId: { s1: { running: false } } })
  assert.equal(harness.plays.length, 0)
})

test('onlyCurrent 只对当前会话响', async () => {
  const harness = loadClient({ onlyCurrent: true })
  await settle()
  harness.update({ byId: { a: { running: true }, b: { running: true } }, current: 'a' })
  harness.update({ byId: { a: { running: true }, b: { running: false } }, current: 'a' })
  assert.equal(harness.plays.length, 0, '非当前会话结束不响')
  harness.update({ byId: { a: { running: false }, b: { running: false } }, current: 'a' })
  assert.equal(harness.plays.length, 1, '当前会话结束要响')
})

test('两秒内的重复触发被去重（多实例 watcher 不会连响两声）', async () => {
  const harness = loadClient({})
  await settle()
  harness.update({ byId: { s1: { running: true } } })
  harness.update({ byId: { s1: { running: false } } })
  // 立即让另一个会话结束：应落在去重窗口内
  harness.update({ byId: { s1: { running: false }, s2: { running: true } } })
  harness.update({ byId: { s1: { running: false }, s2: { running: false } } })
  assert.equal(harness.plays.length, 1, 'DEDUPE 窗口内不应再响')
})
