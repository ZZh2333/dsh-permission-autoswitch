# dsh-permission-autoswitch

自动投递出来的会话，在**第一次工具调用之前**自动切到完全权限；手动新建、QQ、子代理的会话保持原样。

两类会中招的会话：

1. **定时任务**投递出来的会话（`source.kind = "schedule"`）——改「每次新建会话」以后，新会话是 `workspace-write + ask`，往工作区外写就弹审批，夜里没人应答，任务停在那儿。
2. **插件自己建、自己投递**的会话——某个插件自己 `sessionController.create()` 一个会话再往里 `prompt()`：消息的 `source.kind` 就是 `user`，和白名单永远对不上，第一次写工作区外的目录就卡在审批上，整个投递队列跟着停。

这个插件只补这两刀，不碰别的。

## 它解决什么

| | 做法 | 问题 |
|---|---|---|
| 方案 A | 设置里把默认预设改成 `danger-full-access` | 所有新会话都放开，包括 QQ 和手动会话 |
| 方案 B | 往 `additionalWritableRoots` 里加目录 | 只管得住固定路径，遇到新路径照样卡 |
| **本插件** | 只把「自动投递出来的会话」提到目标预设 | 作用范围仅限来源白名单 / 会话 id 规则 |

## 判定依据

`@deepseek-ai/dsh-permission-presets` 在 `agent/created` 那一刻就写死了新会话的
`permission/preset`、`sandbox/mode`、`approval/policy`，而 `agent/created` 的 `source` 只有
`startup / resume / clear / compact`，区分不出「这是谁开的会话」。

第一条通道是消息来源：定时任务投递的用户消息带 `source.kind = "schedule"`（实测自 0.2.2-rc.1 的会话日志）：

```json
{ "type": "user/message", "data": { "content": [...], "source": { "kind": "schedule" } } }
```

第二条通道是**会话 id**：插件自己建的会话没有来源标记可用（它的消息就是 `user`），
但这类会话 id 的形状通常和人建的不一样——GUI 和定时任务建的一律是 `session-` 开头，
插件自建的可能是固定名字或裸 UUID。所以留一条 `sessionIdPattern` 正则，
命中就不看来源、不要求首条消息，直接提权：

```
sessionIdPattern: ^(my-bot|[0-9a-f-]{36}$)
```

两条通道都在消息落地前后调 `permissionPresets.set(session, targetPreset)`。
`set()` 会 append `permission/preset` 并写 `sandbox/mode`、`approval/policy`，而沙箱和审批都按会话投影读状态，
所以**下一次工具调用**就是新权限，不需要重启、不需要动宿主源码。

## 两个入口

| 入口 | 时机 | 作用 |
|---|---|---|
| `session/event`（主路径） | 投递消息 commit 之后、本回合任何工具调用之前 | 立刻切 |
| `agent/pre-step`（兜底） | 该会话第一步开始前，按待入消息再判一次 | 事件没接住时补刀；无论成败都 `next()` 放行 |

每个会话只判一次（进程内 `Set`）。重启后丢空不影响：权限事件已经在会话里，`current()` 会读出来，命中「已在目标预设」直接跳过。

## 配置项

三层合并，后面的赢：包内默认 ← `cordis.patch.yml` 里这一行的 `config` ← 设置页写的
`<DSH_HOME>/storages/permission-autoswitch/settings.json`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉以后插件不介入，只留一行启动日志 |
| `targetPreset` | `"danger-full-access"` | 命中后切到的预设，必须是 `permissionPresets` 目录里存在的名字 |
| `sources` | `["schedule"]` | 触发来源的 `source.kind` 白名单，大小写和空白都不敏感 |
| `sessionIdPattern` | `""` | 会话 id 正则，命中就不看来源直接提权。留空 = 关闭这条通道；填坏正则会被拒收 |
| `dryRun` | `false` | 只记「本应切换」，权限实际不动 |
| `respectManual` | `true` | 会话建好后已被人手动改过预设，就不再覆盖 |
| `requireFirstMessage` | `true` | 只处理「由投递创建出来的会话」；投递进已有会话时不动那个会话（id 命中时不看这条） |
| `verbose` | `false` | 没命中白名单的会话也记一条跳过记录 |

