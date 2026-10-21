// 演示三任务心跳：用于验证折叠/展开、拖拽、逐项进度。
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'C:/Users/13001/.dsh'
const session = process.env.DSH_SESSION_ID
if (!session) throw new Error('DSH_SESSION_ID missing')

const dir = join(home, 'agent-progress', session)
mkdirSync(dir, { recursive: true })

const STEP_MS = 6000
const tasks = [
  { key: 'ap-ui', label: '进度条界面改造', unit: '步', total: 60, phase: '折叠 / 展开 / 拖拽' },
  { key: 'ap-color', label: '配色审计', unit: '项', total: 20, phase: '只保留指定五色' },
  { key: 'ap-load', label: '热加载验证', unit: '次', total: 15, phase: '等你刷新页面' }
].map((task) => ({ ...task, done: 0, startedAt: Date.now(), finishedAt: null, status: 'running' }))

function writeAll() {
  for (const task of tasks) {
    const running = task.status === 'running'
    const remaining = Math.max(0, task.total - task.done)
    const rec = {
      key: task.key,
      label: task.label,
      unit: task.unit,
      total: task.total,
      done: task.done,
      speed: running ? 1 / (STEP_MS / 1000) : 0,
      eta: running ? remaining * (STEP_MS / 1000) : 0,
      phase: task.phase,
      note: '',
      status: task.status,
      startedAt: task.startedAt,
      updatedAt: Date.now()
    }
    if (task.finishedAt !== null) rec.finishedAt = task.finishedAt
    const file = join(dir, task.key + '.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}

writeAll()
console.log('demo tasks started')

const timer = setInterval(() => {
  let allDone = true
  for (const task of tasks) {
    if (task.status !== 'running') continue
    task.done = Math.min(task.total, task.done + 1)
    if (task.done >= task.total) {
      task.status = 'done'
      task.finishedAt = Date.now()
    } else {
      allDone = false
    }
  }
  writeAll()
  if (allDone) {
    clearInterval(timer)
    console.log('demo tasks done')
  }
}, STEP_MS)
