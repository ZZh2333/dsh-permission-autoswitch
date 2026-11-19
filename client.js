/**
 * dsh-permission-autoswitch · 浏览器半侧
 *
 * 设置里多一页「权限自动切换」：开关、目标预设、来源白名单、dryRun 等等，
 * 改完立刻生效（宿主那边重新读一遍配置，不用重启）。
 *
 * 约定跟本机其它插件一致：client bundle 是自注册脚本，不是 ESM；
 * 页面只做 fetch，真正的读写由宿主挂的 /api/permission-autoswitch 负责。
 */

window.__ModuleLoader__.load({
  id: 'dsh-permission-autoswitch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/permission-autoswitch'

    const asJson = async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      if (body.ok === false) throw new Error(body.error || '操作失败')
      return body
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-pa-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:660px;}
[data-pa-sec]{display:flex;flex-direction:column;gap:8px;}
[data-pa-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pa-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-pa-note][data-warn]{color:#d97706;}
[data-pa-row]{display:flex;align-items:center;gap:10px;}
[data-pa-grow]{flex:1;min-width:0;}
[data-pa-card]{padding:12px 14px;border-radius:12px;display:flex;flex-direction:column;gap:10px;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.22));}
[data-pa-card][data-off]{opacity:.6;}
[data-pa-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-pa-sw][data-on]{background:#3b82f6;}
[data-pa-sw]::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:8px;
  background:#fff;transition:transform .15s;}
[data-pa-sw][data-on]::after{transform:translateX(16px);}
[data-pa-in],[data-pa-sel]{padding:7px 10px;border-radius:8px;font:inherit;font-size:13px;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-base,transparent);box-sizing:border-box;}
[data-pa-in]{width:100%;}
[data-pa-btn]{padding:7px 14px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:inherit;}
[data-pa-btn][disabled]{opacity:.5;cursor:default;}
[data-pa-log]{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;}
[data-pa-item]{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;
  font-size:11px;line-height:16px;background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08));}
