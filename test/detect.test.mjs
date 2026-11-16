import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decide,
  firstMeaningfulMessage,
  hasPriorMeaningfulMessage,
  isIgnoredKind,
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