设置页：**设置 → 权限自动切换**。改完立刻生效，不用重启；页面下半部就是最近的判定记录，
每条写着来源、原预设、目标预设和原因。

## 判定规则（`lib/detect.js`，纯函数）

0. 会话 id 命中 `sessionIdPattern` → 不看来源、不要求首条消息：已在目标预设就跳过，否则切。
   仍然尊重 `respectManual`（会话里已有超过一条 `permission/preset` 就当是人改过）。
1. 取会话首条**有效**用户消息的 `source.kind` —— `agent-instructions`、`runtime-context`、
   `skill-catalog`、`time-context` 这类系统注入会跳过，它们不代表谁发起了会话。
2. 不在 `sources` 白名单 → 什么都不做。
3. 已经在 `targetPreset` → 跳过，不产生事件。
4. `requireFirstMessage` 且不是首条有效消息 → 跳过（投递进了已有会话）。
5. `respectManual` 且会话里已有超过一条 `permission/preset`（创建时那条算 1）→ 跳过。
6. 目标预设不存在 → 记一条 warning（含可选预设列表），任务照常跑。

## 装与卸

```powershell
# 已装在 profile desktop，包目录就是本仓库
plugin_manager install_bundle  <本仓库目录的绝对路径>
```

卸载用 `plugin_manager remove_bundle`。卸载后不再产生新行为；**已经切过的会话保持它的权限记录**，
因为那是写进会话日志的事实，宿主不会回滚。想让它们回到默认，在设置里点「恢复默认」并重启宿主，
或者直接改那个会话的预设。

## 观测

- 启动：一行 info（目标预设 / 来源 / dryRun / 两个判定开关）。
- 命中：`已切换 session-… 来源=schedule 目标=danger-full-access 原=workspace-write 2ms`。
- 跳过：只在 `verbose` 打开、或来源命中了白名单却被别的规则拦下时记。
- 落盘：`<DSH_HOME>/storages/permission-autoswitch/decisions.jsonl`，只留最近 200 行。
- 设置页接口：`GET /api/permission-autoswitch/status`、`POST /config`、`POST /reset`。

## 安全边界

- 不联网、不启子进程、不读工作区以外的文件；只写 `<DSH_HOME>/storages/permission-autoswitch/`。
- 不加工具、不加 prompt 片段，模型看不到它。
- 不接管审批流程，不实现「自动应答审批」——它只是把会话的预设提前换掉。
- 默认只认 `schedule`。别的插件投递的消息要放进来，得自己往 `sources` 里加。

## 目录

```
dsh-permission-autoswitch/
├─ lib/index.js     宿主半侧：判定触发、切换、设置页接口
├─ lib/detect.js    纯判定：来源、首条消息、人工修改
├─ lib/config.js    纯配置：校验、三层合并
├─ lib/store.js     落盘：settings.json / decisions.jsonl
├─ client.js        设置页（自注册 client bundle）
├─ locale/          插件元信息（中文 / 英文）
├─ icon.svg
├─ test/            node --test，38 条
└─ docs/requirements.md
```

## 测试

```powershell
node --test test/detect.test.mjs test/config.test.mjs test/host.test.mjs
```

38 条：判定 13、配置 9、宿主接线 16（假 ctx 跑两条入口 + 设置页 HTTP 接口）。

## 已知边界

- 宿主半侧是 `link:` 安装的，**改完 `lib/*.js` 要让宿主重新加载插件才生效**：`plugin_manager` 里把这个条目关一次再开一次即可，不用重启整个宿主；`client.js` 由 HMR 单独管。
- 设置页的视觉细节没在浏览器里逐像素核对过，只验证了插槽注册和接口行为。
- `new_once` 目标复用会话时，第二次投递不会重切（`requireFirstMessage` 默认开）。
- `sessionIdPattern` 是"按形状认人"：别的插件如果也用裸 UUID 建会话，会被一起接管。不想这样就把它写窄一点。

## 版本

- **0.2.0** — 第二条通道：`sessionIdPattern`（会话 id 命中就提权），修养鱼插件轮换会话卡审批；设置页加了这条输入框；测试 50 条。
- **0.1.0** — 首版：来源判定、两个入口、7 个配置项、设置页、判定记录、38 条测试。

## License

MIT
