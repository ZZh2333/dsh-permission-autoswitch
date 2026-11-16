/**
 * dsh-permission-autoswitch · 落盘
 *
 * 只碰两个文件，都在 <DSH_HOME>/storages/permission-autoswitch/ 下：
 *   settings.json   设置页写下的那几项（插件目录保持干净，方便脱敏推送）
 *   decisions.jsonl 最近 200 条判定记录，出问题能查
 *
 * 所有异常都被吞掉：配置文件坏了就用默认值，日志写不了就不写，绝不拦住定时任务。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DECISIONS_MAX_LINES = 200

/** DSH 主目录：优先环境变量，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function storeDir() {
  return join(dshHome(), 'storages', 'permission-autoswitch')
}

export function settingsFile() {
  return join(storeDir(), 'settings.json')
}

export function decisionsFile() {
  return join(storeDir(), 'decisions.jsonl')
}

function ensureDir() {
  try {
    mkdirSync(storeDir(), { recursive: true })
  } catch {
    /* 建不出来也不影响判定 */
  }
}

/** 读设置页存的覆盖值；没有或坏了都返回 undefined。 */
export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : undefined
  } catch {
    return undefined
  }
}

/** 原子写：先写临时文件再 rename，写到一半断电不会留下半个 JSON。 */
export function writeSettings(value) {
  ensureDir()
  const path = settingsFile()
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return value
}

/** 追加一条判定记录，只保留最近 200 行。 */
export function appendDecision(entry) {
  try {
    ensureDir()
    let lines = []
    try {
      lines = readFileSync(decisionsFile(), 'utf8').split('\n').filter(Boolean)
    } catch {
      /* 第一次写 */
    }
    lines.push(JSON.stringify(entry))
    if (lines.length > DECISIONS_MAX_LINES) lines = lines.slice(-DECISIONS_MAX_LINES)
    writeFileSync(decisionsFile(), `${lines.join('\n')}\n`)
  } catch {
    /* 日志写不了不影响功能 */
  }
}

/** 读最近 n 条判定记录（新的在后）。 */
export function readDecisions(limit = 30) {
  try {
    const lines = readFileSync(decisionsFile(), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}
