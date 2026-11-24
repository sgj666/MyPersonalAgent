---
name: listening-segmenter
description: 把一段英语听力音频（mp3/m4a/wav）转成可点播的「逐句精听」网页 —— ASR 转写、按句切割音频、生成莫兰迪风格 HTML（含说话人头像、选中高亮、翻页笔控制、句间停顿、字号调节）。Use when the teacher provides a listening audio file and asks to 逐句精听/听力原文/按句切分音频/做成可点播网页/听写材料, or wants an audio turned into sentence-by-sentence HTML for classroom projection.
metadata:
  requires:
    bins: ["python3"]
    env: ["DASHSCOPE_API_KEY"]
---

# 逐句精听 HTML 生成器

把英语听力音频变成课堂上可逐句点播的网页。全流程纯 Python，**不依赖 ffmpeg**（本机 ffmpeg 常因 libunistring ABI 问题卡死）。

## 工作流程

### Step 1 — 确认参数

向老师确认三件事（能推断的就别问）：

1. **音频文件路径**
2. **教材/单元**（用于查说话人姓名，见 Step 3）
3. **标题**（如 `Unit 6 Beyond Earth · 逐句精听`）

### Step 2 — ASR 转写

```bash
python3 <base_dir>/scripts/asr_transcribe.py <音频路径> <outdir>/asr.json
```

输出 `{"duration":87, "sentences":[{begin,end,text}], "words":[...]}`（时间单位毫秒）。

**模型**：默认 `qwen-audio-3.0-asr-flash`。账号实际可用模型名可能不同，先查：

```bash
curl -s -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  https://dashscope.aliyuncs.com/compatible-mode/v1/models | grep -o '"id":"[^"]*asr[^"]*"'
```

用 `--model <名称>` 覆盖。

### Step 3 — 查真实说话人姓名（关键！）

**不要凭音频内容猜测说话人。** 教材听力脚本里通常有明确的人名。查知识库：

```bash
grep -n "Listening Scripts\|<单元关键词>" knowledge/教材/英语九年级上册.md
```

教材原文格式是这样的，直接对照：

```
Section A, 2b and 2c  Ms Wang: All right. So, we've done some experiments...
Anna: Hi, Ms Wang! I want to know how it feels to be weightless.
Ms Wang: Oh, it's so much fun!...
```

建立 `speakers.json`，把每句 idx 映射到说话人：

```json
{
 "1":  {"kind":"narr",    "name":"导语",    "ch":"♪"},
 "4":  {"kind":"stu1",    "name":"Anna",    "ch":"A"},
 "9":  {"kind":"stu2",    "name":"Mike",    "ch":"M"},
 "12": {"kind":"stu3",    "name":"Julie",   "ch":"J"},
 "16": {"kind":"stu4",    "name":"David",   "ch":"D"},
 "19": {"kind":"stu5",    "name":"Li Hua",  "ch":"L"},
 "2":  {"kind":"teacher", "name":"Ms Wang", "ch":"王"}
}
```

**`kind` 必须用内置的 7 种之一**：`narr`（导语/旁白）、`teacher`、`stu1`~`stu5`。
超过 5 个学生时，在 `build_html.py` 的 `KIND_STYLE` 里加 `stu6` 等。

**⚠️ 拼音要点**：`ch` 用说话人首字母（中文明用首字），头像里显示这个字符。

### Step 4 — 切割音频

```bash
python3 <base_dir>/scripts/mp3_cut.py cut <音频> <outdir>/asr.json <outdir>
```

产出 `<outdir>/seg_01.mp3` … 和 `<outdir>/segments.json`。
切割是**帧级精确**（MPEG1 每帧 26.12ms），句首留 120ms、句尾留 150ms 缓冲。

先看总时长确认解析正确：

```bash
python3 <base_dir>/scripts/mp3_cut.py info <音频>
```

若报「无法解析 MP3 帧」：可能是 VBR 或 MPEG2，需转码（此时才需要 ffmpeg，先试 `brew reinstall libunistring`）。

