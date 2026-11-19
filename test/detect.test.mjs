import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decide,
  firstMeaningfulMessage,
  hasPriorMeaningfulMessage,
  isIgnoredKind,
  matchesIdPattern,
  matchSource,
  presetEventCount,
  sourceKindOf,
} from '../lib/detect.js'

/** 拼一条会话事件，形状跟真实日志一致：{ type, seq, data }。 */
const userEvent = (seq, kind, extra = {}) => ({
  type: 'user/message',
  seq,
  data: { content: [{ type: 'text', text: 'x' }], source: { kind }, ...extra },
})

test('sourceKindOf：没有 source 的老消息按 user 算', () => {
  assert.equal(sourceKindOf({ content: [] }), 'user')
  assert.equal(sourceKindOf({ source: { kind: 'Schedule' } }), 'schedule')
  assert.equal(sourceKindOf({ source: {} }), 'user')
  assert.equal(sourceKindOf(undefined), 'user')
})

test('isIgnoredKind：系统注入的几种都算注入', () => {
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']) {
    assert.equal(isIgnoredKind(kind), true, kind)
  }
  assert.equal(isIgnoredKind('schedule'), false)
  assert.equal(isIgnoredKind('user'), false)
})

test('matchSource：大小写与空白不敏感', () => {
  assert.equal(matchSource('SCHEDULE', ['schedule']), true)
  assert.equal(matchSource('schedule', [' schedule ']), true)
  assert.equal(matchSource('user', ['schedule']), false)
  assert.equal(matchSource('schedule', []), false)
  assert.equal(matchSource('schedule', undefined), false)
})

test('firstMeaningfulMessage：跳过系统注入，拿到第一条真消息', () => {
  const events = [
    userEvent(9, 'schedule'),
    userEvent(10, 'agent-instructions'),
    userEvent(11, 'runtime-context'),
  ]
  assert.deepEqual(firstMeaningfulMessage(events), { kind: 'schedule', seq: 9 })

  const injectedFirst = [
    userEvent(3, 'agent-instructions'),
    userEvent(4, 'time-context'),
    userEvent(5, 'user'),
  ]
  assert.deepEqual(firstMeaningfulMessage(injectedFirst), { kind: 'user', seq: 5 })
  assert.equal(firstMeaningfulMessage([]), null)
})

test('firstMeaningfulMessage：excludeSeq 跳过正在处理的那条', () => {
  const events = [userEvent(9, 'schedule')]
  assert.deepEqual(firstMeaningfulMessage(events, 9), null)
  assert.equal(hasPriorMeaningfulMessage(events, 9), false)
  assert.equal(hasPriorMeaningfulMessage(events), true)
})

test('hasPriorMeaningfulMessage：只有注入消息的会话还算「没有历史」', () => {
  const events = [userEvent(1, 'agent-instructions'), userEvent(2, 'skill-catalog')]
  assert.equal(hasPriorMeaningfulMessage(events), false)
})

test('presetEventCount：只数 permission/preset', () => {
  const events = [
    { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, data: { policy: 'ask' } },
    { type: 'permission/preset', seq: 7, data: { preset: 'danger-full-access' } },
  ]
  assert.equal(presetEventCount(events), 2)
  assert.equal(presetEventCount([]), 0)
  assert.equal(presetEventCount(undefined), 0)
})

const base = {
  kind: 'schedule',
  sources: ['schedule'],
  targetPreset: 'danger-full-access',
  currentPreset: 'workspace-write',
  firstMessage: true,
  presetCount: 1,
  respectManual: true,
  requireFirstMessage: true,
}

test('decide：定时任务首条消息 → 切', () => {
  assert.equal(decide(base).action, 'promote')
})

test('decide：白名单外的来源一律不动', () => {
  const r = decide({ ...base, kind: 'user' })
  assert.equal(r.action, 'skip')
  assert.match(r.reason, /白名单/)
})

test('decide：已经在目标预设就不用再写事件', () => {
  const r = decide({ ...base, currentPreset: 'danger-full-access' })
  assert.equal(r.action, 'already')
})

test('decide：投递进已有会话时不动那个会话', () => {
  const r = decide({ ...base, firstMessage: false })
  assert.equal(r.action, 'skip')
  assert.match(r.reason, /首条/)

  // 主动关掉这条规则就放行
  assert.equal(decide({ ...base, firstMessage: false, requireFirstMessage: false }).action, 'promote')
})

test('decide：会话预设被人工改过就不覆盖', () => {
  const r = decide({ ...base, presetCount: 2 })
  assert.equal(r.action, 'skip')
  assert.match(r.reason, /人工/)

  assert.equal(decide({ ...base, presetCount: 2, respectManual: false }).action, 'promote')
})

test('decide：sources 支持多个来源', () => {
  assert.equal(decide({ ...base, kind: 'qqtask', sources: ['schedule', 'qqtask'] }).action, 'promote')
})

/* ── 第二条通道：按会话 id 认「插件自己建的会话」 ── */

const ID_PATTERN = '^(my-bot|[0-9a-f-]{36}$)'

test('matchesIdPattern：认得出养鱼会话，认不出 GUI 会话', () => {
  assert.equal(matchesIdPattern(ID_PATTERN, 'my-bot-workdir'), true)
  assert.equal(matchesIdPattern(ID_PATTERN, 'my-bot'), true)
  assert.equal(matchesIdPattern(ID_PATTERN, '85f455ce-a189-4b24-8ae2-a5a5a384e97e'), true)
  assert.equal(matchesIdPattern(ID_PATTERN, 'session-85f455ce-a189-4b24-8ae2-a5a5a384e97e'), false)
  assert.equal(matchesIdPattern(ID_PATTERN, 'session-12'), false)
})

test('matchesIdPattern：留空或坏正则都不命中（不能误伤）', () => {
  assert.equal(matchesIdPattern('', 'my-bot-workdir'), false)
  assert.equal(matchesIdPattern(undefined, 'my-bot-workdir'), false)
  assert.equal(matchesIdPattern('(未闭合', 'my-bot-workdir'), false)
})

test('decide：id 命中时不看来源、不要求首条消息', () => {
  const r = decide({ ...base, kind: 'user', idMatch: true })
  assert.equal(r.action, 'promote')
  assert.match(r.reason, /id/)

  // 插件轮换出来的会话可能已经被投递过好几轮，仍然要能提权
  assert.equal(decide({ ...base, kind: 'user', firstMessage: false, idMatch: true }).action, 'promote')
})

test('decide：id 命中但仍尊重人工修改', () => {
  const r = decide({ ...base, kind: 'user', idMatch: true, presetCount: 3 })
  assert.equal(r.action, 'skip')
  assert.match(r.reason, /人工/)
  assert.equal(decide({ ...base, kind: 'user', idMatch: true, presetCount: 3, respectManual: false }).action, 'promote')
})

test('decide：id 命中且已经在目标预设，不重复写事件', () => {
  const r = decide({ ...base, kind: 'user', idMatch: true, currentPreset: 'danger-full-access' })
  assert.equal(r.action, 'already')
})

test('decide：没命中 id 时行为与以前完全一致', () => {
  assert.equal(decide({ ...base, kind: 'user', idMatch: false }).action, 'skip')
  assert.equal(decide({ ...base, kind: 'schedule', idMatch: false }).action, 'promote')
})
