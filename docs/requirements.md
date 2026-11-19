# dsh-permission-autoswitch · 需求说明文档

| 项 | 内容 |
|---|---|
| 版本 | v0.1（已实现并验收） |
| 日期 | 2026-11-16 |
| 状态 | v0.1.0 已推送：<https://github.com/ZZh2333/dsh-permission-autoswitch> |
| 目标环境 | DeepSeek Harness 0.2.2-rc.1，Windows，本机 profile `desktop` |
| 关联会话 | 2026-11-16 关于「定时任务默认权限」的讨论 |

---

## 1. 背景

### 1.1 现象

四个每日定时任务（01:00 整理目录、02:00 整理记忆、03:00 归档会话、05:00 token 统计）在 2026-11-11 起改成「每次新建会话」投递。新建会话的权限预设是 `workspace-write`（沙箱工作区可写 + 审批询问）。任务里若干步会触发审批请求：

- 往工作区外的 `_reports\...` 写报告文件时报 EPERM，于是模型申请放宽到完全权限；
- 往工作区外的 `%USERPROFILE%\.dsh\` 下写记忆/日记，同样申请放宽；
- 偶尔是 `plugin_manager` 之类的宿主能力调用。

凌晨没人守着，审批没人应答，任务就停在那里。会话 token 继续涨，最后变成 03:00 归档任务里「一直被拒」的那两个。

### 1.2 机制（已核实，来自 0.2.2-rc.1 源码与实测日志）

1. `@deepseek-ai/dsh-permission-presets` 在 `agent/created` 时调用 `pinInitialPermission(session)`：全新会话会被写入三条会话事件——`permission/preset`、`sandbox/mode`、`approval/policy`，取值来自**当前默认预设**（`defaultPreset`，可由用户在设置页修改）。也就是说：**新会话的权限在创建那一刻就定死了，没有任何按来源区分的钩子。**
2. `agent/created` 的 `source: SessionStartSource` 只有 `'startup' | 'resume' | 'clear' | 'compact'` 四种，**不含「定时任务」**，不能用来识别来源。
3. 但投递进来的用户消息带来源标记，实测（session-08d6268f…）：

```json
{
  "type": "user/message",
  "data": {
    "content": [{ "type": "text", "text": "[SCHEDULE REMINDER] ..." }],
    "source": { "kind": "schedule" }
  }
}
```

`source.kind` 是稳定、可读、随会话持久化的字段，可作为判定依据。

### 1.3 已有替代方案与取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 全局默认完全权限 | 设置 → 权限模式服务 → 默认预设 = `danger-full-access` | 能解决，但**所有**新会话都放开，包括 QQ 会话与手动新会话；安全面太大 |
| B. 放宽可写目录 | `sandbox-policy.additionalWritableRoots` 增加 `~\\.dsh\\memory` 等 | 只解决固定路径，遇到新的临时路径照样卡 |
| C. 本插件 | 只把「定时任务投递的会话」提升到完全权限 | 本方案 |

Windows 沙箱 ACL 诊断已排除「权限项损坏」这一类（`FIXED=0`，无外来包权限项，`WRITE_DAC`/`WRITE_OWNER` 均在），所以 A 或 C 是实际可行的方向。

---

## 2. 目标与非目标

### 2.1 目标

- G1：定时任务投递出来的会话，在**第一次工具调用之前**自动获得指定权限预设（默认 `danger-full-access`），夜间无人值守不再卡审批。
- G2：其它会话（GUI 手动会话、QQ 会话、子代理会话）**行为完全不变**。
- G3：行为可配置（开关、目标预设、识别的来源、试运行），参数在设置页可见可改。
- G4：任何异常都不阻断任务本身——判定失败就按原权限继续跑，并留日志。
- G5：不修改宿主与第三方插件源码，卸载即恢复原状（已切换的会话保持记录，不回落）。

### 2.2 非目标

- 不改变默认预设（不做方案 A 的事）。
- 不接管审批流程，不实现「自动应答审批」。
- 不修改 `session-scan.cjs` / 定时任务提示词。
- 不跨机器同步配置。

---

## 3. 用户故事

- **US-1**：作为主人，我希望凌晨的四个任务跑完不等人，第二天早上看到完整报告。
- **US-2**：作为主人，我希望白天在 QQ 里聊天时，会话仍是工作区可写 + 审批。
- **US-3**：作为主人，我想在设置页一键关掉这个行为，或改成只记录不切换，先观察一周。
- **US-4**：作为主人，我想知道插件到底改了哪些会话，出问题能查。

---

## 4. 技术设计（判定与生效）

### 4.1 判定输入

会话首条**有效** `user/message` 的 `data.source.kind`。「有效」指不是系统注入：

```ts
// 这些 kind 判为系统注入，跳过
'agent-instructions' | 'runtime-context' | 'skill-catalog' | 'time-context' | 'system-reminder'
```

规则：按 seq 顺序扫会话事件，取第一条非注入的 `user/message`，与配置的 `sources` 列表比对（大小写、空白不敏感）。

### 4.2 生效时机

两个入口同时挂，同一会话只处理一次（进程内 `Set`）：

1. **`agent/pre-step`（waterfall，主路径）**：该会话第一步开始前，看 `payload.messages` 里待入消息的 `source`。实测这是最早的时机——待入消息在 `pre-step` 就可见，而 `user/message` 要等 step 开始才 commit。
2. **`session/event`（emit，兜底）**：消息落盘那一刻（post-commit）。如果 1 因为插件后加载、事件被别处吞掉而没跑，这里补刀。

两条路都**绝不阻断**：`pre-step` 无论成败都 `next()`。

### 4.3 切换动作

```ts
ctx.inject(['permissionPresets'], (ctx) => {
  ctx.permissionPresets.set(session, targetPreset)
})
```

`set()` 内部会 append `permission/preset`，再按需写 `sandbox/mode`、`approval/policy`。这三个都是按会话投影读状态的（`sandboxPolicy.resolve()` 和 `approval.effectivePolicy()` 都读投影），所以**下一次工具调用**就是新权限，不需要重启，也不会给会话塞提示消息。

先前校验目标预设是否在目录里（`permissionPresets.catalog().options`），不在就记一条 warning，不切换。

### 4.4 幂等与去重

- 每个会话 id 只在内存里记一次处理结果（`handled: Set`），跨进程重启丢失可接受。
- 重启后重放：`current(session)` 已是目标值 → 判「already」，不产生任何事件。
- 插件自己只写一次，不会把自己算成「人工修改」。

### 4.5 失败处理

| 场景 | 行为 |
|---|---|
| `permissionPresets` 服务缺失 | 启动时记一条 warning，不做任何事 |
| 目标预设不存在 | 命中时校验；不切换，记 error（含当前可选预设列表） |
| `set()` 抛错 | 捕获，记 error，继续 `next()`，任务不受影响 |
| 会话已被用户手动切过预设 | 只要不在目标值就切换；`respectManual` 可关掉此行为 |

---

## 5. 功能需求

- **FR-1** 识别会话首条有效用户消息的 `source.kind`。
- **FR-2** 命中的会话调用 `permissionPresets.set(session, targetPreset)`。
- **FR-3** 只处理命中 `sources` 的会话；未命中的会话不产生任何事件。
- **FR-4** 提供 `enabled` 开关，关闭时插件完全不介入（除了一条 info 日志）。
- **FR-5** 提供 `dryRun`，为 true 时只记「本应切换 X → Y」，不调用 `set()`。
- **FR-6** 目标预设可配置；命中时校验是否存在。
- **FR-7** 可选 `respectManual`：会话里 `permission/preset` 事件数 > 1 就认为人工改过，不再覆盖。默认开启。
- **FR-8** 每次判定写一条结构化记录（会话 id、来源、原预设、新预设、耗时），落在 `<DSH_HOME>/storages/permission-autoswitch/decisions.jsonl`，不写会话。
- **FR-9** 设置页可编辑全部配置字段，改完即时生效，无需重启。
- **FR-10** 不新增任何工具（tool）、不新增 prompt 片段，模型看不到它。
- **FR-11** `requireFirstMessage`：只处理由投递创建出来的会话；投递进已有会话时不改那个会话的权限。默认开启。

---

## 6. 配置项

三层合并，后面的赢：包内 `DEFAULTS`（`lib/config.js`）← `cordis.patch.yml` 里这一行的 `config`
← 设置页写下的 `<DSH_HOME>/storages/permission-autoswitch/settings.json`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `targetPreset` | string | `"danger-full-access"` | 命中后切换到的预设名 |
| `sources` | string[] | `["schedule"]` | 触发来源的 `source.kind` 白名单 |
| `dryRun` | boolean | `false` | 只记录不切换 |
| `respectManual` | boolean | `true` | 人工切换过的会话不再覆盖 |
| `requireFirstMessage` | boolean | `true` | 只认会话首条有效消息 |
| `verbose` | boolean | `false` | 输出每次判定的细节日志 |

约束：`targetPreset` 必须是 `permissionPresets` 目录里已存在的名字。

> 实现取舍：宿主插件在 profile 里是 `link:` 进去的，包内 `import '@deepseek-ai/schemastery'`
> 解析不到（那些包在 `app.asar` 里），所以**没有**声明原生 `Config`，改用自管 `settings.json` +
> 自带设置页（`settings.section` 插槽）。好处是包目录保持干净（脱敏推送不带上本机配置），
> 代价是 `cordis.patch.yml` 里的 `config` 只作默认值、不参与宿主表单校验。

---

## 7. 非功能需求

- **NF-1** 零第三方运行时依赖，只用 `node:` 内置模块与宿主注入的服务。
- **NF-2** 不联网、不启动子进程；只写 `<DSH_HOME>/storages/permission-autoswitch/`。
- **NF-3** 每次判定最多扫一遍会话事件，且每个会话只扫一次；不轮询、不遍历历史。
- **NF-4** 细节日志默认关闭，避免夜间任务日志膨胀（`decisions.jsonl` 只留最近 200 行）。
- **NF-5** 卸载后不再产生新行为；已切换的会话保留其权限记录（符合宿主的会话事件语义）。
- **NF-6** 与现有插件无冲突：只读 `permissionPresets`、`session/event`、`agent/pre-step`，不注册同名服务、不占用工具名。

---

## 8. 安全与风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 权限放大 | 命中会话获得完全文件访问、无审批 | 作用范围仅限 `source.kind` 白名单；默认只含 `schedule`；`dryRun` 可先观察；随时可关 |
| 误判 | 某插件伪造 `source.kind='schedule'` 的消息 | `sources` 可精确控制；判定记录留下来源与会话 id |
| 把已有会话放开 | 定时任务投递进一个 QQ 会话，把那个会话提权 | `requireFirstMessage` 默认开：只认会话首条有效消息，投递进旧会话不切 |
| 静默失效 | 预设被改名后插件悄悄不生效 | 命中时校验，error 里写出「目标预设不存在 + 可选列表」 |
| 死循环 | 切换导致事件再次触发 | 只看首条消息 + `handled` 集合，天然不会回环 |

---

## 9. 观测

- 启动：`info` 一行（目标预设 / 来源 / dryRun / 两个判定开关）。
- 命中：`已切换 session-… 来源=schedule 目标=danger-full-access 原=workspace-write 2ms`。
- 跳过：只在 `verbose` 打开、或来源命中白名单却被别的规则拦下时记。
- 落盘：`decisions.jsonl`；设置页下半部直接显示最近 20 条。
- 接口：`GET /api/permission-autoswitch/status`、`POST /config`、`POST /reset`。

---

## 10. 验收标准

1. 新建一个 `target=new` 的定时任务（提示词只做无害操作，如 `echo`），投递后该会话里出现 `permission/preset = danger-full-access`、`sandbox/mode = danger-full-access`，且出现在第一条工具调用之前。
2. 同一时间手动新建的 GUI 会话、QQ 会话，权限仍是 `workspace-write`，无新增 `permission/preset` 事件。
3. `dryRun=true` 时上述定时任务会话**不**改变权限，但记录里有一条「本应切换」。
4. `enabled=false` 时插件零行为（除启动日志）。
5. 把 `targetPreset` 改成一个不存在的名字，插件不崩溃、任务照常跑，记录里有明确 error。
6. 设置页能看到并修改全部配置字段，改完立即生效（无需重启）。
7. 测试覆盖：来源判定、`sources` 白名单、幂等、未知预设、`respectManual`、两个入口、设置页接口。
8. 卸载插件后，新建的定时任务会话回到默认 `workspace-write`。

---

## 11. 交付物与发布流程

宿主插件走 `package.json` 的 `dsh.bundle.patch`（本机 0.2.2-rc.1 已不用 `dsh-plugin.json`）：

```
dsh-permission-autoswitch/
├─ package.json            # name/version/dsh.bundle.patch + dsh.client（设置页）
├─ cordis.patch.yml        # insert: 一行 entry（id: permission-autoswitch）
├─ lib/index.js            # 宿主半侧：两个判定入口、切换、设置页接口
├─ lib/detect.js           # 纯判定（来源、首条消息、人工修改）
├─ lib/config.js           # 纯配置（校验、三层合并）
├─ lib/store.js            # 落盘（settings.json / decisions.jsonl）
├─ client.js               # 设置页（自注册 client bundle）
├─ locale/{zh,en}.json     # 插件元信息
├─ icon.svg
├─ test/*.test.mjs         # node --test，38 条
├─ README.md
├─ docs/requirements.md
└─ LICENSE                 # MIT
```

发布流程：

1. 在工作区的 `dsh-permission-autoswitch` 独立目录开发；
2. 用 `plugin_manager install_bundle` 挂进本机 profile 验证；
3. 脱敏（凭据、本机路径、QQ 号、AppSecret 一律不出现）后推送到主人指定的 GitHub 仓库；
4. 每次更新同步版本号并在 README 写变更。

---

## 12. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | 判定逻辑 + 切换逻辑 + 日志 | ✅ 已在真实定时任务上验证 |
| M2 | 配置项 + 设置页 + 校验 | ✅ 设置页已注册，接口真机验证 |
| M3 | 测试 + README + 脱敏推送 | ✅ 38 条测试；已推到 `git@github.com:ZZh2333/dsh-permission-autoswitch.git`

---

## 13. 未决问题

1. **GitHub 仓库地址** —— 已拿到：`git@github.com:ZZh2333/dsh-permission-autoswitch.git`，`main` 首个提交 `d4b633e`，标签 `v0.1.0`。
2. 是否顺手覆盖 `source.kind` 为其它值的场景 —— v0.1 不做，往 `sources` 里加一项即可，不用改代码。
3. 是否在切换时往会话里补一句可见提示 —— v0.1 **不写**，避免污染任务上下文。
4. `respectManual` 的判定细节 —— 已定：数会话里 `permission/preset` 事件条数（创建时那条算 1，>1 就认为人工改过）。

---

## 14. 实现与验收记录（2026-11-16）

### 14.1 与草案的偏差

| 草案 | 实现 | 原因 |
|---|---|---|
| `dsh-plugin.json`（manifest v0.15） | 不用 | 本机 0.2.2-rc.1 的宿主插件走 `package.json` 的 `dsh.bundle.patch` |
| 原生 `Config` + `volatile` 字段 | 自管 `settings.json` + 自带设置页 | `link:` 安装的包解析不到 `@deepseek-ai/schemastery`（在 `app.asar` 里） |
| `config.json` 放包内 | 放 `<DSH_HOME>/storages/permission-autoswitch/` | 包目录保持干净，脱敏推送不带本机配置 |
| 主路径 `session/event`、兜底 `agent/pre-step` | 顺序反了：实测 `agent/pre-step` 先到 | 待入消息在 `pre-step` 就可见，`user/message` 要等 step 开始才 commit |

### 14.2 真机验收（`target=new`、DTSTART 2 分钟后、提示词只跑 `echo`）

会话 `session-90ef1486-…`，插件记录：`promote schedule workspace-write → danger-full-access 2ms (agent/pre-step)`。

解码该会话日志，事件序列：

| seq | 事件 | 内容 |
|---|---|---|
| 0-2 | `permission/preset` / `sandbox/mode` / `approval/policy` | `workspace-write` / `workspace-write` / `ask`（宿主创建时钉的） |
| 5 | `turn/start` | |
| **7-9** | `permission/preset` / `sandbox/mode` / `approval/policy` | **`danger-full-access` / `danger-full-access` / `never`（插件切的）** |
| 10 | `step/start` | |
| 12-16 | `user/message` | `schedule`、`agent-instructions`、`runtime-context`、`skill-catalog`、`time-context` |
| **20** | `tool/call` | `pwsh` —— 第一个工具调用，权限早已就位 |

验收 #1 通过：切换发生在第一条工具调用之前 13 个事件。

### 14.3 其它验收项

| # | 项 | 结果 |
|---|---|---|
| 2 | 其它会话不动 | 判定只认首条有效消息 + 白名单；本次会话（来源 `user`）没有任何新增 `permission/preset`；`decisions.jsonl` 里只有探针那一条 |
| 3 | `dryRun` | 单测覆盖：两条路都不调 `set()`，只记 `would-promote` |
| 4 | `enabled=false` | 两个入口第一行就 `return`，不扫事件、不扫消息 |
| 5 | 目标预设不存在 | 单测覆盖：不切、记 `error`、原因里带可选预设列表 |
| 6 | 设置页 | `settings.section` 已注册并 active（`id: permission-autoswitch`、`order: 33`）；接口真机验证通过（拒收空 `sources`、改值即时生效、恢复默认、落盘） |
| 7 | 测试 | 38 条：`detect` 13、`config` 9、`host`（假宿主接线）16 |
| 8 | 卸载回到默认 | 未实测；机制上成立：卸载后新会话没人碰，宿主照旧钉 `workspace-write` |

### 14.4 已知边界

- 宿主半是 `link:` 安装的，**改完 `lib/*.js` 要重启宿主才生效**（`client.js` 由客户端 HMR 单独管）。
- 设置页的渲染细节没在浏览器里逐像素看过，只验证了插槽注册与接口行为。
- `new_once` 目标复用会话时，第二次投递因为「不是首条消息」不会重切 —— 设计如此（`requireFirstMessage` 默认开）。

---

## 15. 0.2.0：第二条通道（会话 id）

### 15.1 起因

有些插件不经过 `ctx.schedule`，自己 `controller.create({ sessionId })` 一个会话再
`controller.prompt(...)` 投递（典型做法：`sessionId` 用固定名字或 `crypto.randomUUID()`）。
这类投递出来的消息 `source.kind` 是 `user`，和人在 GUI 里打字一模一样，白名单永远匹配不上；
新会话又已经在 `agent/created` 时被钉成 `workspace-write + ask`，第一次往工作区外写就抛审批。
那个会话没人开在界面上，审批没人答，投递队列（`tail` 串行）就一起停住 —— 表现为"新建会话卡在权限审批"。

### 15.2 做法

新增配置项 `sessionIdPattern`（正则源串，默认空 = 关闭）。命中就跳过来源白名单和
`requireFirstMessage`，直接走提权；`respectManual` 仍然生效。

区分依据是 id 形状：GUI / 定时任务 / 子代理建的会话一律 `session-` 开头，
插件自建的基本不是。示例：

```
sessionIdPattern: ^(my-bot|[0-9a-f-]{36}$)
```

| 会话 id | 命中 | 谁建的 |
|---|---|---|
| `my-bot-workdir` | ✓ | 固定名字的插件会话 |
| `85f455ce-a189-4b24-8ae2-a5a5a384e97e` | ✓ | 插件用裸 UUID 轮换出来的 |
| `session-85f455ce-…` | ✗ | GUI / 定时任务 / 子代理 |

### 15.3 验收

| # | 项 | 结果 |
|---|---|---|
| 1 | id 命中 + 来源 `user` → 提权 | 单测 `decide` 与假宿主 `session/event` 各一条 |
| 2 | id 命中 + 已有历史消息 → 仍提权 | 同上（绕开 `requireFirstMessage`） |
| 3 | id 命中 + 人工改过 → 不覆盖 | 同上 |
| 4 | `agent/pre-step` 只有系统注入消息时也能提权 | 假宿主测试：不等真消息 |
| 5 | id 不命中 → 行为与 0.1.0 完全一致 | 单测断言 `skip` |
| 6 | 坏正则 / 留空 → 一律不命中（不能误伤） | `matchesIdPattern` 三条断言 |
| 7 | 活体 | 插件运行中关闭再开启后重新加载新代码；`GET /api/permission-autoswitch/status` 能返回 `sessionIdPattern`，`POST /config` 即时写回；测试 50 条全绿 |
