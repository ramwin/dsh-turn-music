import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandPath, mediaTypeOf, resolveAudio, sanitize } from '../lib/index.js'

test('expandPath 展开 ~ 与绝对路径，空字符串表示"用默认铃声"', () => {
  assert.equal(expandPath(''), '')
  assert.equal(expandPath('   '), '')
  assert.equal(expandPath('~'), homedir())
  assert.equal(expandPath('~/a.mp3'), join(homedir(), 'a.mp3'))
  assert.equal(expandPath('/tmp/x.mp3'), '/tmp/x.mp3')
})

test('sanitize 只接受自己拥有的键，并拒绝不存在的文件', () => {
  const { value, errors } = sanitize({
    enabled: 'yes', // 非布尔
    volume: 140, // 越界 -> 收敛到 100
    maxSeconds: -3, // 越界 -> 收敛到 0
    loop: false,
    file: '/nonexistent/nope.mp3', // 存在性校验
    unknownKey: 'ignored',
  })
  assert.deepEqual(errors.sort(), ['enabled 必须是布尔值', '文件不存在或不可读：/nonexistent/nope.mp3'])
  assert.equal(value.volume, 100)
  assert.equal(value.maxSeconds, 0)
  assert.equal(value.loop, false)
  assert.equal(Object.hasOwn(value, 'unknownKey'), false)
  assert.equal(Object.hasOwn(value, 'enabled'), false)
})

test('sanitize 拒绝非音频扩展名，接受空路径（回到默认铃声）', () => {
  const rejected = sanitize({ file: '/etc/hostname' })
  assert.equal(rejected.value.file, undefined)
  assert.match(rejected.errors[0], /不支持的音频格式/)

  const cleared = sanitize({ file: '' })
  assert.deepEqual(cleared.errors, [])
  assert.equal(cleared.value.file, '')
})

test('sanitize 保留 1% 步进的音量精度', () => {
  const { value, errors } = sanitize({ volume: 37 })
  assert.deepEqual(errors, [])
  assert.equal(value.volume, 37)
})

test('resolveAudio 在自定义文件不可用时回退到内置铃声', () => {
  const fallback = resolveAudio({ file: '/definitely/missing.mp3' })
  assert.equal(fallback.source, 'bundled')
  assert.match(fallback.path, /assets[/\\]ringtone\.mp3$/)
  assert.ok(fallback.size > 1000, '内置铃声应随包分发')
})

test('mediaTypeOf 给出浏览器可解码的 MIME', () => {
  assert.equal(mediaTypeOf('/a/b.mp3'), 'audio/mpeg')
  assert.equal(mediaTypeOf('/a/b.M4A'), 'audio/mp4')
  assert.equal(mediaTypeOf('/a/b.flac'), 'audio/flac')
  assert.equal(mediaTypeOf('/a/b.unknown'), 'application/octet-stream')
})
