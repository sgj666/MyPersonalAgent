# 工作台视频下载工具（抖音 / 小红书 / B 站）调研与实施方案

| 项 | 内容 |
|---|---|
| 版本 | v1（调研完成，待 P0 实测确认） |
| 日期 | 2026-11-22 |
| 仓库 | `MyPersonalAgent`（CowAgent 分支，教师 AI 工作台） |
| 需求 | 粘贴抖音 / 小红书 / B 站视频链接 → 去水印下载到本地工作台 |
| 页面原型 | `docs/plans/video-download-ui.html`（六种状态，可切深色） |
| 结论先行 | 单引擎 **yt-dlp**（Unlicense）+ 自写 URL 归一化/错误映射 + **ffmpeg**（`imageio-ffmpeg`）。不引入第二套下载器。 |

---

## 1 需求与范围

### 1.1 输入

用户手上实际有的是**分享文案**，不是干净的链接：

```
8.88 复制打开抖音，看看【xxx】的作品 https://v.douyin.com/iRxxxx/ 复制此链接...
69 【标题】 😆 http://xhslink.com/a/xxxx，复制本条信息...
【标题】 https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy_web
```

所以「粘贴 → 得到 mp4」中间必须有一步：**从任意文本里抽出 URL，再把短链解析成规范链接**。

### 1.2 输出

- 一个本地 `.mp4`（无平台水印），落在 `output/视频下载/<日期>/` 下
- 自动进入「产出文件」列表，页面内可直接播放；对话里可以 `send` 给渠道

### 1.3 初版不做

图集/图片笔记、直播录制、字幕与弹幕、批量粘贴多链接、自动追更、转写（转写另接既有 `/api/voice/asr`）。

---

## 2 开源项目调研

### 2.1 横向对比

星数/维护状态取自 GitHub API（2026-11-22）。

