/**
 * Browser-half logic test: no jsdom, no browser — just the globals the bundle
 * touches, so the turn-finished edge and the audio engine can be asserted on
 * the real code.
 *
 * The client bundle is loaded the way the shell loads it
 * (`window.__ModuleLoader__.load({factory})`) and then driven through a fake
 * `sessions.list` store, a fake `<audio>` element and a fake timer clock (so a
 * one-second fade costs no real time).
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
 * Controllable timer clock: `advance(ms)` runs every timer that becomes due,
 * including ones scheduled by the callbacks themselves.
 */
function makeClock() {
  let nowMs = 0
  let sequence = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++sequence
      timers.set(id, { fn, at: nowMs + Math.max(0, Number(ms) || 0), sequence: id })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = nowMs + ms
      for (;;) {
        let next = null
        for (const timer of timers.values()) {
          if (timer.at > target) continue
          if (next === null || timer.at < next.at || (timer.at === next.at && timer.sequence < next.sequence)) next = timer
        }
        if (next === null) break
        for (const [id, timer] of timers) {
          if (timer === next) {
            timers.delete(id)
            break
          }
        }
        nowMs = next.at
        next.fn()
      }
      nowMs = target
    },
  }
}

/**
 * Load the bundle and return a harness.
 * @param overrides - host config the fake `/config` endpoint answers with.
 */
function loadClient(overrides) {
  const plays = []
  const pauses = []
  const audios = []
  let captured = null
  let storeSubscribe = null
  let storeSnapshot = { byId: {} }
  const effects = []
  const clock = makeClock()

  class FakeAudio {
    constructor() {
      this.src = ''
      this.loop = false
      this.volume = 1
      this.listeners = {}
      audios.push(this)
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
  const fetchFake = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: { enabled: true, file: '', volume: 70, loop: true, maxSeconds: 0, onlyCurrent: false, muteSubagent: true, ...overrides },
        audio: { source: 'bundled', name: 'ringtone.mp3', version: 1, url: '/dsh-turn-music/audio?v=1' },
      }),
    }
  }

  factory(
    window,
    document,
    FakeAudio,
    fetchFake,
    { href: 'http://127.0.0.1:3080/' },
    URL,
    clock.setTimeout.bind(clock),
    clock.clearTimeout.bind(clock),
    () => 1,
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
    audios,
    effects,
    clock,
    /** Push a new session-list snapshot into the watcher. */
    update(next) {
      storeSnapshot = next
      if (storeSubscribe) storeSubscribe()
    },
  }
}

/** One Team lead plus one teammate, as the browser session list sees them. */
function teamSnapshot(options) {
  const tasks = options.tasks || []
  const leadRunning = options.leadRunning === true
  const teammateRunning = options.teammateRunning === true
  return {
    byId: {
      lead: { id: 'lead', running: leadRunning },
      w1: { id: 'w1', running: teammateRunning, origin: 'subagent', parentId: 'lead' },
    },
    projectionsBySession: {
      lead: {
        values: {
          agentTeam: {
            members: [
              { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
              { id: 'w1', name: 'w1', role: 'teammate', phase: 'active' },
            ],
            tasks,
          },
        },
      },
    },
  }
}

/** A team task in the shape the `agentTeam` projection publishes. */
function teamTask(status) {
  return {
    id: 't1',
    revision: 1,
    subject: 'write the report',
    description: '',
    status,
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
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
  assert.equal(harness.plays[0].loop, true)
})

test('起播 1 秒渐强：从静音升到配置音量', async () => {
  const harness = loadClient({})
  await settle()
  harness.update({ byId: { s1: { running: true } } })
  harness.update({ byId: { s1: { running: false } } })

  const audio = harness.audios[0]
  assert.equal(audio.volume, 0, '起播从静音开始，不突然炸响')
  harness.clock.advance(500)
  assert.ok(audio.volume > 0.2 && audio.volume < 0.5, `半程应在渐强中间，实际 ${audio.volume}`)
  harness.clock.advance(600)
  assert.equal(audio.volume, 0.7, '一秒后到达配置音量')
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
