/**
 * dsh-turn-music — host half.
 *
 * Responsibilities, and nothing else:
 *   1. own the configuration (deployment defaults from the Cordis patch entry,
 *      per-user overrides in `$DSH_HOME/turn-music.json`);
 *   2. stream the chosen audio file to the browser, so a custom absolute path
 *      on the host works for a page opened from any machine;
 *   3. accept an uploaded ringtone, for users who cannot reach host paths.
 *
 * The trigger itself lives in the browser half (`./client.js`): only the page
 * knows when a turn finished and only the page can make a sound.
 *
 * @module dsh-turn-music
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; must match the id used by `cordis.patch.yml`. */
export const name = 'turn-music'

/** Required host services: only the web server, for the streaming routes. */
export const inject = ['webServer']

/** Package root (this file lives in `<root>/lib/`). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The ringtone shipped inside the npm package. */
const BUNDLED_RINGTONE = join(PACKAGE_ROOT, 'assets', 'ringtone.mp3')

/** Extensions the browser `<audio>` element can be expected to decode. */
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm',
])

/** Upload ceiling: a ringtone, not a music library. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/**
 * Built-in defaults. A deployment overrides them from its Cordis patch entry:
 *
 * ```yaml
 * - id: turn-music
 *   name: 'dsh-turn-music'
 *   config:
 *     enabled: true
 *     file: /srv/sounds/ring.mp3
 * ```
 *
 * Anything set here is a *default*: the user's own choices in the settings page
 * still win, and "reset" returns to these values.
 */
const DEFAULTS = {
  /** Master switch for the reply-finished sound. */
  enabled: true,
  /** Audio file to play; empty string means the bundled telephone ring. */
  file: '',
  /** Playback volume, 0-100. */
  volume: 80,
  /** Repeat until the user pauses or dismisses the reminder. */
  loop: true,
  /** Safety cap while looping, in seconds; 0 disables the cap. */
  maxSeconds: 120,
  /** Ring only for the session currently on screen instead of every session. */
  onlyCurrent: false,
  /** Skip subagent child sessions (their turn is a step of the parent turn). */
  muteSubagent: true,
}

/** Boolean override keys and their labels, used by the shared validator. */
const BOOLEAN_KEYS = new Set(['enabled', 'loop', 'onlyCurrent', 'muteSubagent'])

/** Numeric override keys with their accepted inclusive ranges. */
const RANGE_KEYS = new Map([
  ['volume', [0, 100]],
  ['maxSeconds', [0, 3600]],
])

/** Mirror of `node:path.join` for the DSH home directory. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/** Where per-user overrides live (shared by every profile and project). */
function overridesPath() {
  return join(dshHome(), 'turn-music.json')
}

/** Where an uploaded ringtone is stored. */
function uploadDir() {
  return join(dshHome(), 'turn-music')
}

/** Where the global playback position lives (shared by every browser/page). */
function positionPath() {
  return join(dshHome(), 'turn-music-position.json')
}

