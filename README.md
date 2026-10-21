# dsh-agent-progress

给 **DeepSeek Harness** 网页端加一条常驻的任务进度条：当前对话在干什么、走到第几步、还剩多少，一眼可见；其他对话里的任务也会自动出现在列表里。

- 一条扁平进度条，没有卡通元素、没有悬浮球、没有表情
- 没有任务时显示「无任务」，不消失
- 百分比来自真实数据（todo 清单、`done/total`、任务自己发布的进度、会话历史步数与耗时），不是来回滑动的加载动画
- 后台命令、子代理这类脱离回合运行的任务也会出现，含其他对话里的
- 可拖动、可展开，展开后每项任务各有一条自己的进度
- 只读本地文件与宿主任务注册表，不写宿主状态、不依赖任何第三方包

---

## 为什么

DSH 的一个回合可能跑很久：装依赖、下模型、批量处理文件。网页端原本只在会话里滚动输出，切到别的对话就完全不知道刚才那个任务走到哪了。这个插件补的就是这块：一条一直在右上角（可拖动）的进度条，加上「所有对话的任务」聚合视图。

## 特性

| 能力 | 说明 |
| --- | --- |
| 常驻 | 无任务时显示「无任务 · 空闲」，不会整条消失 |
| 真实百分比 | 优先用 `done/total`；有 todo 清单时用完成数；否则用该会话历史平均步数/耗时推算，封顶 99%，完成才到 100% |
| 跨会话聚合 | 任何对话正在跑的回合都会被自动发现，显示标题、项目目录、`第 N 轮 · 第 M 步`、已用与剩余 |
| 后台任务 | 接入宿主 `ctx.jobs` 事件流：后台命令、子代理、长任务一注册就出现，结束时显示完成/失败，跨会话同样可见 |
| 总进度 | 折叠时显示的是**所有在跑任务的加权总进度**（按 `total` 加权，无边界的任务各算 1 份），不再只挑其中一条 |
| 拖动 | 按住卡片拖动，位置存 `localStorage`，刷新后保持 |
| 展开 | 折叠时一行**总进度**；展开后每项任务一条进度、状态点、阶段/速度/耗时 |
| 五色克制 | 只用 `#21467A #C71F2D #D45814 #DBA972 #f4f5f7`，无阴影、无渐变、无半透明 |
| 零依赖 | 宿主侧只读 `fs`，网页侧只用 React 与宿主已注入的服务 |

## 安装

### 方式一：插件市场

在 DSH 网页端的「插件市场 → 已安装」里安装并启用 `dsh-agent-progress`。启用后刷新页面即可。

### 方式二：直接从 GitHub 装（尚未发布 npm 时）

本包是零依赖的纯 JS 插件，可以直接从 tag 的源码包安装，不需要先发 npm：

```bash
pnpm add "https://github.com/Autodog875/dsh-agent-progress/archive/refs/tags/v0.1.1.tar.gz" --dir <DSH_HOME>/profiles/desktop
```

装完用插件市场的开关把它启用（市场会负责写 `bundles` 并热加载），刷新页面即可。

> 这种方式市场里搜不到，更新时要把 URL 里的版本号一起改掉。

### 方式三：本地 link（开发用）

```bash
pnpm add "link:D:/path/to/dsh-agent-progress" --dir <DSH_HOME>/profiles/desktop
```

然后在插件市场里把 `dsh-agent-progress` 打开（市场会把它写进 profile 的 `bundles`）。

> 手改 `package.json` 的 `bundles` 会被插件市场的状态（`.dsh-market/state.json`）反推覆盖，请走市场开关。

## 使用

网页端会自动显示进度。需要让某个任务显示精确百分比时，用附带的 CLI 写一条记录：

```bash
# 开始一个 500 个文件的任务
node bin/ap.mjs set --key download --label "下载视频" --total 500 --done 0 --unit 个

# 推进（可反复调用，只需给变化的部分）
node bin/ap.mjs set --key download --done 137 --speed 3.2 --eta 120

# 结束 / 失败
node bin/ap.mjs done --key download
node bin/ap.mjs fail --key download --note "sha256 mismatch"

# 长任务保活（每 5 秒续一次心跳，直到超时）
node bin/ap.mjs hold --key download --seconds 600

# 清掉已结束的记录
node bin/ap.mjs clear

# 看记录目录
node bin/ap.mjs dir
```

记录写在 `<DSH_HOME>/agent-progress/<sessionId>/<key>.json`，默认同时镜像到所有会话目录，所以每个对话都能看到同一条进度（`--local` 只写当前会话）。

字段：

```json
{
  "key": "download",
  "label": "下载视频",
  "status": "running",
  "done": 137,
  "total": 500,
  "unit": "个",
  "speed": 3.2,
  "eta": 120,
  "phase": "加密校验",
  "note": "",
  "startedAt": 1792572000000,
  "updatedAt": 1792572060000
}
```

`status` 取 `running` / `done` / `failed`。`running` 的记录 15 秒没有心跳会被判定为中断；结束的记录保留 60 秒（界面再留 6 秒）。

## 百分比是怎么算的

按优先级：

