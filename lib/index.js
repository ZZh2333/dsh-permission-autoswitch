/**
 * dsh-permission-autoswitch · Host 半侧
 *
 * 一句话：定时任务投递出来的会话，在第一次工具调用之前自己拿到完全权限；
 * 其它会话（手动新建、QQ、子代理）一根汗毛都不动。
 *
 * 为什么需要它：
 *   @deepseek-ai/dsh-permission-presets 在 agent/created 那一刻就把新会话的
 *   permission/preset + sandbox/mode + approval/policy 写死成当前默认预设
 *   （workspace-write + ask），agent/created 的 source 只有 startup/resume/clear/compact，
 *   根本区分不出「这是定时任务开的会话」。凌晨没人守审批，任务就卡在那儿。
 *
 * 所以：消息里的 source.kind 是唯一稳定、可读、随会话持久化的来源标记，
 * 我们在它落地前后补一刀 permissionPresets.set(session, target)。
 * set() 内部会 append permission/preset 并写 sandbox/mode、approval/policy，
 * 而 sandbox 与 approval 都按会话投影读状态，所以下一次工具调用就是新权限。
 *
 * 不做什么：不接管审批、不加工具、不改他人的源码、不写会话内容（不留提示消息）。
 */

import { decide, hasPriorMeaningfulMessage, isIgnoredKind, matchesIdPattern, matchSource, presetEventCount, sourceKindOf } from './detect.js'
import { DEFAULTS, mergeConfig, resolveConfig } from './config.js'
import { appendDecision, decisionsFile, readDecisions, readSettings, settingsFile, writeSettings } from './store.js'

export const name = 'permission-autoswitch'

/** 最近判定的内存副本，设置页刷新时先拿它。 */
const recent = []
const RECENT_MAX = 30