### Step 5 — 补中文翻译

`segments.json` 每条可加 `"zh"` 字段。翻译按句意润色，保持口语化。不填则中文行留空。

### Step 6 — 生成 HTML

```bash
python3 <base_dir>/scripts/build_html.py \
  <outdir>/segments.json <outdir>/speakers.json <outdir>/精听.html \
  --title "Unit 6 Beyond Earth · 逐句精听" \
  --topic "话题：太空站里的生活" \
  --tags "Section A · 2c,23 句,87 秒"
```

**前提**：`seg_*.mp3` 必须放在 HTML 同级的 `segments/` 目录里。

```bash
mkdir -p <outdir>/segments && mv <outdir>/seg_*.mp3 <outdir>/segments/
```

### Step 7 — 验证

**7.1 反向校验（必做，不可跳过）**

把切好的每段音频**再送回 ASR 转写一次**，和页面文本逐句比对。
这是唯一能发现「音频里有、文本里没有」这类低级错误的手段 —— 肉眼看不出来。

```bash
# 全量校验（每句调一次 API；22 句约 1-2 分钟）
python3 <base_dir>/scripts/verify_segments.py segments.json speakers.json segments/

# 只抽查前 5 句（省时间）
python3 <base_dir>/scripts/verify_segments.py segments.json speakers.json segments/ --sample 5

# 离线自检（不调 API，只查文件是否为空/时长为 0）
python3 <base_dir>/scripts/verify_segments.py segments.json speakers.json segments/ --offline

# 已知例外白名单（人工确认过、属正常的差异，避免每次误报）
python3 <base_dir>/scripts/verify_segments.py segments.json speakers.json segments/ --allow allow.json
```

`allow.json` 格式（只登记确实人工核对过的情况，不得用来掩盖真错误）：
```json
{"14": "教材写数字 120，音频读 one hundred and twenty；中文里已补读音提示，属正常"}
```

判读标准：
- `✓ 通过`（相似度 ≥ 0.80）：音频与文本一致
- `✗ 疑似丢词`：**文本有、音频没听到** → 严重问题，必须修
- `✗ 疑似多词`：**音频有、文本没有** → 严重问题，必须修
- 常见误报可忽略：`it's` → `it s`、`Ms Wang` → `Ms. Wong`（人名识别偏差）

**退出码非 0 就必须处理完再交付。**

**典型抓到的错误**：
> 教材 `We have over 120 dishes to choose from.`
> 音频读作 `We have over one hundred and twenty dishes...`
> → 文本写 `120`、音频读 `one hundred and twenty`，学生听读对不上。
> 处理：保留教材写法，在中文翻译里补读音提示
> `我们有 120（one hundred and twenty）多道菜可以选。`

**7.2 结构校验**

```bash
# 结构校验：行数/头像/音频引用是否齐全
python3 - <<'EOF'
import re, os
h = open('<outdir>/精听.html', encoding='utf-8').read()
roles = set(re.findall(r'class="line (w-[a-z0-9]+)"', h))
styled = set(re.findall(r'\.(w-[a-z0-9]+) \.avatar\{background', h))
print("行数", h.count('class="line w-'), "| 音频", h.count("<audio"))
print("空白头像风险:", roles - styled or "无")
EOF
```

**用 Chromium 截图看实际效果**（browser 工具常不可用，直接调 Chromium）：

```bash
CHROME="$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=1000,1400 \
  --force-device-scale-factor=1.3 --screenshot=/tmp/check.png \
  --virtual-time-budget=2500 "file://<绝对路径>/精听.html"
```

用 `vision` 工具检查截图，确认：头像都有颜色不空白、说话人名正确、字号够大。

### Step 8 — 交付

打包整个目录（HTML + segments/）发给老师，并附截图说明效果。

## 生成的网页功能

