/**
 * dsh-permission-autoswitch · 判定
 *
 * 只回答一个问题：这个会话该不该被提到目标预设？
 * 全是纯函数，不调用宿主、不读文件，单测直接喂数据。
 *
 * 判定依据（2026-11-16 在 0.2.2-rc.1 上实测过，见 docs/requirements.md）：
 *   - 定时任务投递的用户消息带 source.kind = "schedule"；
 *   - 会话创建那一刻 @deepseek-ai/dsh-permission-presets 已经写死了一条
 *     permission/preset（默认 workspace-write），之后没有任何按来源区分的钩子；
 *   - 所以只能在消息落地前后自己补一刀。
 */

/**
 * 这些 kind 是系统注入的 user 消息，不代表「谁发起了这个会话」，判定时跳过。
 * 前四个来自实测的定时任务会话（seq 9-13）。
 */
export const IGNORED_SOURCE_KINDS = Object.freeze([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
  'system-reminder',
])

/** 这条 user 消息的来源 kind；没有 source 字段的老消息按 "user" 算。 */
export function sourceKindOf(message) {
  const kind = message?.source?.kind
  return typeof kind === 'string' && kind !== '' ? kind.toLowerCase() : 'user'
}

/** 系统注入的那几种不算数。 */
export function isIgnoredKind(kind) {
  return IGNORED_SOURCE_KINDS.includes(String(kind ?? '').toLowerCase())
}

/** 来源是否在白名单里。 */
export function matchSource(kind, sources) {
  const target = String(kind ?? '').trim().toLowerCase()
  if (!Array.isArray(sources)) return false
  return sources.some((item) => String(item ?? '').trim().toLowerCase() === target)
}

/** 取会话事件里的 user/message 数据（事件形状是 { type, data }）。 */
function userMessageData(event) {
  if (event?.type !== 'user/message') return undefined
  return event.data
}

/**
 * 扫一遍事件，找会话里第一条「有效」用户消息。
 * @param events 会话事件数组（按 seq 升序）
 * @param excludeSeq 需要跳过的 seq（正在处理的那一条）
 */
export function firstMeaningfulMessage(events, excludeSeq = null) {
  if (!Array.isArray(events)) return null
  for (const event of events) {
    if (excludeSeq !== null && event?.seq === excludeSeq) continue
    const data = userMessageData(event)
    if (data === undefined) continue
    const kind = sourceKindOf(data)
    if (isIgnoredKind(kind)) continue
    return { kind, seq: event.seq ?? null }
  }
  return null
}

/** 会话里已经有过有效用户消息吗（用来判「是不是这个会话的第一条」）。 */
export function hasPriorMeaningfulMessage(events, excludeSeq = null) {
  return firstMeaningfulMessage(events, excludeSeq) !== null
}

/** 会话里 permission/preset 事件的条数：创建时那一条算 1，多出来就说明有人改过。 */
export function presetEventCount(events) {
  if (!Array.isArray(events)) return 0
  let count = 0
  for (const event of events) {
    if (event?.type === 'permission/preset') count += 1
  }
  return count
}

/**
 * 唯一的判定入口。
 *
 * @param input.kind 触发的来源 kind
 * @param input.sources 白名单
 * @param input.targetPreset 目标预设
 * @param input.currentPreset 会话当前生效的预设（宿主 permissionPresets.current()）
 * @param input.firstMessage 这条是不是会话的首条有效用户消息
 * @param input.presetCount 会话里已有的 permission/preset 条数
 * @param input.respectManual 人工改过就不覆盖
 * @param input.requireFirstMessage 只认首条有效消息
 * @returns {{ action: 'promote' | 'skip' | 'already', reason: string }}
 */
export function decide(input) {
  const kind = String(input?.kind ?? '').toLowerCase()
  const targetPreset = String(input?.targetPreset ?? '')
  const currentPreset = String(input?.currentPreset ?? '')
  const requireFirstMessage = input?.requireFirstMessage !== false
  const respectManual = input?.respectManual !== false

  if (!matchSource(kind, input?.sources)) {
    return { action: 'skip', reason: `来源 ${kind} 不在白名单` }
  }
  if (currentPreset !== '' && currentPreset === targetPreset) {
    return { action: 'already', reason: `已经在 ${targetPreset}` }
  }
  if (requireFirstMessage && input?.firstMessage !== true) {
    return { action: 'skip', reason: '不是会话的首条有效用户消息（投递进了已有会话）' }
  }
  if (respectManual && Number(input?.presetCount ?? 0) > 1) {
    return { action: 'skip', reason: '会话预设已被人工改过' }
  }
  return { action: 'promote', reason: `来源 ${kind}` }
}
