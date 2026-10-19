// dsh-turn-music — browser half.
//
// Loaded by dsh-client-modules as `/plugins/dsh-turn-music/client.js` and run
// through the shell's module table (`window.__ModuleLoader__.load`), the same
// shape the shipped ui-* bundles use: `require()` resolves `react` against the
// shell-seeded instance, so no bundler or build step is needed.
//
// What it does, and why it lives here rather than in the host half:
//   * the turn-finished edge is a *browser* fact — `sessions.list` is the live
//     session list store (each row carries `running`, `origin`, `completed`);
//     a true -> false transition is "the agent just finished a turn";
//   * the sound can only come out of the user's machine, so playback is a
//     plain `<audio>` element here;
//   * the host half only stores config and streams the file over HTTP, which
//     is what makes a custom host path work from any browser.
//
// Services are looked up lazily through ctx.get(): a cordis `inject` entry is a
// hard activation gate, and this plugin must keep working (audio + chip) even
// on a host where the slots service is missing — only the settings page is
// skipped in that case.

window.__ModuleLoader__.load({
  id: 'dsh-turn-music',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/dsh-turn-music'
    /** Live team snapshot served by the `@nanmicoder/dsh-agent-teams` plugin. */
    var TEAM_STATE_URL = '/plugins/dsh-agent-teams/state'
    var DEDUPE_MS = 1200
    /** Ramp length for both the ring-in and the pause/stop fade-out. */
    var FADE_MS = 1000
    /** Fade granularity; ~63 steps make up one second. */
    var FADE_STEP_MS = 16

    var COPY = {
      chipTitle: '回合结束',
      chipPaused: '已暂停',
      play: '▶ 继续',
      pause: '⏸ 暂停',
      dismiss: '✕',
      blocked: '浏览器拦截了自动播放，点一下播放',
      title: '回合提醒音乐',
      intro: '对话（回合）结束时播放一段音乐，提醒你回来看结果。声音只在本浏览器播放，设置对所有会话、所有项目生效。',
      enabled: '启用：回合结束时播放提醒音乐',
      source: '提醒音乐',
      bundled: '默认电话铃声（叮铃铃，6.5 秒，随插件分发）',
      customPath: '自定义文件路径（宿主机绝对路径，留空用默认铃声）',
      pathHint: '例如 /home/me/sounds/ring.mp3 或 ~/Music/ding.mp3；支持 mp3 / m4a / wav / ogg / flac 等',
      pick: '从本机选择文件上传',
      preview: '试听',
      stopPreview: '停止',
      volume: '音量',
      loop: '循环播放，直到我手动暂停或关闭',
      maxSeconds: '最长响多久（秒，0 = 不限）',
      onlyCurrent: '只提醒当前正在看的会话',
      muteSubagent: '忽略子代理会话（含团队子任务：子代理只是父对话的一步）',
      save: '保存',
      saving: '保存中…',
      reset: '恢复默认',
      saved: '已保存',
      failed: '保存失败',
      uploading: '上传中…',
      nowUsing: '当前音源',
      loadFailed: '读取配置失败',
    }

    // ────────────────────────── state & subscribers ──────────────────────────
    var listeners = new Set()
    var config = null // effective config from the host
    var audioInfo = null // {source, name, url}
    var playing = false
    var blocked = false
    var paused = false
    var lastFiredAt = 0
    var audioEl = null
    var stopTimer = null
    var fadeTimer = null
    var fadeToken = 0
    /** Audio position captured when the user paused, replayed on resume. */
    var pausedPosition = null
    /** null = not detected yet, true/false = the team snapshot route is there. */
    var teamStateAvailable = null
    var teamStateDetection = null
    /** Invalidates an in-flight ring probe when a newer turn finishes. */
    var ringToken = 0

    function snapshot() {
      return { config, audioInfo, playing, blocked, paused }
    }

    function emit() {
      var snap = snapshot()
      listeners.forEach(function (fn) {
        try {
          fn(snap)
        } catch (e) {
          /* a broken subscriber must not break the rest */
        }
      })
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }

    // ──────────────────────────── config transport ───────────────────────────
    function applyServerConfig(payload) {
      if (!payload || payload.ok !== true) return
      config = payload.config || config
      var a = payload.audio
      if (a) {
        var url = a.url || API + '/audio?v=' + (a.version || 0)
        audioInfo = { source: a.source, name: a.name, url: url }
      }
      if (config && !config.enabled) stop(true)
      emit()
    }

    async function loadConfig() {
      var response = await fetch(API + '/config', { headers: { accept: 'application/json' } })
      var payload = await response.json()
      applyServerConfig(payload)
      return payload
    }

    async function saveConfig(patch) {
      var response = await fetch(API + '/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch: patch }),
      })
      var payload = await response.json()
      applyServerConfig(payload)
      return payload
    }

    async function resetConfig() {
      var response = await fetch(API + '/reset', { method: 'POST' })
      var payload = await response.json()
      applyServerConfig(payload)
      return payload
    }

    async function uploadRingtone(file) {
      var response = await fetch(API + '/upload?name=' + encodeURIComponent(file.name || 'ringtone.mp3'), {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      var payload = await response.json()
      applyServerConfig(payload)
      return payload
    }

    // ───────────────────────────── audio engine ──────────────────────────────
    function ensureAudio() {
      if (audioEl === null) {
        audioEl = new Audio()
        audioEl.preload = 'auto'
        audioEl.addEventListener('ended', function () {
          if (!config || !config.loop) stop()
        })
        audioEl.addEventListener('error', function () {
          playing = false
          emit()
        })
      }
      return audioEl
    }

    function clearStopTimer() {
      if (stopTimer !== null) {
        clearTimeout(stopTimer)
        stopTimer = null
      }
    }

    function armStopTimer() {
      clearStopTimer()
      if (!config || !config.maxSeconds) return
      stopTimer = setTimeout(function () {
        stop()
      }, config.maxSeconds * 1000)
    }

    /** Configured volume as the `<audio>` 0-1 range. */
    function targetVolume() {
      var percent = config && config.volume != null ? config.volume : 80
      return Math.min(1, Math.max(0, percent / 100))
    }

    function cancelFade() {
      fadeToken += 1
      if (fadeTimer !== null) {
        clearTimeout(fadeTimer)
        fadeTimer = null
      }
    }

    /**
     * Ramp the element to `target`, then run `done`.
     *
     * Steps are counted instead of clocked: a throttled timer only makes the
     * ramp slower, never shorter, and the unit tests can drive it without
     * sleeping for a real second. Every call bumps `fadeToken`, so a pause
     * interrupted by a resume (or a new ring) cancels the previous ramp.
     */
    function fadeTo(target, done) {
      var element = audioEl
      if (element === null) {
        if (done) done()
        return
      }
      cancelFade()
      var token = fadeToken
      var from = element.volume
      var steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS))
      var step = 0
      function tick() {
        if (token !== fadeToken) return
        step += 1
        var progress = Math.min(1, step / steps)
        element.volume = Math.min(1, Math.max(0, from + (target - from) * progress))
        if (progress < 1) {
          fadeTimer = setTimeout(tick, FADE_STEP_MS)
          return
        }
        fadeTimer = null
        if (done) done()
      }
      fadeTimer = setTimeout(tick, FADE_STEP_MS)
    }

    /** Play the reminder. Every trigger path funnels through here. */
    function start(reason) {
      if (!config || config.enabled !== true) return
      var element = ensureAudio()
      element.loop = config.loop === true
      if (audioInfo && audioInfo.url) {
        var wanted = new URL(audioInfo.url, location.href).href
        if (element.src !== wanted) element.src = wanted
      }
      cancelFade()
      try {
        element.currentTime = 0
      } catch (e) {
        /* not loaded yet: play() will start from the top anyway */
      }
      pausedPosition = null
      paused = false
      blocked = false
      playing = true
      // Start silent, then ramp: a reminder that snaps to full volume is
      // startling, and the ramp also hides the seam of a looping ringtone.
      element.volume = 0
      armStopTimer()
      emit()
      var promise = element.play()
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () {
          // Autoplay policy: the page has not been touched yet. Keep the chip
          // visible so one click fixes it instead of silently swallowing the
          // reminder.
          playing = false
          blocked = true
          emit()
        })
      }
      fadeTo(targetVolume())
    }

    /** Fade out, then stop and hide the reminder. `silent` skips the paused marker. */
    function stop(silent) {
      clearStopTimer()
      var element = audioEl
      pausedPosition = null
      playing = false
      blocked = false
      paused = silent === true ? false : true
      emit()
      if (element === null) return
      fadeTo(0, function () {
        try {
          element.pause()
          element.currentTime = 0
        } catch (e) {
          /* nothing loaded */
        }
      })
    }

    function pause() {
      var element = audioEl
      if (element !== null) {
        // Remember the user's spot: the one-second fade-out keeps the element
        // playing until the ramp reaches zero, and resume must not eat it.
        pausedPosition = element.currentTime
      }
      clearStopTimer()
      playing = false
      paused = true
      blocked = false
      emit()
      if (element === null) return
      fadeTo(0, function () {
        try {
          element.pause()
        } catch (e) {
          /* ignore */
        }
      })
    }

    function resume() {
      var element = ensureAudio()
      if (!element.src) {
        start('resume')
        return
      }
      cancelFade()
      if (pausedPosition !== null && Number.isFinite(pausedPosition)) {
        try {
          element.currentTime = pausedPosition
        } catch (e) {
          /* seeking is best effort; playing from the browser's position is fine */
        }
      }
      pausedPosition = null
      paused = false
      playing = true
      blocked = false
      element.volume = 0
      armStopTimer()
      emit()
      var promise = element.play()
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () {
          playing = false
          blocked = true
          emit()
        })
      }
      fadeTo(targetVolume())
    }

    function dismiss() {
      stop(true)
    }

    function preview() {
      var element = ensureAudio()
      start('preview')
      element.loop = false
      element.addEventListener('ended', function once() {
        element.removeEventListener('ended', once)
        if (config && config.loop) element.loop = true
        // A finished preview must not leave the reminder chip up as if a
        // real turn had ended.
        if (playing) stop(true)
      })
    }

    // ─────────────────────────── turn-finished watcher ───────────────────────
    /** Lazy service lookup: a plain property read throws without `inject`. */
    function lookup(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') return ctx.get(name) || null
      } catch (e) {
        /* service not present */
      }
      try {
        if (ctx && ctx.reflect && typeof ctx.reflect.get === 'function') return ctx.reflect.get(name) || null
      } catch (e) {
        /* ignore */
      }
      return null
    }

    function currentSessionId(snapshot) {
      if (!snapshot) return undefined
      if (typeof snapshot.current === 'string') return snapshot.current
      if (snapshot.current && typeof snapshot.current === 'object' && typeof snapshot.current.id === 'string') {
        return snapshot.current.id
      }
      return undefined
    }

    // ───────────────────────────── team awareness ────────────────────────────
    // Agent Teams runs on child Sessions: the lead owns the `agentTeam`
    // projection and every teammate is a `origin: 'subagent'` child of it. A
    // teammate finishing is one step of the lead's flow, and the lead itself
    // ends a turn whenever it yields while the team keeps working — neither is
    // "the agent is done", so neither may ring.

    /** The `agentTeam` projection of one session, when it is a Team lead. */
    function teamProjection(snapshot, id) {
      var bySession = snapshot && snapshot.projectionsBySession
      var entry = bySession && bySession[id]
      var values = entry && entry.values
      var team = values && values.agentTeam
      return team !== null && typeof team === 'object' ? team : null
    }

    /** True for a teammate Session: a subagent child of a Team lead. */
    function isTeamMember(snapshot, id, row) {
      if (!row || row.origin !== 'subagent') return false
      var parentId = row.parentId || row.parentSessionId
      if (!parentId) return false
      var team = teamProjection(snapshot, parentId)
      if (team === null) return false
      var members = Array.isArray(team.members) ? team.members : []
      for (var i = 0; i < members.length; i += 1) {
        if (members[i] && members[i].id === id) return true
      }
      return false
    }

    /**
     * Is the Team still moving? A task in `in_progress` or a teammate session
     * that is still running means the lead merely yielded; the sound is
     * deferred until nothing is in flight. Pending tasks alone are not "in
     * flight" — a team waiting for user approval should ring.
     */
    function teamStillWorking(team, rows, leadId) {
      if (team === null) return false
      var tasks = Array.isArray(team.tasks) ? team.tasks : []
      for (var i = 0; i < tasks.length; i += 1) {
        if (tasks[i] && tasks[i].status === 'in_progress') return true
      }
      var ids = rows ? Object.keys(rows) : []
      for (var j = 0; j < ids.length; j += 1) {
        var row = rows[ids[j]]
        if (!row || row.origin !== 'subagent' || row.running !== true) continue
        var parentId = row.parentId || row.parentSessionId
        if (parentId === leadId) return true
      }
      return false
    }

    /** True when one live team snapshot still has in-flight work. */
    function teamSnapshotBusy(team) {
      if (!team || team.halted === true) return false
      // A staged plan is waiting for the user's approval: that is exactly the
      // moment the reminder must ring.
      if (team.phase === 'staged') return false
      var tasks = Array.isArray(team.tasks) ? team.tasks : []
      for (var i = 0; i < tasks.length; i += 1) {
        var status = tasks[i] && tasks[i].status
        if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'deleted') return true
      }
      var members = Array.isArray(team.members) ? team.members : []
      for (var j = 0; j < members.length; j += 1) {
        if (members[j] && members[j].activity === 'working') return true
      }
      return false
    }

    /**
     * Detect the optional Agent Teams snapshot route once, so a ring on a host
     * without that plugin stays synchronous (no extra round-trip per turn).
     */
    function detectTeamState() {
      if (teamStateDetection !== null) return teamStateDetection
      teamStateDetection = fetch(TEAM_STATE_URL, { cache: 'no-store' })
        .then(function (response) {
          if (!response || response.ok !== true) return false
          return response.json().then(function (body) {
            return body !== null && typeof body === 'object' && Array.isArray(body.teams)
          })
        })
        .catch(function () {
          return false
        })
        .then(function (supported) {
          teamStateAvailable = supported === true
          return teamStateAvailable
        })
      return teamStateDetection
    }

    /**
     * Every session (lead and teammates) that belongs to a live team which
     * still has in-flight work. Resolves to null when the probe cannot answer
     * (route gone, network error) — a failed probe must never swallow the
     * reminder.
     */
    function probeBusyTeams() {
      return fetch(TEAM_STATE_URL, { cache: 'no-store' })
        .then(function (response) {
          if (!response || response.ok !== true) {
            teamStateAvailable = false
            return null
          }
          return response.json()
        })
        .then(function (body) {
          if (!body || !Array.isArray(body.teams)) return null
          var busy = new Set()
          body.teams.forEach(function (team) {
            if (!team || teamSnapshotBusy(team) !== true) return
            if (team.captainSessionId) busy.add(team.captainSessionId)
            var members = Array.isArray(team.members) ? team.members : []
            members.forEach(function (member) {
              if (member && member.id) busy.add(member.id)
            })
          })
          return busy
        })
        .catch(function () {
          return null
        })
    }

    /**
     * Watch the session list and ring on every running -> finished edge.
     *
     * The first snapshot is a baseline: sessions already running when the page
     * opens must not ring (that would turn every refresh into a false alarm).
     */
    function watchSessions(ctx) {
      var previous = new Map()
      var seeded = false
      var store = null
      var unsubscribe = null

      var onChange = function () {
        if (!store || typeof store.getSnapshot !== 'function') return
        var snapshotNow
        try {
          snapshotNow = store.getSnapshot()
        } catch (e) {
          return
        }
        var rows = (snapshotNow && snapshotNow.byId) || {}
        var current = currentSessionId(snapshotNow)
        var finished = []
        Object.keys(rows).forEach(function (id) {
          var row = rows[id]
          if (!row) return
          var runningNow = row.running === true
          var wasRunning = previous.get(id) === true
          previous.set(id, runningNow)
          if (!runningNow && wasRunning) finished.push({ id: id, row: row })
        })
        if (!seeded) {
          seeded = true
          return
        }
        if (finished.length === 0) return
        var usable = finished.filter(function (item) {
          if (!config) return true
          if (config.muteSubagent !== false && item.row.origin === 'subagent') return false
          // Team mode is muted regardless of the subagent toggle: a teammate is
          // a step of the lead's flow, not a turn the user is waiting on.
          if (isTeamMember(snapshotNow, item.id, item.row)) return false
          if (teamStillWorking(teamProjection(snapshotNow, item.id), rows, item.id)) return false
          if (config.onlyCurrent === true && current !== undefined && item.id !== current) return false
          return true
        })
        if (usable.length === 0) return
        var now = Date.now()
        if (now - lastFiredAt < DEDUPE_MS) return
        var fire = function () {
          lastFiredAt = Date.now()
          start('turn-end')
        }
        if (teamStateAvailable !== true) {
          fire()
          return
        }
        // The third-party Agent Teams panel keeps its own team state; ask it
        // whether the finished session merely yielded to a teammate. A newer
        // turn-finished edge invalidates this probe.
        var token = ++ringToken
        probeBusyTeams().then(function (busy) {
          if (token !== ringToken) return
          var free = busy === null || usable.some(function (item) { return !busy.has(item.id) })
          if (free) fire()
        })
      }

      var bind = function () {
        if (unsubscribe !== null) return true
        var sessions = lookup(ctx, 'sessions')
        var list = sessions && sessions.list
        if (!list || typeof list.subscribe !== 'function') return false
        store = list
        unsubscribe = list.subscribe(onChange)
        onChange()
        return true
      }

      if (!bind()) {
        var timer = setInterval(function () {
          if (bind()) clearInterval(timer)
        }, 1500)
        return function () {
          clearInterval(timer)
          if (unsubscribe !== null) unsubscribe()
        }
      }
      return function () {
        if (unsubscribe !== null) unsubscribe()
      }
    }

    // ───────────────────────────── reminder chip ─────────────────────────────
    // Plain DOM on purpose: the chip must survive app re-renders and be
    // clickable even while the settings card is unmounted.
    var chip = null
    var chipLabel = null
    var chipToggle = null

    function ensureChip() {
      if (chip !== null) return chip
      chip = document.createElement('div')
      chip.setAttribute('data-dsh-turn-music-chip', '')
      chip.style.cssText = [
        'position:fixed',
        'right:18px',
        'bottom:18px',
        'z-index:2147483000',
        'display:none',
        'align-items:center',
        'gap:10px',
        'padding:8px 12px',
        'border-radius:12px',
        'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        'background:var(--dsw-alias-bg-layer-2, rgba(28,28,30,0.92))',
        'box-shadow:var(--dsw-elevation-prominent, 0 6px 24px rgba(0,0,0,0.28))',
        'color:var(--dsw-alias-label-primary, inherit)',
        'font-size:12px',
        'line-height:1.4',
        'backdrop-filter:var(--dsw-mask-blur, blur(6px))',
      ].join(';')

      var dot = document.createElement('span')
      dot.textContent = '🔔'
      dot.style.cssText = 'font-size:14px'
      chip.appendChild(dot)

      chipLabel = document.createElement('span')
      chip.appendChild(chipLabel)

      chipToggle = document.createElement('button')
      chipToggle.type = 'button'
      chipToggle.style.cssText = [
        'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        'background:transparent',
        'color:inherit',
        'border-radius:8px',
        'padding:2px 8px',
        'font-size:12px',
        'cursor:pointer',
      ].join(';')
      chipToggle.addEventListener('click', function () {
        if (playing) pause()
        else if (blocked || paused) resume()
        else start('chip')
      })
      chip.appendChild(chipToggle)

      var close = document.createElement('button')
      close.type = 'button'
      close.textContent = COPY.dismiss
      close.setAttribute('aria-label', '关闭提醒')
      close.style.cssText = [
        'border:none',
        'background:transparent',
        'color:var(--dsw-alias-label-secondary, inherit)',
        'cursor:pointer',
        'font-size:12px',
        'padding:0 2px',
      ].join(';')
      close.addEventListener('click', dismiss)
      chip.appendChild(close)

      document.body.appendChild(chip)
      renderChip(snapshot())
      return chip
    }

    function renderChip(snap) {
      if (chip === null) return
      var visible = snap.playing || snap.paused || snap.blocked
      chip.style.display = visible ? 'flex' : 'none'
      if (!visible) return
      if (snap.blocked) chipLabel.textContent = COPY.blocked
      else if (snap.playing) chipLabel.textContent = COPY.chipTitle
      else chipLabel.textContent = COPY.chipPaused
      chipToggle.textContent = snap.playing ? COPY.pause : COPY.play
    }

    // ─────────────────────────── settings card (React) ───────────────────────
    function Field(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '14px 0' } },
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, props.label),
        props.children,
      )
    }

    function Check(props) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: function (event) {
            props.onChange(event.target.checked)
          },
        }),
        h('span', {}, props.label),
      )
    }

    function inputStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-mask-1, transparent)',
        color: 'inherit',
        fontSize: '12px',
        fontFamily: 'inherit',
      }
    }

    function SettingsCard() {
      var statePair = React.useState(null)
      var view = statePair[0]
      var setView = statePair[1]
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var statusPair = React.useState('')
      var status = statusPair[0]
      var setStatus = statusPair[1]

      React.useEffect(function () {
        var alive = true
        loadConfig()
          .then(function (payload) {
            if (!alive) return
            setView(payload)
            setDraft(payload.config || {})
          })
          .catch(function (error) {
            if (alive) setStatus(COPY.loadFailed + '：' + (error && error.message ? error.message : error))
          })
        var off = subscribe(function (snap) {
          if (snap.config) setView({ config: snap.config, audio: snap.audioInfo })
        })
        return function () {
          alive = false
          off()
        }
      }, [])

      function update(key, value) {
        setDraft(function (previous) {
          var next = Object.assign({}, previous || {})
          next[key] = value
          return next
        })
      }

      async function submit() {
        setStatus(COPY.saving)
        try {
          var payload = await saveConfig(draft || {})
          if (payload && payload.ok) {
            setView(payload)
            setDraft(payload.config || {})
            setStatus(payload.errors && payload.errors.length ? COPY.failed + '：' + payload.errors.join('；') : COPY.saved)
          } else {
            setStatus(COPY.failed + '：' + ((payload && payload.error) || '未知错误'))
          }
        } catch (error) {
          setStatus(COPY.failed + '：' + (error && error.message ? error.message : error))
        }
      }

      async function restore() {
        setStatus(COPY.saving)
        try {
          var payload = await resetConfig()
          setView(payload)
          setDraft(payload.config || {})
          setStatus(COPY.saved)
        } catch (error) {
          setStatus(COPY.failed + '：' + (error && error.message ? error.message : error))
        }
      }

      async function pick(event) {
        var file = event.target.files && event.target.files[0]
        if (!file) return
        setStatus(COPY.uploading)
        try {
          var payload = await uploadRingtone(file)
          if (payload && payload.ok) {
            setView(payload)
            setDraft(payload.config || {})
            setStatus(COPY.saved)
          } else {
            setStatus(COPY.failed + '：' + ((payload && payload.error) || '未知错误'))
          }
        } catch (error) {
          setStatus(COPY.failed + '：' + (error && error.message ? error.message : error))
        }
        event.target.value = ''
      }

      if (draft === null) {
        return h(
          'div',
          { style: { padding: '18px 4px', fontSize: '13px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, COPY.title),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, status || COPY.loadFailed),
        )
      }

      var usingBundled = !draft.file
      var usingName = usingBundled ? COPY.bundled : draft.file

      return h(
        'div',
        { style: { padding: '4px 2px 24px', fontSize: '13px', maxWidth: '640px' } },
        h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '6px' } }, COPY.title),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: 1.6 } }, COPY.intro),

        h(Check, {
          checked: draft.enabled === true,
          label: COPY.enabled,
          onChange: function (value) {
            update('enabled', value)
          },
        }),

        h(
          'div',
          {
            style: {
              marginTop: '18px',
              paddingTop: '10px',
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
            },
          },
          h('div', { style: { fontWeight: 600 } }, COPY.source),
          h(
            'div',
            { style: { marginTop: '6px', color: 'var(--dsw-alias-label-secondary, inherit)' } },
            COPY.nowUsing + '：' + usingName,
          ),
        ),

        h(
          Field,
          { label: COPY.customPath },
          h('input', {
            type: 'text',
            value: draft.file || '',
            placeholder: '/home/me/sounds/ring.mp3',
            onChange: function (event) {
              update('file', event.target.value)
            },
            style: inputStyle(),
          }),
          h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, COPY.pathHint),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 4px' } },
          h('input', {
            type: 'file',
            accept: 'audio/*',
            onChange: pick,
            style: { fontSize: '12px' },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: preview,
              style: {
                padding: '5px 12px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            COPY.preview,
          ),
        ),

        h(
          Field,
          { label: COPY.volume + '（' + (draft.volume == null ? 80 : draft.volume) + '%）' },
          h('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 1,
            value: draft.volume == null ? 80 : draft.volume,
            onChange: function (event) {
              update('volume', Number(event.target.value))
            },
            style: { width: '100%' },
          }),
        ),

        h(Check, {
          checked: draft.loop !== false,
          label: COPY.loop,
          onChange: function (value) {
            update('loop', value)
          },
        }),

        h(
          Field,
          { label: COPY.maxSeconds },
          h('input', {
            type: 'number',
            min: 0,
            max: 3600,
            value: draft.maxSeconds == null ? 120 : draft.maxSeconds,
            onChange: function (event) {
              update('maxSeconds', Number(event.target.value))
            },
            style: Object.assign(inputStyle(), { width: '140px' }),
          }),
        ),

        h(Check, {
          checked: draft.onlyCurrent === true,
          label: COPY.onlyCurrent,
          onChange: function (value) {
            update('onlyCurrent', value)
          },
        }),

        h(Check, {
          checked: draft.muteSubagent !== false,
          label: COPY.muteSubagent,
          onChange: function (value) {
            update('muteSubagent', value)
          },
        }),

        h(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '18px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: submit,
              style: {
                padding: '7px 18px',
                borderRadius: '8px',
                border: 'none',
                background: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4d6bfe)',
                color: '#fff',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            COPY.save,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: restore,
              style: {
                padding: '7px 14px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
                cursor: 'pointer',
              },
            },
            COPY.reset,
          ),
          status
            ? h(
                'span',
                {
                  style: {
                    fontSize: '12px',
                    color: status.indexOf(COPY.failed) === 0
                      ? 'var(--dsw-alias-state-error-primary, #e5484d)'
                      : 'var(--dsw-alias-label-secondary, inherit)',
                  },
                },
                status,
              )
            : null,
        ),
      )
    }

    // ──────────────────────────────── plugin ─────────────────────────────────
    /** Services the settings page needs; audio + chip work without them. */
    const inject = ['slots']

    /**
     * Where the configuration page appears.
     *
     *  - `settings.plugins.tab`: one tab inside Settings → Plugins (内置插件),
     *    i.e. exactly "在设置里开关" — this is the primary entry;
     *  - `plugins.item`: the sidebar Plugins panel card, the convention the
     *    shipped in-host plugin pages follow, so the page is also reachable
     *    from there.
     *
     * Both render the same component; each mount owns its own form state.
     */
    function registerSettingsPages(ctx) {
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
      var options = function (name) {
        return {
          name: name,
          id: 'turn-music',
          order: 60,
          label: function () {
            return COPY.title
          },
        }
      }
      ctx.effect(
        () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(options('settings.plugins.tab'), SettingsCard)),
        'dsh-turn-music: settings tab',
      )
      ctx.effect(
        () => ctx.slots.inject('plugins.item', () => ctx.slots.register(options('plugins.item'), SettingsCard)),
        'dsh-turn-music: plugins panel card',
      )
    }

    /**
     * Mount the plugin.
     * @param ctx - browser Cordis context.
     */
    function apply(ctx) {
      ensureChip()
      subscribe(renderChip)
      loadConfig().catch(function (error) {
        try {
          console.warn('[dsh-turn-music] 读取配置失败', error)
        } catch (e) {
          /* ignore */
        }
      })
      // Optional: the Agent Teams panel's snapshot route (see detectTeamState).
      detectTeamState()
      ctx.effect(function () {
        return watchSessions(ctx)
      }, 'dsh-turn-music: turn watcher')
      registerSettingsPages(ctx)
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
