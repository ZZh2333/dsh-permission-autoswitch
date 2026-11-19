/**
 * 宿主半侧的接线测试：不用真宿主，用假的 ctx / session / permissionPresets
 * 把 apply() 装起来，然后从两条路真的走一遍。
 *
 * 覆盖的是 lib/index.js 里那些单测摸不到的分支：
 *   - session/event 命中来源 → 调 set()
 *   - agent/pre-step 兜底 → 调 set() 且一定 next()
 *   - 白名单外 / 已在目标 / 非首条 / 人工改过 → 不调 set()
 *   - 目标预设不存在 → 记 error，不调 set()
 *   - dryRun → 只记 would-promote
 *   - 设置页 HTTP 接口：读状态、拒收坏值、保存、恢复默认
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-permission-autoswitch-test-'))

const { apply } = await import('../lib/index.js')
const { readDecisions, readSettings } = await import('../lib/store.js')

/* ───────────────────────── 假的宿主 ───────────────────────── */

const userMessage = (seq, kind) => ({ type: 'user/message', seq, data: { source: { kind } } })

function makePresets(state) {
  const calls = []
  const presets = {
    calls,
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      defaultOptions: [],
      defaultPreset: 'workspace-write',
    }),
    current: (session) => state.preset ?? 'workspace-write',
    set: (session, name) => {
      calls.push(name)
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) {
        throw new Error(`permission: unknown preset "${name}"`)
      }
      state.preset = name
      session.appended.push({ type: 'permission/preset', seq: session.appended.length, data: { preset: name } })
    },
  }
  return presets
}

function makeSession({ id = 'session-test', events = [], preset = 'workspace-write' } = {}) {
  const state = { preset }
  const session = {
    id,
    appended: [],
    snapshotEvents: () => [...events, ...session.appended],
    ownEvents: () => [...events, ...session.appended],
    state,
    presets: makePresets(state),
  }
  return session
}