[data-pa-item][data-bad]{background:rgba(217,119,6,.12);}
[data-pa-tag]{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2));}
[data-pa-tag][data-ok]{background:rgba(59,130,246,.18);color:#1d4ed8;}
[data-pa-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
`

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [bad, setBad] = React.useState(false)
      const [sources, setSources] = React.useState('')
      const [idPattern, setIdPattern] = React.useState('')
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const adopt = (s) => {
        setSt(s)
        setSources(Array.isArray(s?.config?.sources) ? s.config.sources.join(', ') : '')
        setIdPattern(typeof s?.config?.sessionIdPattern === 'string' ? s.config.sessionIdPattern : '')
      }

      const load = React.useCallback(async () => {
        try {
          const s = await jget('/status')
          if (alive.current) adopt(s)
        } catch (e) {
          if (alive.current) { setMsg('读状态失败：' + e.message); setBad(true) }
        }
      }, [])
      React.useEffect(() => { load() }, [load])

      const save = async (patch) => {
        setBusy('save')
        setMsg('')
        try {
          const s = await jpost('/config', patch)
          if (!alive.current) return
          adopt(s)
          setMsg('已保存，立刻生效')
          setBad(false)
        } catch (e) {
          if (!alive.current) return
          setMsg('保存失败：' + e.message)
          setBad(true)
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const reset = async () => {
        setBusy('reset')
        setMsg('')
        try {
          const s = await jpost('/reset', {})
          if (!alive.current) return
          adopt(s)
          setMsg('已恢复默认')
          setBad(false)
        } catch (e) {
          if (alive.current) { setMsg('恢复失败：' + e.message); setBad(true) }
        } finally {
          if (alive.current) setBusy('')
        }
      }

      if (!st) {
        return h('div', { 'data-pa-page': '' },
          h('div', { 'data-pa-h': '' }, '权限自动切换'),
          h('div', { 'data-pa-note': '' }, msg || '读取中……'))
      }

      const cfg = st.config || {}
      const on = cfg.enabled === true
      const presets = Array.isArray(st.presets) ? st.presets : []
      const recent = Array.isArray(st.recent) && st.recent.length > 0 ? st.recent : (st.savedRecent || [])

      const toggle = (key, label, note, value) => h('div', { 'data-pa-row': '' },
        h('button', {
          'data-pa-sw': '',
          'data-on': value ? '' : undefined,
          'aria-label': `${value ? '关闭' : '打开'}${label}`,
          disabled: busy === 'save',
          onClick: () => save({ [key]: !value }),
        }),
        h('div', { 'data-pa-grow': '' },
          h('div', { style: { fontSize: '13px' } }, label),
          h('div', { 'data-pa-note': '' }, note)))

      return h('div', { 'data-pa-page': '' },
        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-h': '' }, '权限自动切换'),
          h('div', { 'data-pa-note': '' },
            '定时任务投递出来的会话，在第一次工具调用之前自动切到目标预设，凌晨不用等人点审批；' +
            '手动新建、QQ、子代理的会话一律不动。')),

        h('div', { 'data-pa-card': '', 'data-off': on ? undefined : '' },
          toggle('enabled', on ? '已开启' : '已关闭',
            on
              ? '现在会认来源白名单里的投递，命中就切权限。'
              : '关掉以后插件完全不介入，只留一行启动日志。', on)),

        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-h': '' }, '目标预设'),
          presets.length > 0
            ? h('select', {
                'data-pa-sel': '',
                value: cfg.targetPreset,
                disabled: busy === 'save',
                onChange: (e) => save({ targetPreset: e.target.value }),
              }, presets.map((p) => h('option', { key: String(p.value), value: String(p.value) },
                String(p.name || p.value))))
            : h('div', { 'data-pa-note': '', 'data-warn': '' },
                '读不到预设目录（permissionPresets 服务没挂上？）——目标仍按当前配置 ' + String(cfg.targetPreset) + ' 走。'),
          h('div', { 'data-pa-note': '' },
            '命中后切到这个预设。默认 danger-full-access：完全文件访问 + 不再问审批。')),

        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-h': '' }, '来源白名单'),
          h('input', {
            'data-pa-in': '',
            value: sources,
            disabled: busy === 'save',
            spellCheck: false,
            placeholder: 'schedule',
            onChange: (e) => setSources(e.target.value),
            onBlur: () => {
              const next = sources.split(',').map((s) => s.trim()).filter(Boolean)
              const now = Array.isArray(cfg.sources) ? cfg.sources : []
              if (next.join(',') !== now.join(',')) save({ sources: next })
            },
          }),
          h('div', { 'data-pa-note': '' },
            '比对会话首条有效用户消息的 source.kind，逗号分隔。定时任务投递的是 schedule；' +
            'agent-instructions / runtime-context / time-context 这类系统注入会被跳过。')),

        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-h': '' }, '会话 id 规则（第二条通道）'),
          h('input', {
            'data-pa-in': '',
            value: idPattern,
            disabled: busy === 'save',
            spellCheck: false,
            placeholder: '留空 = 关闭，例如 ^(bili-whale|[0-9a-f-]{36}$)',
            onChange: (e) => setIdPattern(e.target.value),
            onBlur: () => {
              const next = idPattern.trim()
              if (next !== String(cfg.sessionIdPattern ?? '')) save({ sessionIdPattern: next })
            },
          }),
          h('div', { 'data-pa-note': '' },
            '会话 id 命中这条正则时不看消息来源，直接提权——给"插件自己建、自己投递"的会话用' +
            '（它们的 source.kind 也是 user，和人手打的分不开，只能按 id 认）。' +
            '留空就只走上面的来源白名单。')),

        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-h': '' }, '行为'),
          toggle('dryRun', '只记录不切换（dryRun）',
            '开着的时候只写一条「本应切换」，权限实际不动。想先观察一周就打开它。', cfg.dryRun === true),
          toggle('respectManual', '尊重人工修改（respectManual）',
            '会话建好后如果已经被人手动改过预设，就不再覆盖。', cfg.respectManual === true),
          toggle('requireFirstMessage', '只认会话首条消息（requireFirstMessage）',
            '定时任务投递进已有会话时，不动那个会话——只处理由投递创建出来的会话。', cfg.requireFirstMessage === true),
          toggle('verbose', '明细日志（verbose）',
            '没命中白名单的会话也记一条跳过记录，排查时用。', cfg.verbose === true)),

        h('div', { 'data-pa-sec': '' },
          h('div', { 'data-pa-row': '' },
            h('div', { 'data-pa-h': '' }, '最近的判定'),
            h('div', { 'data-pa-grow': '' }),
            h('button', { 'data-pa-btn': '', disabled: busy !== '', onClick: load }, '刷新'),
            h('button', { 'data-pa-btn': '', disabled: busy !== '', onClick: reset }, '恢复默认')),
          recent.length === 0
            ? h('div', { 'data-pa-note': '' }, '还没有记录。下一次定时任务投递过来就会出现在这里。')
            : h('div', { 'data-pa-log': '' }, recent.map((item, index) => h('div', {
                key: `${item.time}-${index}`,
                'data-pa-item': '',
                'data-bad': item.action === 'error' ? '' : undefined,
              },
              h('div', { 'data-pa-row': '' },
                h('span', { 'data-pa-tag': '', 'data-ok': item.action === 'promote' ? '' : undefined },
                  item.action === 'promote' ? '已切换'
                    : item.action === 'would-promote' ? '本应切换'
                      : item.action === 'error' ? '失败' : '跳过'),
                h('span', { 'data-pa-mono': '' }, String(item.sessionId || '')),
                h('div', { 'data-pa-grow': '' }),
                h('span', { 'data-pa-note': '' }, String(item.time || '').replace('T', ' ').slice(0, 19))),
              h('div', { 'data-pa-note': '' },
                `来源 ${item.source || '?'} · ${item.from || '?'} → ${item.target || '?'} · ${item.reason || ''}`))))),

        msg ? h('div', { 'data-pa-note': '', 'data-warn': bad ? '' : undefined }, msg) : null,
        h('div', { 'data-pa-note': '' },
          '改完立刻生效，不用重启。设置存在 ' + String(st.settingsFile || 'settings.json') +
          '，判定记录在同目录的 decisions.jsonl。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-permission-autoswitch')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-permission-autoswitch: 设置页样式')

        const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'permission-autoswitch', order: 33, label: '权限自动切换' },
          () => h(Panel),
        ))
      },
    }
  },
})