| 项目 | 形态 | License | 抖音 | 小红书 | B 站 | 维护 | 评价 |
|---|---|---|---|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Python 库/CLI | **Unlicense** | ✅ `DouyinIE` | ✅ `XiaoHongShuIE` | ✅ `BiliBiliIE`（含番剧/课程/合集） | 每日更新，★210k | **三平台全覆盖，许可最干净，事实标准** |
| [lux](https://github.com/iawia002/lux) | Go 单二进制 | MIT | ✅（内置 `sign.js` 用 goja 算签名） | ✅（解析页面 `backupUrls`） | ✅ | ★32k，2026-03 后转缓 | 打包最省事，但清晰度/分 P/番剧覆盖弱于 yt-dlp |
| [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) | Python CLI/GUI | ⚠️ GPL-3.0 | ✅ 最强 | ❌ | ❌ | 活跃 ★17.6k | 只覆盖抖音；**GPL 传染**，不能并入分发 |
| [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | Python CLI | ⚠️ GPL-3.0 | ❌ | ✅ 最强（含图集） | ❌ | 活跃 ★13.4k | 同上，GPL 问题 |
| [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | FastAPI 服务 | Apache-2.0 | ✅ | 部分 | ✅ | 活跃 ★21.5k | 许可友好，但要额外跑一个进程/端口，能力不超出 yt-dlp |
| [BBDown](https://github.com/nilaoda/BBDown) | C# CLI | MIT | ❌ | ❌ | ✅ 最强（8K/杜比/番剧） | ★13.8k | 要带 .NET 运行时，收益不值得 |
| [you-get](https://github.com/soimort/you-get) | Python CLI | MIT | ❌ | ❌ | ✅ | ★56.9k，更新慢 | 抖音/小红书都没有，出局 |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | Playwright 爬虫 | ⚠️ **非商用** | ✅ | ✅ | ✅ | 活跃 ★71.5k | 采集向（帖子/评论），重，许可不可商用，出局 |

### 2.2 关键事实（已核对 yt-dlp 源码，非道听途说）

- `yt_dlp/extractor/_extractors.py` 中确有 `DouyinIE`、`XiaoHongShuIE`、`BiliBiliIE`。
- `DouyinIE._VALID_URL = https?://(?:www\.)?douyin\.com/video/(?P<id>[0-9]+)` —— **不认 `v.douyin.com` 分享短链**。
- `DouyinIE._real_extract` 直接打 `www.douyin.com/aweme/v1/web/aweme/detail/`，失败时明确报 *"Fresh cookies (not necessarily logged in) are needed"* —— **抖音需要 cookie**。
- `_parse_aweme_video_app` 优先取 `video.play_addr`（`format_id=play_addr`，`format_note="Direct video"`）；`video.download_addr` 在 `has_watermark` 为真时被扣到 `preference=-2`。**即抖音的「去水印」= 取 `play_addr`，yt-dlp 默认就选它**。
- `XiaoHongShuIE._VALID_URL` 只认 `/explore/<24hex>` 与 `/discovery/item/<id>`，**不认 `xhslink.com`**；其官方测试用例里已带 `xsec_token`，说明 query 必须原样保留。无水印源是 `note.video.media.stream.*[].masterUrl` / `backupUrls`。
- `BiliBiliIE` 只匹配 `bilibili.com/video/BV…|av…`（含 `festival?bvid=`），**不认 `b23.tv`**。
- 三家的短链都得我们自己解；这一步顺带把 SSRF 白名单也做掉。

### 2.3 许可结论

yt-dlp 是 Unlicense（等价公有领域），可以随意内嵌/改。TikTokDownloader、XHS-Downloader 是 GPL-3.0，**只适合独立进程调用、不适合并入本仓库分发**；它们的能力（图集、评论）超出了本期需求。MediaCrawler 是「非商用」自定义许可，直接排除。

---

## 3 三平台的水印与限制

| 平台 | 「去水印」的真实含义 | 前提条件 | 已知限制 |
|---|---|---|---|
| 抖音 | 取 `play_addr` 直出流；带水印的只有 `download_addr` | 网页详情 API 需要 cookie + 签名，**但分享页不需要**（见 §3.1） | 网页端风控会随 IP/频率收紧 |
| 小红书 | 取 `stream.*[].masterUrl`（页面 `__INITIAL_STATE__` 内），不是「把水印抹掉」 | 完整 URL（含 `xsec_token`）+ 一个本地生成的访客 `a1` | 少数笔记有登录墙；风控较硬 |
| B 站 | CDN 流本身无平台水印（个别人自己烧进画面的除外） | ≤720P 免登录；1080P 需 `SESSDATA`；4K/HDR/杜比需大会员 | 音视频分离（DASH），**必须 ffmpeg 合并**；分 P / 合集要显式选择 |

**共同点**：所有「去水印」都不做像素级修补，只取平台自己的无水印播放流。因此难点不在图像处理，而在**拿得到播放地址**——变量只有两个：走哪条接口、要不要签名。

---

### 3.1 结论：不需要用户登录，也不「内置 cookie」（P0 已实测）

先明确三件事，它们是同一件事的三个层次：

1. **用户登录** = 用户交出自己账号的 `SESSDATA` / `web_session`。本需求不需要。
2. **「内置 cookie」** = 把一串 cookie 硬编码进安装包，全员共用。**必然失效**，别做。
3. **访客身份** = 每台机器自己现场取得（或干脆不用）。可以，而且这就是落地方式。

| | 内置一份共享 cookie | 每机现场取/不用 |
|---|---|---|
| 有效期 | 几天到几周就过期，包发出去就开始烂 | 取一次用几小时，过期就换；抖音干脆不依赖 |
| 风控 | 几万台机器同一个身份 → 秒判异常、集体限流 | 每台机器一个身份，与真人浏览器无异 |
| IP 绑定 | cookie 与签发 IP 弱绑定，换网络就掉 | 随取随用，天然同 IP |
| 合规 | 等于分发他人会话凭证，性质最差 | 只是「一次未登录浏览」 |

**但「不登录」不等于「随便发个 HTTP 就行」**。实测（§14）推翻了原先的乐观估计：

| 平台 | 免登录路径 | 实测结果 |
|---|---|---|
| 小红书 | 页面 HTML（`__INITIAL_STATE__`）里的 `stream.*.masterUrl`，yt-dlp 已实现 | ✅ **可用，2.6 秒**。必须带短链跳转里的 `xsec_token` |
| B 站 | `playurl` + DASH 音视频合并 | ✅ **可用**，访客就能拿 1080P（部分视频要登录），需要 ffmpeg |
| 抖音 | ~~分享页 `_ROUTER_DATA`~~ → **已失效**；`aweme/v1/web/aweme/detail` 返回 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`（带 `ttwid` 也一样） | ✅ **改用本机浏览器**：headless Chrome 渲染页面后取 `<video><source>`，不登录、不读用户 profile |

抖音这条改动值得说明：反爬从「缺 cookie」变成了「必须跑 JS」。应对只有两种——自己实现 `a_bogus`/Argus 签名（几百行逆向，几周一坏），或者让真浏览器跑一遍 JS（几秒，稳定）。选了后者，代价是**机器上要有 Chrome 或 Edge**，没有就明确报错并提示可选导入 cookies 走 yt-dlp。

**顺带省掉的依赖**：不需要 `PyMiniRacer` / `quickjs` / Node。JS 由浏览器自己跑，仓库里不存任何逆向出来的 `sign.js`。

---

## 4 选型决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 下载引擎 | yt-dlp（**以子进程 CLI 调用**，不 import） | 一套代码覆盖三家；崩溃不拖垮后端；可 `-U` 自升级（这类工具失效 90% 是 extractor 过期） |
| 视频合并 | ffmpeg，走 `imageio-ffmpeg`（BSD-2 wrapper，pip 带各平台静态二进制） | 用户机器上大概率没有 ffmpeg；pip 装上就有 |
| URL 归一化 | 自写 `platforms.py`（白名单 + 短链解析） | yt-dlp 不认三家短链，这是必须补的一层 |
| 抖音取流 | **headless Chrome 渲染后取 `<video><source>`**（`douyin.py`，约 200 行） | 分享页与 web API 都已封死（403 Argus）；签名方案要逆向且随时失效，浏览器是唯一稳的免登录路径 |
| 访问方式 | **访客优先（默认）**，账号可选 | 见 §3.1：三平台都能免登录；内置共享 cookie 必坏 |
| JS 签名引擎 | 不引入（无 PyMiniRacer / quickjs / Node） | 抖音交给本机 Chrome 跑 JS；少一个重依赖、少一处会失效的逆向代码 |
| 第二引擎 | 不引入 | lux / TikTokDownloader 能做的 yt-dlp 都能做；多一套就是多一处会坏的地方 |
| 落盘位置 | `<workspace>/output/视频下载/<YYYY-MM-DD>/` | 在 workspace 内（`_serve_allowed_roots` 覆盖），产出文件视图与 `/preview` 都能直接播 |

---

## 5 架构

```
 工作台页面(Web/Electron)     对话(Agent 工具)      渠道(飞书/微信)
        │  /api/video/*            │ video_download      │ send 已有能力
        └──────────────┬───────────┴─────────────────────┘
                       ▼
           agent/media/video/            ← 新增，唯一的领域模块
             platforms.py   平台识别 / 短链解析 / 白名单
             douyin.py      抖音专用：headless Chrome 取播放流
             runner.py      yt-dlp 子进程：参数、进度、超时、错误分类
             service.py     probe / download / 状态（并发闸门、落盘）
                       ▼
     yt-dlp CLI  ──  ffmpeg(imageio-ffmpeg)  ──  Chrome headless（仅抖音）
                       ▼
        <workspace>/output/视频下载/<date>/<title> [<id>].mp4
                       ▼
        既有产物链路：index_message_artifacts → /api/artifacts → 视频预览
```

新增代码 7 个文件 + 1 个视图；其余全部复用既有能力（`strict_url_guard`、`safe_get`、artifact 索引、`send` 工具、`/preview`）。

---

## 6 模块契约

### 6.1 `agent/media/video/platforms.py`

```python
PLATFORMS = {                       # 域名 -> 平台
    "douyin": ("douyin.com", "iesdouyin.com"),
    "xhs":    ("xiaohongshu.com",),
    "bilibili": ("bilibili.com", "bilibili.tv"),
}
SHORT_HOSTS = {"v.douyin.com", "xhslink.com", "b23.tv"}   # 只解短链，不下载
ALLOWED = 各平台域名 ∪ SHORT_HOSTS                        # 传给 strict_url_guard
```

- `extract_url(text) -> str | None`：从分享文案里正则抽第一个 http(s) 链接（分享文案里通常只有一个，另有 emoji 与中文标点要剥离）。
- `normalize(url) -> Normalized(platform, canonical_url)`：
  - 短链 → 逐跳取 `Location`（`safe_get(..., allow_redirects=False)`，全程在 `strict_url_guard(ALLOWED)` 内），最多 5 跳；
  - 抖音：抽出 `video/(\d+)` → `https://www.douyin.com/video/<id>`；
  - 小红书：抽出 `explore|discovery/item` 的 id，**保留 `xsec_token` 等 query**；
  - B 站：抽出 `BV[0-9A-Za-z]+` / `av\d+`，需要时补 `?p=`；
  - 不认识的域名 → `unsupported_platform`，绝不把任意 URL 交给 yt-dlp。

### 6.2 `agent/media/video/douyin.py`（浏览器取流）

```python
def browser_path() -> str | None          # Chrome → Edge → Chromium
def is_available() -> bool
def extract(page_url) -> {"url": ..., "title": ...}   # 或抛 DouyinError
```

做法：`<浏览器> --headless=new --user-data-dir=<临时目录> --virtual-time-budget=15000 --dump-dom <url>`，从返回的 DOM 里取 `<video>…<source src="https://v*-web*.douyinvod.com/...">`，`html.unescape` 后即无水印直链。

要点：

- **一次性 profile**：每次调用建 `tempfile.mkdtemp()`，结束删掉。不读用户书签/cookie/登录态，也不会因为用户在浏览器里登着账号而改变行为。
- **CDN 白名单**：解析出的地址必须落在 `douyinvod.com` / `douyin.com` / `byteicdn.com` / `byteamemv` 等宿主上，否则丢弃——页面内容不被当成可信输入。
- **错误分档**：没有浏览器 → `no_browser`；DOM 里没有 `<video>` 且有验证/登录痕迹 → `needs_login`；否则 `not_found`。
- **代价**：单条 15–20 秒（页面渲染占大头），需要本机有 Chrome/Edge。这是当前唯一稳定的免登录路径（§3.1）。

---

### 6.3 `agent/media/video/runner.py`

`_ytdlp_cmd()` 依次探测，全走同一个 CLI，实现零分叉：

1. `shutil.which("yt-dlp")`
2. `sys.executable -m yt_dlp`（`importlib.util.find_spec` 成功即可；pip 装的最常见）
3. `<workspace>/bin/yt-dlp[.exe]`（桌面端可放独立二进制，规避下面 §10 的 Python 版本问题）

**下载参数（安全基线，直接照抄）**

```
--ignore-config                     # 不读用户的 ~/.config/yt-dlp/config，防注入 --exec
--no-playlist --playlist-items 1    # 合集/分P 默认只取当前条目
--no-colors --newline
--progress-template
    download:VDL|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s
--print after_move:filepath         # stdout 拿到最终路径（ffmpeg 合并后）
-P home:<out_dir> -P temp:<workspace>/tmp/video
-o "%(title).60B [%(id)s].%(ext)s"
--max-filesize 1G --socket-timeout 20 --retries 3 --fragment-retries 3
--merge-output-format mp4
-f "bv*+ba/b"                       # 抖音改 "play_addr/bv*+ba/b"，确保取无水印直出
--progress                          # --print 会顺带关掉进度，必须显式打开
-f "bv*+ba/b" -S "res:1080"         # 见下：按短边排序，竖屏 1080x1920 不会被 height 过滤掉
```

- **不用** `--exec` / `--external-downloader` / 用户自定义 `-o`，不让模型碰这些旋钮。
- **清晰度用 `-S res:N` 而不是 `[height<=N]`**：竖屏视频是 1080x1920，按 height 过滤会把它降到 480x852。`res` 比的是短边，和用户说的「720P」一致（实测 1080/720/480 分别拿到 1080x1920 / 720x1280 / 480x852）。
- **stdout 与 stderr 合并读**：带 `--print` 时 yt-dlp 把进度打到 stdout、错误打到 stderr，分开读必然丢一半。进度行以 `VDL|` 开头，其余行里 `*.mp4` 结尾的是产物路径、第一个非 `[` 开头的是标题。
- **整次重试一次**：`--retries` 只管分片，不管整个 CDN 掉线（实测 B 站 CDN 偶发 `connect timed out` 后 yt-dlp 只打一行空 `ERROR:` 就退出）。`network` / `unknown` / `timeout` 再跑一遍。
- **临时目录在 `tmp/video/`**，不在输出目录里：半成品永远不该被产物索引看到。
- 超时：整体墙钟上限（默认 900s），到点 `terminate()` → `kill()`。
- `--progress-template` 的 stderr 解析是唯一耦合点，yt-dlp 升大版本时需要回归（写进 §12）。

**错误分类**（把 yt-dlp 的字符串翻成 UI 能给出建议的枚举）

| 现象 / yt-dlp 输出片段 | 归因 | 给用户的话 |
|---|---|---|
| `Fresh cookies ... are needed` / 登录墙 | `needs_login` | 「这条需要登录才能看，可导入一次账号（可选）」——**兜底路径，不是主路径** |
| `Unsupported URL` / 提取器报 `No video formats` | `unsupported_url` | 「这个链接不是可下载的视频页（图文/直播/专栏）」 |
| `private` / `404` / `笔记不存在` / `已删除` | `not_found` | 「作品已删除或仅作者可见」 |
| `Sign in to confirm` / `area` / `地区` | `region` | 「该内容有地区或登录限制」 |
| `Requested format is not available` | `quality` | 「该清晰度需要登录/大会员」 |
| `ffmpeg not found` / merge 失败 | `dep` | 「缺少 ffmpeg 组件」 |

**抖音为什么绕过 yt-dlp**

`DouyinIE` 打的是需要 Argus/`a_bogus` 签名的 `aweme/v1/web/aweme/detail`，实测返回 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`，配了 `ttwid` 也一样。所以抖音走 `douyin.py`（§6.2）的浏览器路径，再由 `service._fetch_direct` 直接流式下载那个 CDN 地址；`runner` 只服务小红书和 B 站。

这条分支的维护成本要盯住两点（写进 §12）：`<video><source>` 的选择器，和 CDN 宿主白名单。

### 6.4 `agent/media/video/service.py`

```python
def status() -> dict                  # {ytdlp, version, ffmpeg, browser, platforms}
def available() -> bool               # 工具的 is_available() 直接用它
def probe(text) -> dict               # {platform,label,id,url,title,uploader,duration,height,size,via}
def download(text, quality="best", max_mb=1024, on_event=None, source=None, title=None) -> dict
```

- 全局 **单并发**：拿不到锁直接返回 `busy`，不排队（排队要解释「位次 3」这种状态，不值）。
- 磁盘保护：开始前查可用空间，不足 1×上限就拒绝，而不是下到一半失败。
- **`source`/`title` 可透传**：页面先 `probe` 再点下载时，抖音不必再开一次浏览器。
- 抖音走自己的 `_fetch_direct`（已解析的 CDN 直链，边下边报百分比），小红书/B 站走 `runner.download`。
- 落盘：`<state_root>/output/视频下载/<YYYY-MM-DD>/`，重名加 `(2)`。

### 6.5 Agent 工具 `agent/tools/video_download/`

```json
{
  "name": "video_download",
  "description": "把抖音/小红书/B站的视频链接（或分享文案）去水印下载到本地工作台。用户贴分享文案时直接用，不要自己解析链接。",
  "params": {
    "type": "object",
    "properties": {
      "url":   {"type": "string", "description": "视频链接或整段分享文案"},
      "quality": {"type": "string", "enum": ["best", "1080", "720", "480"], "default": "best"},
      "audio_only": {"type": "boolean", "default": false}
    },
    "required": ["url"]
  }
}
```

`execute()` 返回 `ToolResult.success(json)`，其中必带 `path`（绝对路径）。

产出文件索引：`agent/protocol/artifact.py` 的采集是按工具名白名单走的（`write` / `edit` / `send` / `bash` / `subagent`），所以这里**加了一个 `video_download` 分支**（读结果 JSON 的 `path`），否则下载完的视频不会出现在「产出文件」里。已有单测 `test_a_downloaded_video_is_an_artifact` 守住这条。失败返回 `ToolResult.fail` 并带上 §6.3 的归因文案。

`is_available()`：`runner.status()["ytdlp"]` 为真，否则工具在提示词里消失（避免模型调用一个必然失败的工具）。

### 6.6 HTTP 接口 `channel/web/api/video.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/video/status` | 引擎版本、ffmpeg、**本机浏览器**、访问方式（访客/账号）；供页头状态药丸与侧栏「访问方式」用 |
| GET | `/api/video/probe?url=` | 解析元信息：平台、标题、作者、时长、封面、预估大小 |
| GET | `/api/video/download?url=&quality=` | **SSE 流**，逐条推 `{"stage","percent","speed","eta","path","error"}` |
| POST | `/api/video/cancel` | 让正在跑的下载在下一个分片处停下（只关 EventSource 不会停下载） |
| GET | `/api/video/recent` | 输出目录里最近 12 个视频（含在本页出现之前下载的） |
| POST | `/api/video/delete` | 删一个视频，只允许 `output/视频下载/` 之下 |
| POST | `/api/video/login/start` | B 站返回 `{qr, key}`；小红书/抖音打开登录窗口返回 `{method:"browser"}` |
| GET | `/api/video/login/poll` | `waiting` / `scanned`（仅 B 站）/ `expired` / `ok`；`ok` 时 cookie 已落盘 |
| POST | `/api/video/login/close` | 关掉登录窗口（浏览器方式） |
| POST | `/api/video/logout` | 删掉某平台（或不传平台则全部）的 cookies |

访问方式（`guest` / `account`）存本机 `config.json` 的 `tools.video_download.access`，默认 `guest`；切换只影响后续请求，已下载的东西不回溯。

下载用 SSE 而不是同步 POST：一次 4K 下载可能几分钟，同步会撞前端/代理超时；SSE 与既有 `/api/logs` 的写法一致（`web.header('Content-Type','text/event-stream')` + `yield`），不需要任务队列。URL 走 query 参数即可（分享链接远小于 8KB）。

### 6.7 视图

原型：`docs/plans/video-download-ui.html`（单文件，双击打开；右下角评审条或键盘 1–6 切状态；`#ready.dark` 这类深链可直接落到某个状态）。

**设计目标**：去掉「一叠等重白卡 + 表单」的 CRUD 感，改成**一个主舞台 + 一个信息侧栏**。视觉仍用工作台 clay token（奶油底、ZCOOL 标题、暖灰发丝线），但三处升级：

1. **主操作改成深绿实心** `#2C6B4F`（白字 5.9:1）。上一版的淡绿按钮在奶油底上不够「可点」，是最主要的廉价感来源。
2. **层级靠排版而不是边框**：页头直接坐在画布上（不再是一张卡），后面用一条发丝线收口；卡内用 10px 大写字距的 micro-label 分组，正文全是 800 字重的小字号。
3. **三段式布局**：页头 / `主舞台 + 侧栏` / 最近下载。左列 = 舞台 + 最近下载，右列 = 访问方式 + 平台支持 + 免责小字，两列高度接近，不会出现一列空到底。

| 区块 | 内容 | 交互 |
|---|---|---|
| 页头 | ZCOOL 大标题（30–40px）+ 一句话说明 + 右侧状态药丸（`访客模式 · 免登录` / `引擎 2026.10.26`） | 引擎药丸点击显示版本与升级提示 |
| 舞台 · 空态 | 虚线 drop 区：micro-label「链接 / 分享文案」+ 无边框 textarea + 平台标 + 底行「Ctrl/⌘ V · Ctrl/⌘ ↵ · 可拖入」+ 从剪贴板粘贴 / 解析 | 聚焦时边框转主色并带 4px 光晕；拖拽时实线高亮；无输入时解析按钮 disabled；⌘↵ 直接解析 |
| 舞台 · 解析中 | 骨架：封面块 + 3 条灰条 + 底部「正在解析链接」 | 0.85s，不跳版式 |
| 舞台 · 解析完成 | 封面（下拉拉伸填满信息列，右下角时长）+ eyebrow（平台 · 日期）+ 标题 + 作者/播放量 + `分辨率/大小/编码/水印` 四列 specs + 清晰度分段器 + 深绿主按钮 | 分段器是按钮组不是 `<select>`（少一次点击）；换清晰度即时更新按钮上的预估大小 |
| 舞台 · 下载中 | 小封面（保持同一个对象的连续感）+ eyebrow（平台 · 清晰度 · 原片直出 · 无水印）+ 标题 + 右侧 30px 百分比 + 10px 进度条（细斜纹)+ `已下载/速度/剩余` 三列 + 取消 | 进度条不回到上一屏；完成自动切「完成」；可取消并回到解析完成态 |
| 舞台 · 完成 | 16:9 播放器（深色、内嵌控制条、清晰度角标）+ `MP4` chip + 文件名（等宽、截断）+ `48.2 MB · 1080P · 无水印` + 打开文件夹 / 复制标题 / 再下一个 | 「再下一个」清空输入回到空态并聚焦，支持连续下载 |
| 舞台 · 失败 | 38px 警示图标 + 人话标题 + 一句处置建议 + `导入账号 cookies`(主) / 换一条 / 重试 + 折叠的引擎原始输出 | 只在**确实**需要登录时才出现账号路径，不是默认路径 |
| 侧栏 · 访问方式 | `访客 / 账号` 分段器，默认访客；下面一块主色浅底的说明「免登录，小红书/B站直接抓，抖音用本机浏览器渲染一次」 | 切到账号时文案换成「只存本机，不经过服务器」，并出现导入入口 |
| 侧栏 · 平台支持 | 4 行表：抖音无水印原片（需本机浏览器）`免登录`、小红书视频笔记 `免登录`、B 站 ≤720P `免登录`、B 站 1080P+/会员 `需账号` | 直接把「要不要登录」讲清楚，替代文档和客服 |
| 最近下载 | 3 列横向卡片：16:9 缩略图 + 时长、标题单行、平台 · 清晰度 · 大小 · 时间；hover 出现删除 | 点击播放；删除后若为空显示虚线空框 |

**交互与展示上的取舍**：

- 失败态**不显示 yt-dlp 英文原文**，只给归因与下一步，原文折叠进 `<details>`——老师看不懂 `Fresh cookies are needed`，但排查时要能看到。
- 不做任务队列：单并发 + 一条舞台，不会出现「排队中 / 位次 3」这种要额外解释的状态。
- 平台标用低饱和底 + 深字（抖音粉 / 小红书橘 / B 站蓝），**不引平台 logo**（商标与素材问题）。
- 所有操作 42px 高；数字全部 `tabular-nums`，进度与大小不会左右跳。
- 深色下选中项改用 `--surface-3`（比轨道更亮），否则「已选中」读不出来。
- 尊重 `prefers-reduced-motion`：进度条纹与骨架动画自动关闭。

**落地映射**：token 与组件名（`.card` / `.btn` / `.seg` / `.meter` / `.tile`）落到 `channel/web/static/css/video.css`，视图模板 `channel/web/templates/views/video.html`，逻辑 `static/js/views/video.js`；Electron 端同一套结构与 token，页面移植一份（P3）。

### 6.8 账号导入（可选，不是主路径）

三个平台都能免登录跑通，这一节只服务「平台自己说不」的场景：B 站 4K/大会员、登录墙笔记、抖音偶发验证。两种机制，按平台能力选：

| 平台 | 机制 | 为什么 |
|---|---|---|
| B 站 | **官方扫码登录 API**：`passport.bilibili.com/x/passport-login/web/qrcode/generate` → `qrcode` 库出 PNG data URL → 轮询 `poll`，`data.code` 0/86101/86090/86038 映射成 `ok/waiting/scanned/expired` | 有公开接口，不碰浏览器，90 秒搞定 |
| 小红书 / 抖音 | **开一个登录窗口**：`<chrome> --user-data-dir=<state_root>/browser-profile/<平台> --remote-debugging-port=0 <登录页>`，用户在里面扫码；`Storage.getCookies`（CDP）读出 cookie，检测到会话 cookie 就落盘并关窗口 | 没有公开扫码接口；读 CDP 而不是 Chrome 的 cookie 数据库，所以不碰系统钥匙串 |

落盘仍是 `credentials.py` 那一个 `cookies.txt`：

- Netscape 格式，600 权限，按平台合并（登录 B 站不会冲掉小红书的）。
- 没有值、域不在白名单里的 cookie 直接丢弃——空的 `SESSDATA` 会让所有下游判断都以为「已登录」。
- `ytdlp_cookie_args()` 只在文件里真有 cookie 时才返回 `--cookies`。
- 抖音在**有账号**时优先走 yt-dlp（约 2 秒，比浏览器快 10 倍），失败自动退回浏览器。

**不做**：保存密码、模拟登录、绕验证码。用户扫码是唯一入口。

---

## 7 前置改造（已落地）

`channel/web/api/files.py` 的 `PreviewHandler` / `FileServeHandler` 目前是 **`open(f).read()` 一次性读完 + 无 Range**：

- 300MB 的 mp4 会整块进内存；
- Safari 必须拿到 `206 Partial Content` 才播；Chrome 至少要 Range 才能拖动进度。

已实现（`channel/web/api/files.py` 的 `_ranged_body` / `_parse_range` / `_stream_file`）：

- `bytes=a-b`、`bytes=a-`、`bytes=-N` 三种写法；越界回 `416` + `Content-Range: bytes */size`；多段请求退回整文件。
- 超过 8MB 的文件走分块 `yield`，不再整个读进内存。
- `/api/file` 与 `/preview` 都走这条路径；HTML 预览仍然注入 chrome，不受影响。
- 证据：页面里的 `<video>` 在未下载完的状态下就能显示时长 `0:00 / 2:47`，说明 206 生效。

---

## 8 安全与合规

### 8.1 技术侧

| 风险 | 处置 |
|---|---|
| SSRF（模型或用户给内网 URL） | 解析阶段全程 `strict_url_guard(ALLOWED)` + `safe_get` 逐跳校验；非白名单直接拒，**不把任意 URL 交给 yt-dlp** |
| 任意 URL 下载 | 同上；yt-dlp 只接收归一化后的规范链接 |
| 配置注入 | `--ignore-config`；不接受模型传入的 `-o`/`--exec`/`--downloader` |
| 磁盘打满 | 默认 1GB 单文件上限、墙钟 900s、单并发、可用空间预检 |
| 文件名穿越 | `%(title).60B` + 固定输出目录，不接受相对路径 |
| 凭证泄露 | 访客模式不产生任何凭证文件。可选账号 cookies 落在 `<state_root>/credentials/cookies.txt`，600，不进日志、不进工具返回值 |
| 浏览器被读走登录态 | `douyin.py` 每次用 `tempfile.mkdtemp()` 建一次性 profile，结束删除，不碰用户真实 profile |
| 声音/版权素材外泄 | 不自动分享到公开渠道，只能用户手动 `send` |

### 8.2 法务与产品文案（**必须在 UI 出现**）

- 「去水印」= 使用平台公开的无水印播放流，**不做**对已带水印画面的图像修补。
- 抖音/小红书的用户协议对「去除标识后下载/传播」有限制，B 站无水印问题。**风险由部署方（学校/教师本人）承担**，所以：
  - 首次使用弹一次说明，勾选「仅用于个人学习与备课，不二次发布」；
  - 下载完成的卡片上固定一行小字提示；
  - 不提供「批量搬运」「一键发到公开平台」这类功能。

---

## 9 依赖与打包

`requirements.txt` 已加（实测在 Python 3.10.10 上跑通）：

```
# video_download: 抖音/小红书/B站取流引擎（子进程调用，兼容 3.10+）
yt-dlp>=2026.10.21
# video_download: B站 DASH 音视频合并与 mp4 封装，pip 自带各平台静态二进制
imageio-ffmpeg>=0.6.0
```

关于 Python 版本：yt-dlp **主线**（master 的 `pyproject.toml`）已经写 `requires-python = ">=3.11"`，但 2026.10.21 这个 release 在 3.10 上照常工作（只打一行 deprecation 提示）。所以：

| 形态 | 走法 |
|---|---|
| 源码部署，Python ≥3.11 | 直接 pip，无需特殊处理 |
| 源码部署，Python 3.10 | 钉 `yt-dlp>=2026.10.21`，可用；升级到不再支持 3.10 的版本时，`find_command()` 会返回 None，工具自动从提示词里消失（不会报错给用户看） |
| 桌面客户端（Electron） | 首次启动把 yt-dlp 独立二进制下到 `<state_root>/bin/`，`find_command()` 第 3 档命中，彻底绕开 Python 版本 |

**ffmpeg 为什么必须用 pip 那份**：本机 `/usr/local/bin/ffmpeg` 是坏的（`dyld: Library not loaded: libunistring.2.dylib`），但它在 PATH 上。`imageio-ffmpeg` 的静态二进制是唯一确定能跑的那个，所以 `ffmpeg_location()` 优先它、并通过 `--ffmpeg-location` 明确告诉 yt-dlp。这条不是洁癖，是本机踩到的事实。

**打包分发（别人装上就能用）** 需要三件事，缺一样就变成「装好了但用不了」：

| 位置 | 改了什么 | 不做会怎样 |
|---|---|---|
| `requirements.txt` | 已含 `yt-dlp` / `imageio-ffmpeg` | 源码安装跑 `run.sh` 才有；**已有用户升级后**不会自动装 → 由运行时自愈兜底 |
| `desktop/build/requirements-desktop.txt` | 同上两个包 | 桌面安装包的后端是 PyInstaller 冻结包，里面没有它们 |
| `desktop/build/cowagent-backend.spec` | `collect_submodules('yt_dlp')` + `collect_data_files('imageio_ffmpeg')` | yt-dlp 的 extractor 是动态导入的，不收就只剩「Unsupported URL」；ffmpeg 二进制是包内数据文件，不收就合并不了 B 站 DASH |
| `runner._is_frozen()` | 冻结包里**不再尝试 pip**，直接报「打包版应内置」 | 冻结包里没有 pip，自愈会打一条注定失败的日志 |
| `desktop/build/check-bundle.py` + `release.yml` | 打包后断言包里有 yt-dlp 的 extractor 和 ffmpeg 二进制，缺了就让构建失败 | 这正是 Windows 用户收到的「缺少 ffmpeg」：包能启动、页面能开，只有粘贴链接时才炸 |
| `app.py --ytdlp` | 冻结包里用自身二进制转跑 yt-dlp（`<backend> --ytdlp …`） | 包里没有解释器，`python -m yt_dlp` 会把后端自己再拉起一次 |
| `ffmpeg_location()` 四级查找 | imageio-ffmpeg → `_MEIPASS`/exe 同级 → `<state>/bin` → PATH | 只认 imageio-ffmpeg 时，任何一个打包疏漏都直接表现为「缺少 ffmpeg」 |

源码安装的两种情况都覆盖了：`run.sh` 的 `install_dependencies` 会装 requirements；**已有用户只 `run.sh start` 时不会重装**，所以第一次打开视频页时后端自己 `pip install`（实测 5 秒完成）。

**刻意不加的依赖**（写下来是为了以后有人想加时先看一眼）：

- **不加 JS 引擎**（`PyMiniRacer` / `quickjs` / Node）：抖音的 JS 交给本机 Chrome 跑（§6.2），不需要我们执行签名脚本。
- **不加浏览器内核**（Playwright / Selenium）：只驱动**系统已装的** Chrome/Edge，不下载 300MB 的 Chromium。仓库里已有 Playwright 的 `browser` 工具，那条路留给需要交互的浏览任务。

可选增强（不阻塞）：`curl_cffi` → `--impersonate chrome`，对小红书的 TLS 指纹风控有实际帮助；装不上就退化成默认 UA。

---

## 10 实施阶段与验收

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 实测** | 三条真实链接打通取流链路，确认「是否需要登录」 | ✅ §14 |
| **P1 核心 + 工具** | `agent/media/video/{platforms,runner,douyin,service}.py`、`video_download` 工具、依赖、单测（46 条） | ✅ §14.1 |
| **P2 Web 视图** | `/api/video/*`（含 SSE 与 cancel）、`video` 视图（模板/CSS/JS + i18n + 菜单 + 路由）、`files.py` 的 206 Range | ✅ §14.4 |
| **P3 桌面端** | `pages/VideoPage.tsx`、路由 `/video`、菜单项、i18n、client 方法；`npm run build` + `tsc --noEmit` 通过 | ✅ §14.5 |
| **P4 账号导入** | B 站扫码（官方 API）+ 小红书/抖音登录窗口（CDP 取 cookie），`credentials.py` 统一落盘 | ✅ §6.8 |
| **P5 开箱可用** | 缺引擎时后端自己 `pip install` + 页面显示「正在安装」；打包依赖与 PyInstaller 收集；冻结包不做无意义 pip | ✅ §9（打包验证待一次真实构建） |
| P6（可选） | 视频 → 转写 → 「优质课亮点提取」（原工作台方案里的待定项） | 另评 |

**测试清单（全离线，165 条相关用例）**

| 文件 | 覆盖 |
|---|---|
| `tests/test_video_platforms.py` | 分享文案抽链、尾部标点、三种短链、`xsec_token` 原样保留、`b23.tv/BV…` 免网络直达、白名单拒绝、非视频页归因 |
| `tests/test_video_runner.py` | 进度行解析、百分比缺失时按字节算、7 种失败归因、`_unique_path`、临时目录取产物、probe 摘要取最高流 |
| `tests/test_video_douyin.py` | `<video><source>` 解析、`blob:` 跳过、CDN 白名单、`play_addr` 兜底、标题去后缀、没浏览器时给 `no_browser` |
| `tests/test_video_service.py` | 体积上限、文件名清洗、重名 `(2)`、锁被占报 `busy`、非白名单链接联网前就拒绝、取消标志 |
| `tests/test_video_tool.py` | schema、空输入、错误透传、成功返回绝对路径、`is_available()` |
| `tests/test_web_video_api.py` | status/probe/download(SSE 帧序列)/recent/delete/cancel/login 全套 + 路由表 |
| `tests/test_web_file_range.py` | 206、开区间、后缀区间、416、多段退回、大文件分块 |
| `tests/test_artifact_index.py::test_a_downloaded_video_is_an_artifact` | 下载结果进产出文件索引（`kind=video`） |

真实网络用例不进 CI（会随平台变红），放在 §14 的手工验收里。

---

## 11 风险与降级

| 风险 | 概率 | 影响 | 降级 |
|---|---|---|---|
| 抖音页面结构/播放器改版 | 中 | 抖音短期不可用 | `douyin.py` 只依赖「DOM 里有 `<video><source>`」这一件事，改版后通常只需换正则；实在不行退到「导入 cookies + yt-dlp」 |
| 机器上没有 Chrome/Edge | 中 | 抖音不可用 | 明确返回 `no_browser` 并提示装浏览器或导入 cookies；小红书/B站不受影响 |
| 抖音画质只有播放器给的那一档 | 确定 | 画质不是平台最高 | 实测这条是 1440x1080 / `br=780`；页面文案不承诺「最高画质」，只在完成后显示实际分辨率 |
| 小红书登录墙 / 验证码 | 中 | 少数笔记失败 | 如实报错 + 可选导入账号；不改 `xsec_token`、不绕过验证 |
| B 站 1080P+ 需账号 | 确定 | 高清受限 | 页面标 `需账号`，默认 720P；这是账号权益，不做绕过 |
| CDN 偶发断连 | 高 | 单次失败 | yt-dlp 内层 `--retries 3` + 外层整次重试一次（实测 B 站 CDN 会 `connect timed out`） |
| yt-dlp 版本老化 | 高（必然发生） | 某平台突然全挂 | `/api/video/status` 显示版本；失败信息带「先升级引擎」；升级后跑一次 §14 的手工验收 |
| Python ≥3.11 门槛 | 中 | 装不上 yt-dlp | `find_command()` 返回 None → 工具自动消失，不报错；桌面端用独立二进制 |
| 大文件 + 慢网 | 中 | 体验差 | 体积上限 + 磁盘预检 + 进度/速度/ETA + 取消 |

---

## 12 已知需要盯的耦合点

1. `--progress-template` 的字段名与「进度写 stdout」这一行为（yt-dlp 偶有调整）——升级后跑 `tests/test_video_runner.py` + 一条真实下载。
   同理 **标题走 `VDT|` 标记**：stdout/stderr 合并之后，yt-dlp 的告警（如 Python 3.10 弃用提示）会成为第一个非进度行，靠「第一个不像日志的行」猜标题会把告警当标题（实测踩过）。
2. `XiaoHongShuIE._VALID_URL` 与短链归一化正则（小红书改路由时一起改）。
3. `douyin.py` 的单条正则：`<video ...><source src="...">`，以及 CDN 宿主白名单（`douyinvod.com` 家族会变，实测已见过 `v26-web` / `v26-webf` / `v11-weba`）。
4. `-S res:N` 的语义（短边）。若哪天改成按 `height` 过滤，竖屏视频会静默降到 480x852。
5. `PREVIEWABLE_KINDS` 已含 `video`，产出文件视图不用改；但 P2 的 `files.py` Range 支持是自建的，别在重构里丢。

---

## 13 与工作台其他功能的衔接

- **产出文件**：下载的 mp4 自动进索引，无需改动（`agent/protocol/artifact.py` 已把 `video` 列为可预览类型）。
- **任务看板**：可以后续从「下载的视频」一键建任务（如「看完并写教研笔记」），本期不做。
- **优质课/教研**：教师工作台方案里「优质课视频亮点提取」原本标为待定；视频下载落地后，剩下的是转写 + 摘要，既有 ASR 接口可直接复用，成本从「极高」降到「一个 Skill」。

---

## 14 实测记录（2026-11-22，本机 macOS / Python 3.10.10 / yt-dlp 2026.10.21）

### 14.1 用户给定的三条链接

| # | 输入（原样粘贴） | 解析结果 | 耗时 | 产物 | 水印 |
|---|---|---|---|---|---|
| 1 | `在月球建座基地｜九上英语 … https://xhslink.cn/o/7pn3092utJ7 内容复制后，前往【小红书】直接打开笔记。` | 小红书 `6b0142e8000000001802a072`，短链跳转到 `discovery/item/…?xsec_token=CB--…%3D` | 3.1s | `在月球建座基地｜九上英语 […].mp4` · 14.4 MB · 02:47 · h264 1280x720 + aac | 无（抽帧确认） |
| 2 | `7.69 复制打开抖音，看看【线条不上班的作品】… https://v.douyin.com/FpfkdDQJ0iQ/ 01/24 :2pm A@g.BT nqr:/` | 抖音 `7710212552923303202`（短链 302 → `www.douyin.com/video/…`） | 17.5s | `没文化嘴硬挽尊的我： […].mp4` · 2.6 MB · 00:27 · h264 1440x1080 + aac | 无（抽帧确认） |
| 3 | 同 #2（重复粘贴） | 同上 | 15.6s | 同上，自动加 ` (2)` 不覆盖 | — |

补充：B 站（`BV1bGysz7EoD`）在同一次验收里也跑通：`quality=best` → 1080x1920 5.4 MB、`720` → 720x1280 3.4 MB、`480` → 480x852 2.5 MB，均为 av1/h264 + aac 的已合并 mp4。

### 14.2 两条被否掉的抖音方案（留档，别再试）

| 尝试 | 结果 |
|---|---|
| 分享页 `iesdouyin.com/share/video/<id>/` 带移动 UA | 200，页面有 `_ROUTER_DATA`，但 `videoInfoRes` 是空的；正文是「抱歉出错了 请尝试在抖音内观看」 |
| 分享页按桌面 UA 跟随跳转 | 落到 `www.douyin.com/video/<id>`，返回 `_$jsvmprt` 混淆挑战页，无视频数据 |
| `aweme/v1/web/aweme/detail/?aweme_id=…` + 现场注册的 `ttwid` | `403 Blocked by ArgusSecurityPlugin Uifid Not Found` |
| `iesdouyin.com/web/api/v2/aweme/iteminfo/` | 200，空 body（已下线） |
| 改动 CDN 地址里的 `br=780` 为 1500/2000/3000 | 返回的文件字节数与分辨率都不变（CDN 只给一档） |
| 用 headless Chrome `--dump-dom` | ✅ DOM 里出现 `<video><source src="https://v*-web*.douyinvod.com/…">`，`html.unescape` 后可直接下载 |
| 用 `--cookies-from-browser` 碰运气 | 本机 Chrome/Edge 没有任何抖音 cookie，不可行 |

### 14.3 验收命令

```bash
# 单测（48 条，全离线）
.venv/bin/python -m pytest tests/test_video_*.py -q
# 真实链接（不联网时跳过这一步）
.venv/bin/python -c "
from agent.media.video import service
service.download('https://xhslink.cn/o/7pn3092utJ7')
service.download('https://v.douyin.com/FpfkdDQJ0iQ/')
service.download('https://www.bilibili.com/video/BV1bGysz7EoD', quality='720')
"
```

产物落在 `<state_root>/output/视频下载/<date>/`，文件名保留标题与平台 id，重名自动 `(2)`。

### 14.4 Web 视图走查（真浏览器，CDP 驱动）

用 headless Chrome 连 CDP 点真按钮，不是截图假状态：

| 步骤 | 结果 |
|---|---|
| 打开 `/video` | 侧栏出现「视频下载」（教学组），面包屑 教学 › 视频下载，页头药丸 `yt-dlp 2026.10.21 · ffmpeg ✓` |
| 粘贴小红书分享文案 → 点解析 | 0.9s 后 `data-stage="ready"`，标题/`1280 × 720`/`14.4 MB`/`02:47`/水印=无 |
| 点下载 | SSE 逐条推 `probe` → `download`(0→100%) → `done`；进度条、速度、剩余正常 |
| 完成后 | `<video>` 立即显示 `0:00 / 2:47`（206 生效），文件名、`打开文件夹/复制标题/再下一个` 可用，最近下载刷新 |
| 点 B 站「登录」 | 弹出浮层，二维码来自 passport API（`data:image/png`），状态「等待扫码…」，轮询推进 |
| 点「取消」 | 后端 `POST /api/video/cancel` 让下载在下一个分片停下（不是只关进度条） |

### 14.5 桌面端

`desktop/` 新增 `pages/VideoPage.tsx`（同构页面，573 行）、`/video` 路由、菜单内置项、zh/en 文案、`apiClient` 的 10 个方法（SSE 走 `withToken` 把令牌放 query）。

- `npm run build` ✅（renderer + main）
- `npx tsc -p tsconfig.json --noEmit` ✅ 我的文件零报错（仓库里另有 11 条既有报错：`i18n.ts` 的 `tw_an_trend` 重复键 2 条、`ChannelsPage.tsx` 的 lucide 类型 9 条，均为 HEAD 上已存在）

### 14.6 没有验证到的

- **扫码那一步**：二维码能生成、轮询能跑，但没有真人扫码，所以「登录成功 → cookie 落盘 → 播放高清」这条链路只验证到机械部分（用注入 cookie 的单测覆盖了落盘与 `--cookies` 参数）。
- 抖音**有账号**时的 yt-dlp 快路径：本机没有抖音 cookie，未实测；代码路径是在 `_download_douyin` 里先试 yt-dlp、失败退回浏览器。
- 桌面端只做了构建与类型检查，没有真的启动 Electron 窗口点一遍（需要图形会话，且会占用用户桌面）。
- **桌面安装包没有重新打包**（`bash desktop/build/build-backend.sh` 要从零装一遍 `requirements-desktop.txt`，约十分钟）。打包相关的三处改动（requirements-desktop、PyInstaller spec、冻结包里的 pip 保护）是按现有 spec 的同一套写法加的，但「装完在别人机器上跑通」这一步仍待一次真实打包验证。