| 功能 | 说明 |
|---|---|
| 逐句播放 | 每句右侧按钮，或点击整行任意位置 |
| 选中高亮 | 整行浅绿底 + 左侧深绿竖条 + 序号白字绿底 + 呼吸光晕 |
| 连续播放 | 自动接下一句，可设句间停顿 0~2 秒 |
| **跟读模式** | 句间停顿选「跟读」，停顿时长 = 本句音频时长 + 0.5s。停顿期间选中仍停在**刚读完的句子**，学生跟读；真正开始播下一句时才切选中和滚动 |
| **循环开关** | 「循环播放」复选框，默认开；关闭后末句播完即停，不从头重播 |
| **工具栏吸顶** | 滚动时工具栏 sticky 固定在顶部，随时可暂停/上下句 |
| 翻页笔 | PageUp/PageDown/←/→ 切句，空格重播，Enter 连播，Esc 停 |
| 数字跳句 | 按 1-9 跳第 N 句，0 跳第 10 句 |
| 字号三档 | 标准/大（投影）/超大，Ctrl+± 快捷切换，记忆选择 |
| 中文开关 | 一键隐藏中文 |
| 英文遮挡 | 自测模式，逐句点击揭晓 |
| 身份辨识 | 头像+名字+颜色，性别区分（男蓝系/女红橙系） |

## 关键约束（都是踩过的坑）

1. **ASR 必须用原生接口**，不能用 `/compatible-mode/v1/chat/completions`，否则一直报 `format is empty`。
   音频字段写成 `{"audio": "data:audio/mp3;base64,..."}`，**不是** `{data, format}` 对象。

2. **API 不自动分句**。只返回 1 个整段，必须自己从词级时间戳按标点切。缩写词（Ms./Mr./Dr.）后面不能断，否则 "Hi Ms Wang" 会被切成两句。

3. **每个 kind 必须有独立头像背景色**。漏写任何一个是「白字+透明底」，头像看起来就是空白 —— 这是最容易出的 bug。`build_html.py` 已内置校验，缺色直接报错。

4. **不要臆造说话人**。先查 `knowledge/教材/*.md` 里的 Listening Scripts，教材原文有真实人名。

5. **音频切割不靠 ffmpeg**，纯 Python 解析 MPEG 帧。ffmpeg 在本机因 `libunistring.2.dylib` 缺失会卡死（软链接到 `.5` 版本也不兼容）。

6. **字体大小**用 CSS 变量（`--en-size` 等）驱动，三档切换。改字号只改变量，别硬编码 font-size。

## 依赖

- `DASHSCOPE_API_KEY`（阿里云百炼）。缺了就 `env_config(action="set", key="DASHSCOPE_API_KEY", value="...")`
- Python 3（无第三方依赖）

### ⚠️ 教材拆句 / 合句（防丢词）

教材常把一句拆成两句（`All right.` + `So, we've done some experiments.`），
而 ASR 按音频停顿合成一句。这时如果直接用教材"最相似的那句"替换，
会把 `All right` 丢掉 —— 音频里明明有，文本却没有。

`fix_punctuation.py` 的处理：检测到 **ASR 词序列 == 教材上一句 + 本句** 时，
自动把两句合并回来，并打上 `note` 提示。反之（教材合、ASR 拆）不处理。

清洗原文时别忘了去掉 `Section A, 2b and 2c Ms Wang:` 这种「章节号+说话人」前缀，
否则第一句永远匹配不上。

### ⚠️ 中文翻译存在哪个文件（改一处坏一处的根源）

`build_html.py` **原来只读 `segments.json` 的 `zh` 字段**，
而中文翻译通常是写在 `speakers.json` 里的。
一旦重新切音频、重生成 `segments.json`，中文就静默全空 —— 页面照常生成，看不出问题。

**现已修复**：
- 读取顺序改为 `speakers.json` 的 `zh` → `segments.json` 的 `zh`
- 生成时**必须**打印 `中文翻译: 22/22 句齐全`
- 缺中文会打印 `⚠️ 警告` 并列出句子序号
- 缺失超过一半 → 直接 `return 1` 中止，不交付半成品

**交付前必看日志这一行**，没有"中文翻译 N/N 句齐全"就是有问题。
