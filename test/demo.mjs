// 演示心跳：让进度条在 5 分钟里持续走动，便于刷新页面后确认渲染正常。
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'C:/Users/13001/.dsh'
const session = process.env.DSH_SESSION_ID
if (!session) throw new Error('DSH_SESSION_ID missing')

const dir = join(home, 'agent-progress', session)
mkdirSync(dir, { recursive: true })
const file = join(dir, 'ap-selftest.json')

const total = 20
const stepMs = 15000
let done = 0
let startedAt = Date.now()

const write = (status) => {
  const rec = {
    key: 'ap-selftest',
    label: '进度条自检',
    unit: '步',
    total,
    done,
    speed: 1 / (stepMs / 1000),
    eta: status === 'running' ? Math.max(0, total - done) * (stepMs / 1000) : 0,
    phase: '进度条在动就说明生效了',
    note: '',
    status,
    startedAt,
    updatedAt: Date.now(),
  }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8')
  renameSync(tmp, file)
}

write('running')
console.log(`demo started: ${file} total=${total} every ${stepMs / 1000}s`)

const timer = setInterval(() => {
  done += 1
  if (done >= total) {
    write('done')
    console.log('demo done')
    clearInterval(timer)
    return
  }
  write('running')
  console.log(`tick ${done}/${total}`)
}, stepMs)