/** Read the saved position; a broken or missing file means "start from the top". */
export function readPosition() {
  try {
    const parsed = JSON.parse(readFileSync(positionPath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = Number(parsed.version)
      const position = Number(parsed.position)
      return {
        version: Number.isFinite(version) ? version : 0,
        position: Number.isFinite(position) && position > 0 ? position : 0,
      }
    }
  } catch {
    /* fall through to "no position" */
  }
  return { version: 0, position: 0 }
}

/** Persist the position (atomic enough: one small write). */
export function writePosition(entry) {
  const file = positionPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Position for the *current* audio: a remembered spot belongs to one file
 * version (mtime), so swapping the ringtone automatically restarts from 0.
 */
export function positionFor(audio) {
  const stored = readPosition()
  if (stored.version !== audio.version || stored.position <= 0) return 0
  return stored.position
}

/** Expand a leading `~` and make the path absolute. */
export function expandPath(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return resolve(text)
}

/** Read the override file; a broken file degrades to "no overrides". */
function readOverrides() {
  const file = overridesPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitize(parsed).value
  } catch {
    return {}
  }
}

/** Persist the complete override object (atomic enough: one small write). */
function writeOverrides(overrides) {
  const file = overridesPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8')
}

/**
 * Validate a partial configuration and keep only the keys the plugin owns.
 * @param raw - untrusted object (request body or override file).
 * @returns the accepted patch plus one message per rejected field.
 */
export function sanitize(raw) {
  const value = {}
  const errors = []
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const [key, input] of Object.entries(source)) {
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof input === 'boolean') value[key] = input
      else errors.push(`${key} 必须是布尔值`)
      continue
    }
    if (RANGE_KEYS.has(key)) {
      const [min, max] = RANGE_KEYS.get(key)
      const number = typeof input === 'string' && input.trim() !== '' ? Number(input) : input
      if (typeof number === 'number' && Number.isFinite(number)) {
        value[key] = Math.min(max, Math.max(min, Math.round(number)))
      } else {
        errors.push(`${key} 必须是数字`)
      }
      continue
    }
    if (key === 'file') {
      if (typeof input !== 'string') {
        errors.push('file 必须是字符串路径')
        continue
      }
      const expanded = expandPath(input)
      if (expanded === '') {
        value.file = ''
        continue
      }
      const extension = extname(expanded).toLowerCase()
      if (!AUDIO_EXTENSIONS.has(extension)) {
        errors.push(`不支持的音频格式：${extension || '(无扩展名)'}`)
        continue
      }
      if (!existsSync(expanded) || !statSync(expanded).isFile()) {
        errors.push(`文件不存在或不可读：${expanded}`)
        continue
      }
      value.file = expanded
      continue
    }
    // Unknown keys are ignored on purpose: a newer client may send a field this
    // host build does not know yet, and that must not break the whole save.
  }
  return { value, errors }
}

/** Which file would play right now, and why. */
export function resolveAudio(config) {
  const custom = typeof config.file === 'string' ? config.file : ''
  if (custom !== '') {
    try {
      if (existsSync(custom) && statSync(custom).isFile()) {
        const stat = statSync(custom)
        return {
          path: custom,
          source: 'custom',
          name: custom.split(/[\\/]/).pop() || custom,
          size: stat.size,
          version: Math.round(stat.mtimeMs),
        }
      }
    } catch {
      /* fall through to the bundled ringtone */
    }
  }
  let size = 0
  let version = 0
  try {
    const stat = statSync(BUNDLED_RINGTONE)
    size = stat.size
    version = Math.round(stat.mtimeMs)
  } catch {
    /* a missing bundled asset is reported by the audio route, not here */
  }
  return { path: BUNDLED_RINGTONE, source: 'bundled', name: 'ringtone.mp3', size, version }
}

/** Read one request body as UTF-8 JSON. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Read one request body as a binary buffer. */
async function readBinary(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('文件过大（上限 32MB）')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Small JSON response helper. */
function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Stream an audio file with single-range support.
 *
 * Range matters even without seeking: Safari refuses to play a resource it
 * cannot range-request, and a looping `<audio>` re-opens the resource.
 */
function sendAudio(req, res, info) {
  let stat
  try {
    stat = statSync(info.path)
  } catch {
    sendJson(res, { ok: false, error: `音频文件不可读：${info.path}` }, 404)
    return
  }
  const headers = {
    'content-type': mediaTypeOf(info.path),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache, max-age=0',
    'last-modified': stat.mtime.toUTCString(),
  }
  const range = req.headers.range
  if (typeof range === 'string' && range.startsWith('bytes=')) {
    const [from, to] = range.slice(6).split('-')
    const start = from === '' ? Math.max(0, stat.size - Number(to)) : Number(from)
    const end = from === '' ? stat.size - 1 : Math.min(Number(to), stat.size - 1)
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
      headers['content-length'] = String(end - start + 1)
      res.writeHead(206, headers)
      createReadStream(info.path, { start, end }).pipe(res)
      return
    }
  }
  headers['content-length'] = String(stat.size)
  res.writeHead(200, headers)
  createReadStream(info.path).pipe(res)
}

/** MIME type for a supported audio extension (browsers are strict about this). */
export function mediaTypeOf(path) {
  switch (extname(path).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.m4a':
    case '.m4b': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.wav': return 'audio/wav'
    case '.ogg':
    case '.oga': return 'audio/ogg'
    case '.opus': return 'audio/opus'
    case '.flac': return 'audio/flac'
    case '.webm': return 'audio/webm'
    default: return 'application/octet-stream'
  }
}