/** 一次性装好插件，返回能拿到监听器、路由和记录的把手。 */
function boot(patchConfig = {}) {
  const handlers = new Map()
  const routes = []
  const effects = []
  const warnings = []

  const ctx = {
    effects,
    logger: () => ({
      info: () => {},
      warn: (message) => warnings.push(String(message)),
      error: (message) => warnings.push(String(message)),
    }),
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    inject(names, callback) {
      callback(ctx)
      return () => {}
    },
    get(name) {
      return ctx.services?.[name]
    },
    effect(fn) {
      effects.push(fn())
      return () => {}
    },
  }

  // 宿主里这些服务是 ctx 上的属性（ctx.permissionPresets），不是 get() 出来的
  for (const key of ['permissionPresets', 'webServer']) {
    Object.defineProperty(ctx, key, { get: () => ctx.services?.[key], configurable: true })
  }

  const presetsRef = { current: null }
  ctx.services = {
    permissionPresets: {
      catalog: (...args) => presetsRef.current.catalog(...args),
      current: (...args) => presetsRef.current.current(...args),
      set: (...args) => presetsRef.current.set(...args),
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
  }

  // 设置页接口在挂载时就会读一次预设目录，先放一份默认的
  presetsRef.current = makePresets({ preset: 'workspace-write' })

  apply(ctx, patchConfig)

  return {
    handlers,
    routes,
    warnings,
    use: (session) => { presetsRef.current = session.presets; return session },
    route: () => routes.find((r) => r.path === '/api/permission-autoswitch'),
  }
}

/** 直接调路由，模拟浏览器那次 fetch。 */
async function call(handle, method, path, body) {
  const route = handle.route()
  assert.ok(route, '路由没挂上')
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: `/api/permission-autoswitch${path}`,
    on(event, fn) {
      if (event === 'data') fn(raw)
      if (event === 'end') fn()
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(value) { this.body = value },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

/* ───────────────────────── session/event 主线 ───────────────────────── */

test('session/event：定时任务首条消息 → 切到目标预设', () => {
  const handle = boot()
  const session = handle.use(makeSession())
  const emit = handle.handlers.get('session/event')
  assert.equal(typeof emit, 'function')

  emit(session, { type: 'user/message', seq: 9, data: { source: { kind: 'schedule' } } })

  assert.deepEqual(session.presets.calls, ['danger-full-access'])
  assert.equal(session.presets.current(session), 'danger-full-access')
})

test('session/event：白名单外的来源一根汗毛都不动', () => {
  const handle = boot()
  const session = handle.use(makeSession())
  handle.handlers.get('session/event')(session, userMessage(9, 'user'))
  assert.deepEqual(session.presets.calls, [])
})

/* ── 第二条通道：会话 id 命中 sessionIdPattern（养鱼这类插件自建的会话） ── */

const ID_PATTERN = '^(my-bot|[0-9a-f-]{36}$)'

test('session/event：会话 id 命中规则 → 即使来源是 user 也切', () => {
  const handle = boot({ sessionIdPattern: ID_PATTERN })
  const session = handle.use(makeSession({ id: 'my-bot-workdir' }))
  handle.handlers.get('session/event')(session, userMessage(9, 'user'))
  assert.deepEqual(session.presets.calls, ['danger-full-access'])
})

test('session/event：id 不命中时，user 来源照旧不动', () => {
  const handle = boot({ sessionIdPattern: ID_PATTERN })
  const session = handle.use(makeSession({ id: 'session-abc' }))
  handle.handlers.get('session/event')(session, userMessage(9, 'user'))
  assert.deepEqual(session.presets.calls, [])
})

test('session/event：id 命中的旧会话（已有消息）也要能提权', () => {
  const handle = boot({ sessionIdPattern: ID_PATTERN })
  const session = handle.use(makeSession({ id: 'my-bot-workdir', events: [userMessage(3, 'user')] }))
  handle.handlers.get('session/event')(session, userMessage(9, 'user'))
  assert.deepEqual(session.presets.calls, ['danger-full-access'])
})

test('agent/pre-step：id 命中时不等真消息，直接切', async () => {
  const handle = boot({ sessionIdPattern: ID_PATTERN })
  const session = handle.use(makeSession({ id: '85f455ce-a189-4b24-8ae2-a5a5a384e97e' }))
  const preStep = handle.handlers.get('agent/pre-step')
  let nexted = 0
  await preStep(
    { agent: { id: session.id, session }, messages: [{ source: { kind: 'runtime-context' } }], turn: 1, step: 1 },
    () => { nexted += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.equal(nexted, 1)
  assert.deepEqual(session.presets.calls, ['danger-full-access'])
})

test('session/event：系统注入的消息不触发判定', () => {
  const handle = boot()
  const session = handle.use(makeSession())
  handle.handlers.get('session/event')(session, userMessage(9, 'agent-instructions'))
  assert.deepEqual(session.presets.calls, [])
})

test('session/event：只处理一次，重复事件不会重复 append', () => {
  const handle = boot()
  const session = handle.use(makeSession())
  const emit = handle.handlers.get('session/event')
  emit(session, userMessage(9, 'schedule'))
  emit(session, userMessage(10, 'schedule'))
  assert.deepEqual(session.presets.calls, ['danger-full-access'])
})

test('session/event：会话里已有真消息（投递进旧会话）→ 不动', () => {
  const handle = boot()
  const session = handle.use(makeSession({ events: [userMessage(3, 'user')] }))
  handle.handlers.get('session/event')(session, userMessage(9, 'schedule'))
  assert.deepEqual(session.presets.calls, [])
})

test('session/event：respectManual 时人工改过的会话不动；关掉规则就切', () => {
  const events = [
    { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
    { type: 'permission/preset', seq: 4, data: { preset: 'read-only' } },
  ]
  const strict = boot()
  const first = strict.use(makeSession({ events }))
  strict.handlers.get('session/event')(first, userMessage(9, 'schedule'))
  assert.deepEqual(first.presets.calls, [])

  const loose = boot({ respectManual: false })
  const second = loose.use(makeSession({ events, preset: 'read-only' }))
  loose.handlers.get('session/event')(second, userMessage(9, 'schedule'))
  assert.deepEqual(second.presets.calls, ['danger-full-access'])
})

test('session/event：目标预设不存在 → 不切，留一条 error', () => {
  const handle = boot({ targetPreset: 'nope' })
  const session = handle.use(makeSession())
  handle.handlers.get('session/event')(session, userMessage(9, 'schedule'))
  assert.deepEqual(session.presets.calls, [])
  const last = readDecisions(1).at(-1)
  assert.equal(last.action, 'error')
  assert.match(last.reason, /目标预设不存在/)
  assert.match(last.reason, /danger-full-access/)   // 报出可选列表，主人知道该填什么
})

test('session/event：dryRun 只记账不切', () => {
  const handle = boot({ dryRun: true })
  const session = handle.use(makeSession())
  handle.handlers.get('session/event')(session, userMessage(9, 'schedule'))
  assert.deepEqual(session.presets.calls, [])
})

/* ───────────────────────── agent/pre-step 兜底 ───────────────────────── */

test('agent/pre-step：待入消息是定时任务 → 切，并且一定 next()', async () => {
  const handle = boot()
  const session = handle.use(makeSession())
  const preStep = handle.handlers.get('agent/pre-step')
  let nexted = false

  const decision = await preStep(
    { agent: { id: session.id, session }, messages: [{ source: { kind: 'agent-instructions' } }, { source: { kind: 'schedule' } }], turn: 1, step: 1 },
    () => { nexted = true; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )

  assert.equal(nexted, true)
  assert.deepEqual(session.presets.calls, ['danger-full-access'])
  assert.equal(decision.kind, 'enter')
})

test('agent/pre-step：只有系统注入的消息时先不判，等真消息', async () => {
  const handle = boot()
  const session = handle.use(makeSession())
  const preStep = handle.handlers.get('agent/pre-step')
  let nexted = 0
  await preStep(
    { agent: { id: session.id, session }, messages: [{ source: { kind: 'runtime-context' } }], turn: 1, step: 1 },
    () => { nexted += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.equal(nexted, 1)
  assert.deepEqual(session.presets.calls, [])
})

test('agent/pre-step：set() 抛错也不拦住任务', async () => {
  const handle = boot()
  const session = handle.use(makeSession())
  session.presets.set = () => { throw new Error('boom') }
  const preStep = handle.handlers.get('agent/pre-step')
  let nexted = false
  await preStep(
    { agent: { id: session.id, session }, messages: [{ source: { kind: 'schedule' } }], turn: 1, step: 1 },
    () => { nexted = true; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.equal(nexted, true)
})

/* ───────────────────────── 设置页接口 ───────────────────────── */

test('GET /status：默认配置 + 预设目录 + 落盘路径', async () => {
  const handle = boot()
  const { status, json } = await call(handle, 'GET', '/status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.config.targetPreset, 'danger-full-access')
  assert.deepEqual(json.config.sources, ['schedule'])
  assert.equal(json.presetsAvailable, true)
  assert.deepEqual(json.presets.map((p) => p.value), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.match(json.settingsFile, /permission-autoswitch[\\/]settings\.json$/)
})

test('POST /config：坏值要明确拒绝，ok 必须是 false', async () => {
  const handle = boot()
  const { json } = await call(handle, 'POST', '/config', { sources: [] })
  assert.equal(json.ok, false)
  assert.match(json.error, /至少要留一个来源/)
})

test('POST /config：好值立刻生效并落盘', async () => {
  const handle = boot()
  const { json } = await call(handle, 'POST', '/config', { targetPreset: 'read-only', dryRun: true })
  assert.equal(json.ok, true)
  assert.equal(json.config.targetPreset, 'read-only')
  assert.equal(json.config.dryRun, true)

  const saved = readSettings()
  assert.equal(saved.targetPreset, 'read-only')
  assert.equal(saved.dryRun, true)

  // 落盘的值盖过 patch 里的 config
  const again = await call(handle, 'GET', '/status')
  assert.equal(again.json.config.targetPreset, 'read-only')
})

test('POST /reset：回到默认', async () => {
  const handle = boot()
  await call(handle, 'POST', '/config', { enabled: false, targetPreset: 'read-only' })
  const { json } = await call(handle, 'POST', '/reset')
  assert.equal(json.ok, true)
  assert.equal(json.config.enabled, true)
  assert.equal(json.config.targetPreset, 'danger-full-access')
  assert.equal(readSettings().targetPreset, 'danger-full-access')
})

test('未知路径返回 404 而不是崩', async () => {
  const handle = boot()
  const { status, json } = await call(handle, 'GET', '/nope')
  assert.equal(status, 404)
  assert.equal(json.ok, false)
})
