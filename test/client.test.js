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
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
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
 * @param teams - `@nanmicoder/dsh-agent-teams` snapshots, or null when that
 *   plugin (and therefore its state route) is absent.
 */
function loadClient(overrides, teams = null) {
  const plays = []
  const pauses = []
  const audios = []
  const managed = []
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
      this.currentTime = 0
      this.paused = true
      this.listeners = {}
      audios.push(this)
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn
    }
    play() {
      this.paused = false
      plays.push({ src: this.src, loop: this.loop, volume: this.volume, currentTime: this.currentTime })
      return Promise.resolve()
    }
    pause() {
      this.paused = true
      pauses.push({ src: this.src, currentTime: this.currentTime })
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
    body: {
      appendChild(child) {
        managed.push(child)
        return child
      },
    },
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
  const fetchFake = async (url) => {
    if (url === '/plugins/dsh-agent-teams/state') {
      if (teams === null) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ teams }) }
    }
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
    /** The reminder chip, once `apply()` created it. */
    chip() {
      return managed.find((element) => element.attributes['data-dsh-turn-music-chip'] !== undefined) || null
    },
    /** Push a new session-list snapshot into the watcher. */
    update(next) {
      storeSnapshot = next
      if (storeSubscribe) storeSubscribe()
    },
  }
}