/**
 * Mount the plugin.
 *
 * The Cordis patch entry's `config:` reaches this function as the second
 * argument (cordis plugin convention) — reading `ctx.config` throws
 * `cannot get property "config" without inject`.
 *
 * @param ctx - host Cordis context.
 * @param config - deployment defaults declared by the patch entry.
 */
export function apply(ctx, config) {
  // Deployment-level defaults from the patch entry, validated like any other
  // untrusted input so a typo in yaml cannot hand the browser a weird config.
  const deployment = sanitize(config ?? {}).value

  /** Effective configuration = built-in defaults < deployment < user overrides. */
  const effective = () => ({ ...DEFAULTS, ...deployment, ...readOverrides() })

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://dsh.local')
    const route = url.pathname.replace(/^\/dsh-turn-music\/?/, '').replace(/\/+$/, '')
    try {
      if (route === '' || route === 'config') {
        if (req.method === 'GET' || req.method === undefined) {
          const config = effective()
          const audio = resolveAudio(config)
          sendJson(res, {
            ok: true,
            config,
            defaults: { ...DEFAULTS, ...deployment },
            overrides: readOverrides(),
            audio: {
              source: audio.source,
              name: audio.name,
              size: audio.size,
              version: audio.version,
              url: `/dsh-turn-music/audio?v=${audio.version}`,
            },
            // Global playback position: the next ring continues from here.
            position: positionFor(audio),
            // The browser decides the copy; these strings are what the settings
            // page shows when the bundled ringtone is in use.
            bundledName: '默认电话铃声（叮铃铃 6.5s）',
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJson(req)
          const patch = sanitize(body && typeof body.patch === 'object' && body.patch !== null ? body.patch : body)
          if (patch.errors.length > 0 && Object.keys(patch.value).length === 0) {
            sendJson(res, { ok: false, error: patch.errors.join('；'), errors: patch.errors }, 400)
            return
          }
          const next = { ...readOverrides(), ...patch.value }
          writeOverrides(next)
          const config = effective()
          sendJson(res, {
            ok: true,
            config,
            overrides: next,
            errors: patch.errors,
            audio: resolveAudio(config),
            position: positionFor(resolveAudio(config)),
          })
          return
        }
      }

      if (route === 'reset' && req.method === 'POST') {
        writeOverrides({})
        const config = effective()
        sendJson(res, { ok: true, config, overrides: {}, audio: resolveAudio(config), position: positionFor(resolveAudio(config)) })
        return
      }

      if (route === 'upload' && req.method === 'POST') {
        const buffer = await readBinary(req)
        if (buffer.length === 0) {
          sendJson(res, { ok: false, error: '上传内容为空' }, 400)
          return
        }
        const extension = extname(url.searchParams.get('name') || '').toLowerCase() || '.mp3'
        if (!AUDIO_EXTENSIONS.has(extension)) {
          sendJson(res, { ok: false, error: `不支持的音频格式：${extension}` }, 400)
          return
        }
        const target = join(uploadDir(), `ringtone${extension}`)
        mkdirSync(uploadDir(), { recursive: true })
        writeFileSync(target, buffer)
        const next = { ...readOverrides(), file: target }
        writeOverrides(next)
        const config = effective()
        // A new upload is a new file version, so the remembered spot is 0.
        sendJson(res, { ok: true, file: target, config, overrides: next, audio: resolveAudio(config), position: positionFor(resolveAudio(config)) })
        return
      }

      if (route === 'position') {
        if (req.method === 'POST') {
          const body = await readJson(req)
          const raw = body && typeof body === 'object' ? body.position : 0
          const position = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
          const audio = resolveAudio(effective())
          writePosition({ version: audio.version, position: Math.round(position * 1000) / 1000 })
          sendJson(res, { ok: true, position })
          return
        }
        sendJson(res, { ok: true, position: positionFor(resolveAudio(effective())) })
        return
      }

      if (route === 'audio') {
        sendAudio(req, res, resolveAudio(effective()))
        return
      }

      sendJson(res, { ok: false, error: `未知路由：/${route}` }, 404)
    } catch (error) {
      sendJson(res, { ok: false, error: String(error && error.message ? error.message : error) }, 500)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/dsh-turn-music', handler }),
    'turn-music: routes',
  )
}
