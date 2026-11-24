---
name: word-dictation
description: 把某个课本单元的词表整理成听写单词单的 JSON（word / phonetic / pos / meaning），写到 artifacts/教学工具/dictation/<slug>.json。Use when the teacher asks for 单词听写/听写单/单元词表, or the 单词听写 page sends book + unit. 只产出 JSON；HTML 由页面渲染。
---

# 单词听写（词表 JSON）

场景：教师按「课本 + 单元」要一份听写单词单。你只负责**把这一单元的词表列全**；页面会勾选、排序
并渲染成可打印、可朗读的单页 HTML。

## 1 入参

- `book`：课本名，例如「人教新版七上」「人教版八年级上册」「PEP 五年级上」。
- `unit`：单元，例如「Unit 3 My weekend plan」「Starter Unit 1」。
- `knowledge_paths`：可选，教师勾选的知识库教材文件（`knowledge/教材/**`）。

有 `knowledge_paths` 时先 `read`，词表以文件里出现的单词为准；读不到或文件里没有词表时，按该教材
该单元的标准词汇表输出。**不要**把整册单词混进来。

## 2 词表规则

- 只收本单元的生词与固定短语（含 `see a film`、`ice cream` 这类多词条目），不收人名、语法术语。
- 每个单元 8–40 条；按教材出现顺序排，不按字母排。
- 每个词用 `senses` 数组：一个词性一条，`pos` 在前、`meaning` 在后。
- `pos` 用 `n.` `v.` `adj.` `adv.` `prep.` `pron.` `conj.` `num.` `phr.` 这类缩写；短语用 `phr.`。
- `meaning` 用教材自己的中文释义，简洁，≤ 20 字；一词多义只留本单元的意思。
- 同一个词在本单元有多个词性/义项时，拆成多条 sense，**不要**用 `v./n.` 挤在一条里。例如 present 在
  本单元既是动词「呈现」又是名词「礼物」，就写两条。
- `phonetic` 用英式或美式音标都行，必须带斜杠，例如 `/ˈvɪzɪt/`；不确定就留空字符串，不要编。
- 每个词必须给 `example`：**先 read 本单元的知识库教材文件**，优先原句摘录文章中包含该词的完整句子（保留原标点即可，不要改写措辞）；文章里没有合适的句子时，再自己写一句 8–16 词、符合本学段水平的自然例句。
- `example_zh` 给这句例句的中文翻译，简洁准确；可以省略，但建议提供。

## 3 JSON 契约

只输出一个 ```json 代码块：

```json
{"version": 1,
 "meta": {"title": "Unit 3 单词听写", "book": "人教新版七上", "unit": "Unit 3 My weekend plan",
          "date": "2026-11-12", "mode": "zh"},
 "words": [
   {"word": "visit", "phonetic": "/ˈvɪzɪt/", "senses": [{"pos": "v.", "meaning": "参观；拜访"}],
    "example": "We will visit the science museum this weekend.",
    "example_zh": "这个周末我们要去参观科学博物馆。"},
   {"word": "present", "phonetic": "/prɪˈzent/", "senses": [
     {"pos": "v.", "meaning": "呈现；赠送"}, {"pos": "n.", "meaning": "礼物"}],
    "example": "She will present her project to the class.",
    "example_zh": "她将向全班展示她的项目。"},
   {"word": "see a film", "phonetic": "", "senses": [{"pos": "phr.", "meaning": "看电影"}],
    "example": "Let’s see a film after school.",
    "example_zh": "放学后我们去看电影吧。"}
 ]}
```

- `mode` 固定写 `zh`；教师在页面上切到英文听写后由页面改写，你不需要处理。
- 不要输出单词级的 `pos` / `meaning` 字段，统一放在 `senses` 里；不要输出 `on` 字段（勾选状态由页面维护）。
- `example` 必须真的包含该词（或该短语）；不要写“例句：……”这种前缀。
- 不要输出 HTML、Markdown 表格或解释文字；页面只读这个 JSON。

## 4 落盘与回读

1. slug：`<课本>-<单元>-单词听写`，去掉括号、空格、斜杠，例如 `人教新版七上-Unit3-单词听写`。
2. 用 `write` 写 `artifacts/教学工具/dictation/<slug>.json`，纯 JSON，不加 ``` 和注释。
3. `read` 回读，自查：能解析、`words` 8–40 条、每条都有非空 `word` 和至少一条 `senses`、每条 sense 有 `pos` 与非空 `meaning`（≤ 20 字）、`phonetic` 为空或带斜杠、每条都有包含该词的 `example`（≤ 25 词）。
4. 回报：路径、单词数、来源（知识库文件或教材标准词表）。

## 5 禁止（怎么算失败）

- 编造本单元没有的单词，或把整册词汇混进来。
- 把多个词性写进同一条 sense（如 `"pos": "v./n."`）。
- 少了中文释义或词性，或释义写成一段解释而不是词组意思。
- 把 HTML / 表格 / “以下是……”之类的话写进 JSON 代码块。
- 输出里夹解释文字导致 JSON 解析失败。
