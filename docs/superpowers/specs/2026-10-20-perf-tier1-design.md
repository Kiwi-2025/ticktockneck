# 第一梯队性能优化 — 设计说明

日期：2026-10-20
状态：已实现

## 背景

上一轮优化（`2026-07-28-perf-autostart-design.md`）解决了「每秒唤醒一次」的问题，
把固定 `setInterval` 换成了按阶段自适应的 `setTimeout`。本轮是在那之上的第二梯队，
目标集中在**内存**、**启动速度**，以及修掉几个让界面「看起来卡住」的实际缺陷。

## 实测基线（改动前，Electron 31）

| 状态 | 总内存(WS) | 进程构成 |
|------|------------|----------|
| 无任何窗口 | 150 MB | Browser 53 + GPU 61 + Utility 36 |
| 常驻主窗口 | 253 MB | 上面 + 渲染进程 62 |
| 休息弹窗弹出时 | 325 MB | 上面 + 第二个渲染进程 71 |

空闲 CPU 30 秒内消耗 0.00s —— 上一轮的节流已经生效，CPU 侧没有优化空间了。
因此本轮把重点放在内存占用、启动过程，以及几处「看起来不对」的行为。

## 变更项

### 1. `Menu.setApplicationMenu(null)`

Electron 官方 performance checklist 第 8 条：不需要默认菜单时，在 app ready 前清空，
否则 Electron 会为每个 `BrowserWindow` 搭建一套默认菜单栏。托盘菜单走的是独立的
`Tray.setContextMenu`，不受影响。

### 2. 主窗口 `show: false` + `ready-to-show` + `backgroundColor`

原先是先 `show()` 再 `loadFile()`，首帧没画完用户看到白闪。改为等 `ready-to-show`
再显示，并给窗口设置与 `styles.css` 一致的 `backgroundColor`，避免深色主题下的
白底闪烁。提醒弹窗本来就用了这个写法，主窗口对齐。

### 3. 只向可见窗口广播（`mainWindowVisible`）

隐藏的主窗口收到 IPC 也会被唤醒渲染进程，白做一次 DOM 更新。原先可见性靠
`isVisible()` 现场查询，改为用 `show` / `hide` 事件维护一个标志位：

- 事件时序比 `isVisible()` 更确定，不会出现「窗口刚显示、可见性还没生效」导致
  1 秒刷新退化成 60 秒一次的情况；
- `hide` 事件同时把 tick 节奏从 1 秒切回 60 秒。

### 4. 窗口重新显示时补发快照

窗口隐藏期间不推 IPC，重新显示时必须补一次，否则显示的是隐藏那一刻的旧值。

### 5. 计时器未运行时不再轮询

`nextTickDelay('idle')` 原本恒为 60 秒，但计时器没在跑的时候状态根本不会变化，
这个定时器只是白白唤醒进程。现在 `scheduleTick()` 在 `!timer.running` 时直接不排程；
所有会改变状态的入口（开始 / 重置 / 改时长 / 跳过休息 / 暂停）都会重新调用
`scheduleTick()`，行为不受影响。

### 6. 计时器运行时输入框不再被覆盖

`renderer.js` 原本在每次 tick 时无条件写 `activityInput.value` / `restInput.value`。
窗口可见时 tick 是 1 秒一次，用户刚敲进输入框的字符会在 `change` 事件触发前被冲掉，
**框里根本打不进字**。现在跳过正在编辑的输入框，值没变化时也不写 DOM。

### 7. `TimerState.snapshotAt(now)`

根因修复。`remainingMs` 平时只在 `tick()` 里刷新，也就是两次 tick 之间读到的
`snapshot` 是上一次的值。窗口隐藏时 tick 是 60 秒一次，这时候把 `snapshot` 推给
渲染进程，推过去的就是一个陈旧的倒计时 —— 这正是「从托盘重新打开主窗口，倒计时
最多冻结 60 秒」的真正成因。

`snapshotAt(now)` 按当前时刻重算剩余时间（不改动任何阶段切换逻辑，`snapshot`
本身保持原样以兼容现有测试），`broadcast()` / `scheduleTick()` / `timer:getState`
统一改用它。

### 8. `loadFile` 改用绝对路径

`loadFile('index.html')` 是相对 `app.getAppPath()` 解析的，换个入口启动就找不到
文件。改成 `loadFile(path.join(__dirname, 'index.html'))`，同时也让端到端冒烟
测试能放在 `scripts/` 目录下运行（`node --test` 会把 `test/` 目录下的所有 `.js`
都当成测试文件，冒烟脚本必须放在 `test/` 之外）。

## 影响面

| 文件 | 变更 |
|------|------|
| `main.js` | 菜单清空；主窗口 `show:false`；`mainWindowVisible` 标志位；只向可见窗口广播；`show` 时补发；未运行时不再排程；`snapshotAt`；`loadFile` 绝对路径 |
| `renderer.js` | 跳过聚焦中的输入框，值未变不写 DOM |
| `lib/timer.js` | 新增 `snapshotAt(now)`（只读方法，不触碰阶段切换） |
| `test/timer.test.js` | 新增 3 个 `snapshotAt` 单测 |
| `scripts/smoke.js` | 新增端到端冒烟测试（`npm run smoke`） |
| `package.json` | 新增 `smoke` 脚本 |
| `README.md` | 补充冒烟测试说明与文件清单 |

## 实测结果

| 指标 | 改动前 | 改动后 |
|------|--------|--------|
| 窗口可见（空窗框弹出） | ~88 ms | ~187 ms |
| **窗口内容就绪** | ~280 ms | **~175 ms（-37%）** |
| 内容就绪前的白闪时长 | ~190 ms | 0（等首帧画好才显示） |
| 空闲态内存 | 278~289 MB | 282~291 MB（持平，本轮不动进程结构） |
| 空闲 CPU | ≈0 | ≈0 |

「窗口可见」变晚是设计使然：旧代码先弹一个空窗框再慢慢填内容，新代码等首帧画好
再显示。**用户看到成品界面的时间提前了约 100 ms，并且全程没有白闪。**
内存收益在第二梯队（隐藏时销毁主窗口、开机静默驻留）。

## 测试

- `node --test`：23 个用例全绿（原有 20 + 新增 3）。
- `npm run smoke`（端到端，驱动真实窗口）：12 项全绿 —— 菜单已移除、窗口正常显示、
  倒计时逐秒刷新、聚焦中的输入框不被覆盖、隐藏后重开倒计时是新鲜的（漂移 = 隐藏
  时长）、暂停后时钟冻结、恢复后继续走、休息阶段弹窗正常弹出并倒数、点「知道了」
  能关闭、阶段回到活动中。

## 留待第二梯队

- 隐藏时 `destroy()` 主窗口（可再省约 62 MB，代价是每次打开多几百毫秒）。
- 开机自启静默驻留托盘（`--hidden`，历史上被移除过一次，懒创建逻辑已就位）。
- 休息弹窗预建，消除每次弹出的渲染进程冷启动。
- Electron 31 → 新版；`logo.jpg` 只解码一次；`saveConfig` / `videoUrls` 改异步。
- `spellcheck: false`；`powerMonitor` 处理睡眠唤醒。
