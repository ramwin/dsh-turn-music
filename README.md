# dsh-turn-music

[![npm](https://img.shields.io/npm/v/dsh-turn-music?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-turn-music)
[![license](https://img.shields.io/npm/l/dsh-turn-music?color=blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)

> DeepSeek Harness 的**回合提醒音乐**：对话（回合）结束时自动响起音乐，把离开屏幕的你叫回来。内置电话「叮铃铃」铃声，可在设置里开关、改路径或直接上传音频，右下角浮标随时暂停。

> Turn-finished music reminder for DeepSeek Harness Web: a chime/ringtone (bundled telephone ring, or any local audio file, or an upload) plays when the agent finishes a turn, with an in-page chip to pause/dismiss.

---

## 它解决什么问题

Agent 跑长任务时你走开了，回来才发现它十分钟前就答完了。这个插件在**回合结束的那一刻**播放一段音乐，一直响到你点暂停；声音在浏览器里播，所以手机、笔记本、远程访问的页面都能听见。

```
回合开始 → （你走开）→ 回合结束 → 🔊 叮铃铃 + 右下角浮标「⏸ 暂停 / ✕」
```

## 特性

- **回合结束自动响**：监听会话状态（`running` 由 true 变 false），不依赖模型自我提醒，也不占用 API 调用。
- **设置里开关**：`设置 → 内置插件 → 回合提醒音乐`，同一张卡片也出现在左侧**插件**面板里。
- **自定义音乐**：填宿主机绝对路径（支持 `~`），或直接在卡片里**选文件上传**（远程访问也能用）。
- **内置默认铃声**：随包分发的电话「叮铃铃」（6.5 秒，52 KB，纯合成、CC0，见 `scripts/make-ringtone.py`），装完即响，不需要准备任何音频。
- **暂停 / 继续 / 关闭**：右下角浮标，点击暂停，再点继续，✕ 关掉这一次。
- **1 秒渐强 / 渐弱**：起播从静音淡入，暂停、关闭、到时自动停时淡出，不会突然炸响，循环铃声的接缝也听不出来。
- **暂停续播**：暂停会记住当前播放位置，点「继续」从原处接着放，而不是从头再响一遍。
- **团队模式不误报**：Agent Teams 里子任务完成、或 Lead 让出回合但团队仍在跑时不响；等整个团队收尾（没有进行中的任务、没有成员还在跑）才提醒。
- **全局默认配置**：默认值可以写进 profile 的 `cordis.patch.yml`（部署级），个人设置在设置页覆盖，所有会话、所有项目共用一份。
- **不吵人**：默认忽略子代理会话与团队子任务（它们只是父对话的一步）；可选「只提醒当前正在看的会话」；默认响 120 秒自动停，可设 0 = 不限。
- **单文件、无构建**：host half 是普通 ESM，browser half 是 shell 模块表里的一份 CJS 风格 bundle，`npm i` 即用。

## 安装

```sh
dsh plugin --profile web add dsh-turn-music
```

装完**重启一次 dsh web**（或在插件面板里触发一次重载），刷新页面即可。

从 GitHub 装（未发布到 npm 时的备用来源）：

```sh
dsh plugin --profile web add github:ramwin/dsh-turn-music
```

## 使用

1. 打开 `设置 → 内置插件 → 回合提醒音乐`（或左侧栏「插件」面板里的同名卡片）。
2. 「启用」默认已开；点**试听**确认音量和音源。
3. 想要自己的音乐：填路径，或点文件框选一个 mp3 上传。
4. 回合结束时音乐响起，右下角浮标可**暂停 / 继续 / 关闭**。

> **浏览器自动播放**：浏览器要求页面至少被点过一次才允许出声。你正常用 GUI 打字/点按钮就已经满足；如果第一时间没声音，浮标会显示「浏览器拦截了自动播放，点一下播放」，点它即可。

### 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 回合结束时是否播放 |
| 音乐文件 | 空 | 留空 = 内置叮铃铃；填 `~` 或绝对路径；也可上传 |
| 音量 | 80 | 0–100，滑杆步进 1%，只影响本插件的播放 |
| 循环播放 | 开 | 一直响到你手动暂停/关闭（关掉则播完一遍就停） |
| 最长响多久 | 120 秒 | 循环时的安全上限，0 = 不限 |
| 只提醒当前会话 | 关 | 开：只对屏幕上正在看的会话响 |
| 忽略子代理会话 | 开 | 子代理与团队子任务的回合结束不响（团队子任务始终静音） |

设置存在 `~/.dsh/turn-music.json`（全局，不分项目/会话）；上传的音频存在 `~/.dsh/turn-music/`。

### 部署级默认值（全局）

在 profile 的 `cordis.patch.yml` 里给插件条目写 `config`，它成为**默认值**（个人设置仍可覆盖，「恢复默认」回到这里）：

```yaml
- id: turn-music
  name: 'dsh-turn-music'
  config:
    enabled: true
    file: /srv/sounds/ring.mp3
    volume: 80
    loop: true
    maxSeconds: 120
    onlyCurrent: false
    muteSubagent: true
```

## 工作原理

```
浏览器                                    宿主进程
────────────────────────────────────      ─────────────────────────────
sessions.list 快照
  running: true → false  ──┐
                           ├─► <audio src=/dsh-turn-music/audio>
GET /dsh-turn-music/config ┘                 ├─ 读 ~/.dsh/turn-music.json
POST /dsh-turn-music/config ────────────────►├─ 校验并落盘
POST /dsh-turn-music/upload ────────────────►└─ 存 ~/.dsh/turn-music/ringtone.*
```

- **为什么触发在浏览器**：回合结束这个「边界」只有页面能看见（`sessions.list` 是客户端会话列表 store，每行带 `running`）；也只有页面能把声音放出来。宿主进程在服务器上，没有扬声器。
- **为什么要宿主 half**：浏览器读不到宿主机的绝对路径。音频由宿主经 HTTP 流式下发（支持 `Range`），所以远程打开页面、甚至手机访问，都能播出本机上的那个文件。
- **不回放历史**：页面打开时的第一份快照只做基线，已经在跑的会话不会因为刷新就误响。

## 常见问题

**没声音？** 先看浮标：显示「浏览器拦截了自动播放」就点一下；否则检查设置里的音量与「启用」，以及文件路径是否还存在（宿主会自动回退到内置铃声）。

**多个标签页同时开着？** 每个页面都会响一次。需要单窗口行为的话，关掉其他标签页即可（这点与音乐播放器不同，后续可按需加跨窗口去重）。

**团队模式（Agent Teams）下为什么子任务完成不响？** 团队跑起来以后，Lead 会在等成员时多次结束回合，成员完成一个子任务也只是整个流程中的一步——这时候响会误报。插件同时适配两种团队实现：

- **内置 Agent Teams**：读 Lead 会话的 `agentTeam` 投影，只要还有 `in_progress` 任务、或还有成员会话在跑，就不响；
- **`@nanmicoder/dsh-agent-teams`**：读它的 `/plugins/dsh-agent-teams/state` 快照，团队还有没收尾的任务（未 completed / failed / cancelled）或有成员在 working，就不响。

两种情况都是整个团队收尾后 Lead 的最后一次回合结束才提醒；团队停在 staged 等审批、或已经没有在跑的任务时，仍会正常提醒。

**刷新/重启后设置还在吗？** 在。设置在宿主侧 `~/.dsh/turn-music.json`，不依赖浏览器 localStorage。

**能不能播放网络音频？** 目前只支持本机文件与上传。在线电台/音乐建议配 `dsh-music-player`。

**安全边界**：`/dsh-turn-music/*` 走 dsh 自己的登录态；能读到的只是被配置的那一个音频文件（或上传目录），不做任意路径列举。

## 开发与验证

```sh
npm test          # host 侧校验逻辑 + 浏览器侧回合检测逻辑（无 jsdom）
```

需要一个**独立实例**做端到端验证（会真的跑一轮模型回复，别对着正在用的宿主跑）：

```sh
dsh web --port 3099 --no-open --host 127.0.0.1 > /tmp/boot.log 2>&1 &
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/boot.log | head -1 | cut -d= -f2)
node scripts/verify-browser.mjs "http://127.0.0.1:3099/?token=$TOKEN"   # 客户端 half 是否加载、浮标是否创建
node scripts/verify-turn.mjs    "http://127.0.0.1:3099/?token=$TOKEN"   # 真发一条消息，等回合结束，断言浮标亮起+暂停可用
```

重新生成内置铃声（需要 ffmpeg）：

```sh
python3 scripts/make-ringtone.py assets/ringtone.mp3
```

## 许可

MIT。内置铃声由 `scripts/make-ringtone.py` 纯数学合成，不涉第三方素材，随包按 CC0 使用。