1. 记录里给了 `total > 0` → `done / total`。
2. 会话有 todo 清单 → 已完成条数 / 总条数。
3. 后台任务自己发布了进度行（`7/10 files`、`42%`）→ 直接采用。
4. 都没有 → 用**该会话自己的历史**当分母：
   - 时间维度：`本轮已用 ÷ 平均每轮耗时`
   - 步数维度：`当前步数 ÷ 平均每轮步数`
   - 取两者较大值，夹在 1%–99% 之间；回合结束时由宿主状态变化自动消失。
   后台任务没有上面任何数据时，用 `已用时间` 做单调上升的估算，封顶 95%，只有真正结束才到 100%。

所以进度条随任务真实推进而增长，不会空转；但也请注意第 4 种是**估算**，不是精确值。

## 工作原理

```
网页端 (lib/client.js)
  └─ 注册槽位 conversation.session.header.actions
      └─ 每 0.8s（有任务）/ 4s（空闲）调用
          connection.rpc.call('/api', 'agentProgress/state', { request: { sessionId, global: true } })

宿主侧 (lib/index.js)  AgentProgressService
  ├─ 读 <DSH_HOME>/agent-progress/<sessionId>/*.json      ← 显式记录（ap.mjs 写）
  ├─ 订阅 ctx.jobs.events（进程级，所有会话）
  │     registered / progress / settled → 后台任务行（含归属会话、完成/失败）
  └─ 扫 <DSH_HOME>/storages/session_projcache/sessions/*.json
        sessionStats.openStep 非空 + 文件 2 分钟内被改写 = 该会话正在工作
        → 生成一行（标题、项目、轮/步、估算百分比）
```

`cordis.patch.yml` 把服务以 `agent-progress` 这个名字插入 profile 的插件图：

```yaml
- insert:
    - id: agent-progress
      name: 'dsh-agent-progress'
```

## 目录结构

```
lib/index.js        宿主侧服务：读记录、订阅任务事件流、扫会话、合并去重
lib/client.js       网页侧组件：进度条、拖动、展开、轮询
bin/ap.mjs          CLI：写/推进/结束记录
cordis.patch.yml    插件图补丁
test/preflight.mjs  客户端冒烟测试（桩 React + 桩模块加载器）
test/state-check.mjs 宿主侧 state() 合并逻辑测试
test/jobs-check.mjs 后台任务行测试（桩 ctx.jobs 事件流）
test/demo*.mjs      演示用：造几条假任务
```

## 开发

```bash
node test/preflight.mjs     # 11 项客户端检查
node test/state-check.mjs   # 宿主侧合并/单位/foreign 检查
node test/jobs-check.mjs    # 后台任务行：百分比解析、跨会话归属、结算状态
```

改完客户端代码后，让宿主重建补丁：

```bash
curl -X POST http://127.0.0.1:<GUI 端口>/dsh-market/toggle \
  -H 'content-type: application/json' \
  -d '{"name":"dsh-agent-progress","enabled":false}'
curl -X POST http://127.0.0.1:<GUI 端口>/dsh-market/toggle \
  -H 'content-type: application/json' \
  -d '{"name":"dsh-agent-progress","enabled":true}'
```

## 兼容性

- DSH 0.2.x（桌面端 / 网页端），`dsh.bundle.patch` + `dsh.client.platform: web`
- peer：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-typert-protocol`
- Node.js ≥ 20（CLI 用）

## 已知边界

- 折叠时的「总进度」是加权平均：同时跑多个任务、中途又新来一个 0% 的任务时，数字可能短暂回退，这是平均的固有行为；新任务出现的前 2 秒不参与加权，避免数字瞬间塌陷。
- 后台任务靠宿主任务注册表（`ctx.jobs`）的事件流发现：插件加载**之后**注册的任务必然可见；加载前就在跑的，会在第一次轮询时用 `jobs.list(sessionId)` 补种。任务注册表是进程内的，重启后自然清空。
- 没有 todo、没有 `total`、任务也没发布进度的，百分比是估算值。
- 只读本机 `<DSH_HOME>` 下的进度与投影文件，不联网、不上报。诊断文件 `<DSH_HOME>/agent-progress/.host-status.json` 只记录本插件自己的状态。

## 更新日志

### v0.1.2

- 折叠时显示**总进度**：所有在跑任务按 `total` 加权平均（没有 `total` 的各算 1 份），文案变成「总进度 · N 个任务」，右侧给 `xx% · ✓完成数 · ✗失败数`。
- 失败项不参与平均，只进计数；新任务前 2 秒不参与，避免数字瞬间回退。
- 只有一个任务时行为不变，仍显示它的标题与进度。
- `test/preflight.mjs` 增加 6 项聚合断言（单任务等价、按量加权、失败不拉低、新任务淡入、全为瞬时任务）。

### v0.1.1

- 修复：后台任务在跑时错误显示「无任务」。宿主侧现在订阅 `ctx.jobs.events`，注册、进度、结算都会变成进度条里的一行，跨会话可见。
- 后台任务有自报进度（`7/10`、`42%`）时用真实百分比；没有时按已用时间给出单调上升、封顶 95% 的估算。
- 新增 `test/jobs-check.mjs`。

### v0.1.0

首个版本：常驻进度条、跨会话聚合、确定百分比、拖动与展开、五色配色、CLI 写记录。

## License

MIT
