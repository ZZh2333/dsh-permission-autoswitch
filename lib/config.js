/**
 * dsh-permission-autoswitch · 配置
 *
 * 三层合并：内置默认 ← cordis.patch.yml 里这一行的 config ← 设置页写下的 settings.json。
 * 后面的赢，所以主人在设置页改的一定盖过包里的默认值，也不用重启。
 *
 * 这里只做纯函数的校验与合并，不碰文件；读写文件在 lib/store.js。
 */

/** 配置字段的完整清单，顺序即设置页展示顺序。 */
export const FIELDS = [
  'enabled',
  'targetPreset',
  'sources',
  'sessionIdPattern',
  'dryRun',
  'respectManual',
  'requireFirstMessage',
  'verbose',
]

export const DEFAULTS = Object.freeze({
  /** 总开关：关掉以后插件只在启动时留一行日志。 */
  enabled: true,
  /** 命中后切到的预设名，必须是 permissionPresets 目录里存在的名字。 */
  targetPreset: 'danger-full-access',
  /** 触发来源白名单，比对会话首条用户消息的 source.kind。 */
  sources: Object.freeze(['schedule']),
  /**
   * 会话 id 正则：命中就不看消息来源，直接提权。
   * 给"插件自己建、自己投递"的会话用（这类会话的消息 source.kind 是 user，
   * 和人在 GUI 里说话分不开，只能靠 id 认）。留空 = 关掉这条通道。
   */
  sessionIdPattern: '',
  /** 只记录不切换，用来先观察一周。 */
  dryRun: false,
  /** 会话在创建后被人手动改过预设，就不再覆盖。 */
  respectManual: true,
  /** 只认会话的首条有效用户消息：投递进已有会话的提醒不动那个会话。 */
  requireFirstMessage: true,
  /** 每次判定都留明细日志。 */
  verbose: false,
})

/** 把任意输入整成干净的来源列表：去空白、去重、小写。 */
export function normalizeSources(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const kind = item.trim().toLowerCase()
    if (kind === '' || out.includes(kind)) continue
    out.push(kind)
  }
  return out
}

/**
 * 校验单个字段。
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function normalizeField(key, value) {
  switch (key) {
    case 'enabled':
    case 'dryRun':
    case 'respectManual':
    case 'requireFirstMessage':
    case 'verbose':
      if (typeof value !== 'boolean') return { ok: false, reason: `${key} 需要 true/false` }
      return { ok: true, value }

    case 'targetPreset':
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, reason: 'targetPreset 需要非空字符串' }
      }
      return { ok: true, value: value.trim() }

    case 'sources': {
      const list = normalizeSources(value)
      if (list.length === 0) return { ok: false, reason: 'sources 至少要留一个来源' }
      return { ok: true, value: list }
    }

    case 'sessionIdPattern': {
      if (typeof value !== 'string') return { ok: false, reason: 'sessionIdPattern 需要字符串（留空表示关闭）' }
      const pattern = value.trim()
      if (pattern === '') return { ok: true, value: '' }
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern)
      } catch (error) {
        return { ok: false, reason: `sessionIdPattern 不是合法正则：${error?.message ?? String(error)}` }
      }
      return { ok: true, value: pattern }
    }

    default:
      return { ok: false, reason: `未知字段 ${key}` }
  }
}

/**
 * 把一层原始配置合并到 base 上，非法字段原样跳过（不抛错，配置坏了也不能拦住任务）。
 * @returns {{ config: object, rejected: Array<{ key: string, reason: string }> }}
 */
export function mergeConfig(base, raw) {
  const config = { ...base, sources: [...(base?.sources ?? DEFAULTS.sources)] }
  const rejected = []
  if (raw === null || typeof raw !== 'object') return { config, rejected }

  for (const key of FIELDS) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue
    const result = normalizeField(key, raw[key])
    if (result.ok) config[key] = result.value
    else rejected.push({ key, reason: result.reason })
  }
  return { config, rejected }
}

/** 三层合并，返回最终生效的配置和两层各自的拒收明细。 */
export function resolveConfig(patchConfig, savedConfig) {
  const fromPatch = mergeConfig(DEFAULTS, patchConfig)
  const fromSaved = mergeConfig(fromPatch.config, savedConfig)
  return {
    config: fromSaved.config,
    rejected: [...fromPatch.rejected, ...fromSaved.rejected],
  }
}