/** The chip's ▶/⏸ button (dot, label, toggle, close). */
function toggleButton(harness) {
  const chip = harness.chip()
  assert.ok(chip, 'chip should exist after apply()')
  return chip.children.find((child) => child.tagName === 'button')
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

test('暂停 1 秒渐弱后停下，并记住位置；继续从暂停处播放', async () => {
  const harness = loadClient({})
  await settle()
  harness.update({ byId: { s1: { running: true } } })
  harness.update({ byId: { s1: { running: false } } })
  harness.clock.advance(1100)

  const audio = harness.audios[0]
  assert.equal(audio.volume, 0.7)
  const toggle = toggleButton(harness)

  audio.currentTime = 4.2
  toggle.onclick()
  assert.equal(harness.pauses.length, 0, '渐弱期间不应立刻硬切')
  assert.equal(harness.chip().children[1].textContent, '已暂停')

  harness.clock.advance(1100)
  assert.equal(harness.pauses.length, 1, '渐弱结束后才真正暂停')
  assert.equal(audio.volume, 0)

  toggle.onclick()
  assert.equal(harness.plays.length, 2)
  assert.equal(harness.plays[1].currentTime, 4.2, '从暂停的位置继续')
  harness.clock.advance(1100)
  assert.equal(audio.volume, 0.7, '继续时同样渐强')
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

test('团队子任务完成不响，即使关掉「忽略子代理」', async () => {
  const harness = loadClient({ muteSubagent: false })
  await settle()

  // baseline: lead 与 teammate 都在跑
  harness.update(teamSnapshot({ leadRunning: true, teammateRunning: true }))
  // lead 让出回合，teammate 还在跑
  harness.update(teamSnapshot({ leadRunning: false, teammateRunning: true }))
  assert.equal(harness.plays.length, 0, '团队仍在工作时 lead 的让出不是“完成”')

  // teammate 完成
  harness.update(teamSnapshot({ leadRunning: false, teammateRunning: false }))
  assert.equal(harness.plays.length, 0, '子任务完成不应响')
})

test('团队整体完成（任务收尾、成员空闲）后 lead 结束才响', async () => {
  const harness = loadClient({ muteSubagent: false })
  await settle()

  harness.update(teamSnapshot({ leadRunning: true, tasks: [teamTask('in_progress')] }))
  harness.update(teamSnapshot({ leadRunning: false, tasks: [teamTask('in_progress')] }))
  assert.equal(harness.plays.length, 0, '还有进行中的任务，不响')

  harness.update(teamSnapshot({ leadRunning: true, tasks: [teamTask('completed')] }))
  harness.update(teamSnapshot({ leadRunning: false, tasks: [teamTask('completed')] }))
  assert.equal(harness.plays.length, 1, '整体完成才响')
})

/**
 * One `@nanmicoder/dsh-agent-teams` live snapshot (see the plugin's
 * `/plugins/dsh-agent-teams/state` route).
 */
function teamsSnapshot(options) {
  return {
    teamId: 'team1',
    captainSessionId: 'lead',
    phase: options.phase || 'running',
    ...(options.halted ? { halted: true } : {}),
    members: [{ id: 'w1', name: 'w1', activity: options.working ? 'working' : 'idle' }],
    tasks: options.tasks || [],
  }
}

test('第三方 Agent Teams：Lead 让出回合不响，子任务完成不响，整体收尾才响', async () => {
  const running = loadClient({ muteSubagent: false }, [
    teamsSnapshot({ tasks: [teamTask('in_progress')], working: true }),
  ])
  await settle()

  running.update({ byId: { lead: { running: true }, w1: { running: true, origin: 'subagent', parentId: 'lead' } } })
  running.update({ byId: { lead: { running: false }, w1: { running: true, origin: 'subagent', parentId: 'lead' } } })
  await settle()
  assert.equal(running.plays.length, 0, '团队还在跑，Lead 让出不是“完成”')

  running.update({ byId: { lead: { running: false }, w1: { running: false, origin: 'subagent', parentId: 'lead' } } })
  await settle()
  assert.equal(running.plays.length, 0, '子任务完成不应响')

  const settled = loadClient({ muteSubagent: false }, [teamsSnapshot({ tasks: [teamTask('completed')] })])
  await settle()
  settled.update({ byId: { lead: { running: true } } })
  settled.update({ byId: { lead: { running: false } } })
  await settle()
  assert.equal(settled.plays.length, 1, '全部收尾后 Lead 结束要响')
})

test('第三方 Agent Teams：staged（等审批）时照常提醒', async () => {
  const harness = loadClient({ muteSubagent: false }, [
    teamsSnapshot({ phase: 'staged', tasks: [teamTask('pending')] }),
  ])
  await settle()
  harness.update({ byId: { lead: { running: true } } })
  harness.update({ byId: { lead: { running: false } } })
  await settle()
  assert.equal(harness.plays.length, 1, '等审批是用户的回合，需要提醒')
})

test('团队停下来等用户审批（无进行中任务、无人运行）时仍会提醒', async () => {
  const harness = loadClient({ muteSubagent: false })
  await settle()

  harness.update(teamSnapshot({ leadRunning: true, tasks: [teamTask('pending')] }))
  harness.update(teamSnapshot({ leadRunning: false, tasks: [teamTask('pending')] }))
  assert.equal(harness.plays.length, 1, '等审批是用户的回合，需要提醒')
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

test('下一回合从上次停止的位置继续（全局进度），而不是从头再响', async () => {
  const harness = loadClient({})
  await settle()
  const realNow = Date.now
  let fakeNow = realNow()
  Date.now = () => fakeNow
  try {
    harness.update({ byId: { s1: { running: true } } })
    harness.update({ byId: { s1: { running: false } } })
    assert.equal(harness.plays.length, 1)
    assert.equal(harness.plays[0].currentTime, 0, '第一次仍然从头开始')

    const audio = harness.audios[0]
    audio.currentTime = 4.2
    // ✕ 关掉这一次：记下位置（渐弱结束后真正停下）
    const close = harness.chip().children.find((child) => child.tagName === 'button' && child.textContent === '✕')
    close.onclick()
    harness.clock.advance(1100)
    assert.equal(harness.pauses.length, 1, '渐弱结束后停下')
    assert.equal(harness.pauses[0].currentTime, 4.2, '停在记住的位置，不回 0')
    assert.equal(audio.currentTime, 4.2, '元素也停在记住的位置')

    // 跨过去重窗口后新的回合结束：从 4.2 继续，而不是从头
    fakeNow += 5000
    harness.update({ byId: { s1: { running: true } } })
    harness.update({ byId: { s1: { running: false } } })
    assert.equal(harness.plays.length, 2)
    assert.equal(harness.plays[1].currentTime, 4.2, '新回合从上次停止处继续')
  } finally {
    Date.now = realNow
  }
})

test('正在响时新的回合结束不会从头，也不会跳走', async () => {
  const harness = loadClient({})
  await settle()
  const realNow = Date.now
  let fakeNow = realNow()
  Date.now = () => fakeNow
  try {
    harness.update({ byId: { s1: { running: true } } })
    harness.update({ byId: { s1: { running: false } } })
    assert.equal(harness.plays.length, 1)

    const audio = harness.audios[0]
    audio.currentTime = 3.7
    audio.paused = false
    fakeNow += 5000
    harness.update({ byId: { s1: { running: true } } })
    harness.update({ byId: { s1: { running: false } } })
    assert.equal(harness.plays.length, 2)
    assert.equal(harness.plays[1].currentTime, 3.7, '还在响就保持现场位置')
  } finally {
    Date.now = realNow
  }
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