export function apply(root, patchConfig = {}) {
  const logger = (() => {
    try {
      return typeof root.logger === 'function' ? root.logger('permission-autoswitch') : root.logger
    } catch {
      return null
    }
  })()

  const say = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  const resolved = resolveConfig(patchConfig, readSettings())
  let config = resolved.config
  for (const item of resolved.rejected) {
    say('warn', `配置项 ${item.key} 被拒收：${item.reason}`)
  }

  /** 每个会话只判定一次。重启后丢空没关系：已经带上的权限事件会重放出来。 */
  const handled = new Set()

  const enabled = () => config.enabled === true

  /** 设置页改完就重新读一遍，不用重启。 */
  const reload = () => {
    const next = resolveConfig(patchConfig, readSettings())
    config = next.config
    for (const item of next.rejected) say('warn', `配置项 ${item.key} 被拒收：${item.reason}`)
    return config
  }

  const record = (entry) => {
    const line = { time: new Date().toISOString(), ...entry }
    recent.push(line)
    if (recent.length > RECENT_MAX) recent.shift()
    appendDecision(line)
    const verb = line.action === 'promote' ? '已切换' : line.action === 'would-promote' ? '本应切换' : '跳过'
    say(line.action === 'error' ? 'warn' : 'info',
      `${verb} ${line.sessionId} 来源=${line.source ?? '?'} 目标=${line.target ?? '?'} 原=${line.from ?? '?'} ${line.reason ?? ''}`.trim())
  }

  const eventsOf = (session) => {
    try {
      if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
    } catch {
      /* 落到下面 */
    }
    try {
      if (typeof session?.ownEvents === 'function') return session.ownEvents()
    } catch {
      /* 读不到就当没有 */
    }
    return []
  }

  const catalogOptions = (presets) => {
    try {
      return presets.catalog().options ?? []
    } catch {
      return []
    }
  }

  /**
   * 判定并（可能）切换。
   * @param presets permissionPresets 服务
   * @param session 会话
   * @param kind 触发的来源 kind
   * @param origin 哪个入口触发的（session/event 或 agent/pre-step）
   * @param excludeSeq 正在处理的那条事件 seq，扫历史时要跳过
   */
  const consider = (presets, session, kind, origin, excludeSeq = null) => {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '' || handled.has(sessionId)) return
    if (!enabled()) return

    const events = eventsOf(session)
    let current = ''
    try {
      current = String(presets.current(session) ?? '')
    } catch {
      current = ''
    }

    const verdict = decide({
      kind,
      sources: config.sources,
      targetPreset: config.targetPreset,
      currentPreset: current,
      firstMessage: !hasPriorMeaningfulMessage(events, excludeSeq),
      presetCount: presetEventCount(events),
      respectManual: config.respectManual,
      requireFirstMessage: config.requireFirstMessage,
      idMatch: matchesIdPattern(config.sessionIdPattern, sessionId),
    })

    if (verdict.action !== 'promote') {
      handled.add(sessionId)
      // 没命中白名单的会话一片安静；命中了但被别的规则拦下的，一定要留痕。
      if (config.verbose || matchSource(kind, config.sources)) {
        record({
          sessionId,
          action: 'skip',
          source: kind,
          from: current || null,
          target: config.targetPreset,
          reason: `${verdict.reason}（${origin}）`,
        })
      }
      return
    }

    const available = catalogOptions(presets).map((option) => String(option.value))
    if (!available.includes(config.targetPreset)) {
      handled.add(sessionId)
      record({
        sessionId,
        action: 'error',
        source: kind,
        from: current || null,
        target: config.targetPreset,
        reason: `目标预设不存在，可选：${available.join(', ') || '（读不到目录）'}`,
      })
      return
    }

    handled.add(sessionId)
    if (config.dryRun) {
      record({
        sessionId,
        action: 'would-promote',
        source: kind,
        from: current || null,
        target: config.targetPreset,
        reason: `dryRun（${origin}）`,
      })
      return
    }

    const started = Date.now()
    try {
      presets.set(session, config.targetPreset)
      let after = ''
      try {
        after = String(presets.current(session) ?? '')
      } catch {
        after = config.targetPreset
      }
      record({
        sessionId,
        action: 'promote',
        source: kind,
        from: current || null,
        target: after || config.targetPreset,
        ms: Date.now() - started,
        reason: origin,
      })
    } catch (error) {
      record({
        sessionId,
        action: 'error',
        source: kind,
        from: current || null,
        target: config.targetPreset,
        reason: `${error?.message ?? String(error)}（${origin}）`,
      })
    }
  }

  const sessionOf = (agent) => {
    const direct = agent?.session
    if (direct !== undefined) return direct
    try {
      return root.get('agents')?.get?.(agent?.id)?.session
    } catch {
      return undefined
    }
  }

  root.inject(['permissionPresets'], (ctx) => {
    const presets = ctx.permissionPresets
    if (presets === undefined || presets === null) {
      say('warn', 'permissionPresets 服务缺失，插件不介入')
      return
    }

    // 主路径：投递的用户消息落盘那一刻就切，早于本回合任何工具调用。
    ctx.on('session/event', (session, event) => {
      try {
        if (!enabled()) return
        if (event?.type !== 'user/message') return
        const kind = sourceKindOf(event.data)
        if (isIgnoredKind(kind)) return
        consider(presets, session, kind, 'session/event', event.seq ?? null)
      } catch (error) {
        say('warn', `session/event 判定失败：${error?.message ?? String(error)}`)
      }
    }, 'permission-autoswitch: 判定投递来源')

    // 兜底：万一事件监听没接上（插件后加载、事件被别的插件吞了），
    // 就在该会话第一步开始前按待入消息再判一次；无论成败都放行。
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (!enabled()) return next()
        const session = sessionOf(payload?.agent)
        if (session === undefined) return next()
        const sessionId = String(session.id ?? '')
        if (handled.has(sessionId)) return next()

        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const kinds = []
        for (const message of messages) {
          const kind = sourceKindOf(message)
          if (!isIgnoredKind(kind)) kinds.push(kind)
        }
        // id 命中的会话（插件自建、自己投递的那些）不看消息来源：这里只要还没判过就再判一次。
        if (matchesIdPattern(config.sessionIdPattern, sessionId)) {
          consider(presets, session, 'id-pattern', 'agent/pre-step', null)
          return next()
        }
        if (kinds.length === 0) return next()
        consider(presets, session, kinds[0], 'agent/pre-step', null)
      } catch (error) {
        say('warn', `agent/pre-step 判定失败：${error?.message ?? String(error)}`)
      }
      return next()
    }, 'permission-autoswitch: 第一步兜底')

    say('info',
      `已启用：目标=${config.targetPreset} 来源=${config.sources.join(',')} dryRun=${config.dryRun} ` +
      `respectManual=${config.respectManual} requireFirstMessage=${config.requireFirstMessage}`)
  })

  /* ────────────────── 设置页接口（浏览器半侧只做 fetch） ────────────────── */

  const sendJson = (res, code, value) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    } catch {
      /* 已经走了 */
    }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 200_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

  root.inject(['webServer'], (ctx) => {
    const server = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
    if (server === undefined || server === null || typeof server.register !== 'function') return

    const presets = (() => {
      try {
        return ctx.get('permissionPresets')
      } catch {
        return undefined
      }
    })()

    const snapshot = () => ({
      ok: true,
      config,
      defaults: { ...DEFAULTS, sources: [...DEFAULTS.sources] },
      presets: presets === undefined || presets === null ? [] : catalogOptions(presets),
      presetsAvailable: presets !== undefined && presets !== null,
      recent: [...recent].slice(-20).reverse(),
      savedRecent: readDecisions(20).reverse(),
      settingsFile: settingsFile(),
      decisionsFile: decisionsFile(),
    })

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/^\/api\/permission-autoswitch/, '') || '/'

      if (req.method === 'GET' && (path === '/' || path === '/status')) {
        return sendJson(res, 200, snapshot())
      }

      if (req.method === 'POST' && path === '/config') {
        const body = await readBody(req)
        const base = readSettings() ?? {}
        const merged = mergeConfig({ ...DEFAULTS, ...base }, body)
        const rejected = merged.rejected.map((item) => item.reason)
        if (rejected.length > 0) return sendJson(res, 200, { ...snapshot(), ok: false, error: rejected.join('；') })
        try {
          writeSettings(merged.config)
        } catch (error) {
          return sendJson(res, 200, { ...snapshot(), ok: false, error: `写不进设置文件：${error?.message ?? String(error)}` })
        }
        reload()
        handled.clear()
        return sendJson(res, 200, { ...snapshot(), ok: true })
      }

      if (req.method === 'POST' && path === '/reset') {
        try {
          writeSettings({ ...DEFAULTS, sources: [...DEFAULTS.sources] })
        } catch (error) {
          return sendJson(res, 200, { ...snapshot(), ok: false, error: `写不进设置文件：${error?.message ?? String(error)}` })
        }
        reload()
        handled.clear()
        return sendJson(res, 200, { ...snapshot(), ok: true })
      }

      return sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${path}` })
    }

    try {
      ctx.effect(() => server.register({
        kind: 'prefix',
        path: '/api/permission-autoswitch',
        handler: (req, res) => {
          Promise.resolve(handler(req, res)).catch((error) => {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
          })
        },
      }), 'permission-autoswitch: 设置页接口')
    } catch (error) {
      say('warn', `挂 /api/permission-autoswitch 失败：${error?.message ?? String(error)}`)
    }
  })
}
