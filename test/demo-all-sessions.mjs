// 给每个已知会话各写一条 running 记录：用来判断"别的对话根本不挂载组件"还是"挂载了但宿主是旧代码"。
import { readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'C:/Users/13001/.dsh'
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const root = join(home, 'agent-progress')

const ids = readdirSync(cacheDir)
  .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))

console.log('sessions: ' + ids.length)
for (const id of ids) console.log('  ' + id)

const state = new Map(ids.map((id) => [id, { done: 0, startedAt: Date.now() }]))
const STEP_MS = 6000
const TOTAL = 40

function write() {
  for (const [id, info] of state) {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    const rec = {
      key: 'ap-cross',
      label: '跨会话可见性测试',
      unit: '步',
      total: TOTAL,
      done: info.done,
      speed: 1 / (STEP_MS / 1000),
      eta: Math.max(0, TOTAL - info.done) * (STEP_MS / 1000),
      phase: '每个会话各写一条',
      note: '',
      status: info.done >= TOTAL ? 'done' : 'running',
      startedAt: info.startedAt,
      updatedAt: Date.now()
    }
    if (info.done >= TOTAL) rec.finishedAt = Date.now()
    const file = join(dir, 'ap-cross.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}

write()
console.log('wrote records for ' + ids.length + ' sessions')

const timer = setInterval(() => {
  let done = 0
  for (const info of state.values()) {
    info.done = Math.min(TOTAL, info.done + 1)
    if (info.done >= TOTAL) done++
  }
  write()
  if (done === state.size) {
    clearInterval(timer)
    console.log('all done')
  }
}, STEP_MS)
