import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, FIELDS, mergeConfig, normalizeField, normalizeSources, resolveConfig } from '../lib/config.js'

test('默认配置：定时任务来源、目标完全权限、不开 dryRun', () => {
  assert.deepEqual([...DEFAULTS.sources], ['schedule'])
  assert.equal(DEFAULTS.targetPreset, 'danger-full-access')
  assert.equal(DEFAULTS.enabled, true)
  assert.equal(DEFAULTS.dryRun, false)
  assert.equal(DEFAULTS.requireFirstMessage, true)
})

test('normalizeSources：去空白、去重、小写、接受字符串', () => {
  assert.deepEqual(normalizeSources(['Schedule', ' schedule ', '', 42]), ['schedule'])
  assert.deepEqual(normalizeSources('schedule, QQTask ,schedule'), ['schedule', 'qqtask'])
  assert.deepEqual(normalizeSources(undefined), [])
})

test('normalizeField：类型不对就拒收，不抛错', () => {
  assert.deepEqual(normalizeField('enabled', 'yes'), { ok: false, reason: 'enabled 需要 true/false' })
  assert.deepEqual(normalizeField('enabled', true), { ok: true, value: true })
  assert.equal(normalizeField('targetPreset', '  ').ok, false)
  assert.deepEqual(normalizeField('targetPreset', ' read-only '), { ok: true, value: 'read-only' })
  assert.equal(normalizeField('sources', []).ok, false)
  assert.equal(normalizeField('nope', 1).ok, false)
})

test('normalizeField：sessionIdPattern 留空放行，坏正则拒收', () => {
  assert.deepEqual(normalizeField('sessionIdPattern', '  '), { ok: true, value: '' })
  assert.deepEqual(normalizeField('sessionIdPattern', ' ^bili-whale '), { ok: true, value: '^bili-whale' })
  assert.equal(normalizeField('sessionIdPattern', 1).ok, false)
  const bad = normalizeField('sessionIdPattern', '(未闭合')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /不是合法正则/)
})

test('mergeConfig：sessionIdPattern 有值就用，没写就留默认空串', () => {
  assert.equal(DEFAULTS.sessionIdPattern, '')
  const { config } = mergeConfig(DEFAULTS, { sessionIdPattern: '^(bili-whale|[0-9a-f-]{36}$)' })
  assert.equal(config.sessionIdPattern, '^(bili-whale|[0-9a-f-]{36}$)')
  assert.equal(mergeConfig(DEFAULTS, {}).config.sessionIdPattern, '')
})

test('mergeConfig：坏字段跳过，好字段生效', () => {
  const { config, rejected } = mergeConfig(DEFAULTS, {
    enabled: false,
    targetPreset: 'read-only',
    sources: ['schedule', 'qqtask'],
    dryRun: 'no',
    verbose: true,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.targetPreset, 'read-only')
  assert.deepEqual(config.sources, ['schedule', 'qqtask'])
  assert.equal(config.dryRun, false)
  assert.equal(config.verbose, true)
  assert.deepEqual(rejected.map((item) => item.key), ['dryRun'])
})

test('mergeConfig：不认识的字段直接忽略', () => {
  const { config, rejected } = mergeConfig(DEFAULTS, { 乱写: 1 })
  assert.equal(rejected.length, 0)
  assert.deepEqual(config, { ...DEFAULTS, sources: [...DEFAULTS.sources] })
})

test('mergeConfig：默认值不会被原地改掉', () => {
  const { config } = mergeConfig(DEFAULTS, { sources: ['qqtask'] })
  config.sources.push('user')
  assert.deepEqual([...DEFAULTS.sources], ['schedule'])
})

test('resolveConfig：设置页（saved）盖过 patch 里的 config', () => {
  const { config } = resolveConfig(
    { targetPreset: 'read-only', verbose: true },
    { targetPreset: 'danger-full-access' },
  )
  assert.equal(config.targetPreset, 'danger-full-access')
  assert.equal(config.verbose, true)   // patch 里独有的一项留着
})

test('resolveConfig：两层都有坏值时都报出来，且不影响好值', () => {
  const { config, rejected } = resolveConfig({ enabled: 'off' }, { sources: [] })
  assert.equal(config.enabled, true)
  assert.deepEqual([...config.sources], ['schedule'])
  assert.deepEqual(rejected.map((item) => item.key).sort(), ['enabled', 'sources'])
})

test('FIELDS 覆盖 DEFAULTS 的每个键', () => {
  assert.deepEqual([...FIELDS].sort(), Object.keys(DEFAULTS).sort())
})
