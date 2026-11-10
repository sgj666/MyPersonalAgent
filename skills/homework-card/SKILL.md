---
name: homework-card
description: 生成单文件作业卡片 HTML（自包含 CSS、可打印、可在控制台导出 PNG）。Use when the teacher asks for 作业卡片/作业单/练习卡/分层作业, or chooses 作业卡片 in the 教学工具 page. Writes artifacts/作业卡片/<slug>.html.
---

# 作业卡片（单文件 HTML）

输出一个 `.html`：CSS 全部内联，无外链、无网络请求、无 webfont；屏幕版式与打印版式一致；页面上注明 PNG 导出在控制台预览页完成。

## 1 收素材

必需：题目来源（教材单元 / 教师口述 / 知识库 `knowledge/评测/` 页面）、学段学科、版式（A4 竖版默认）、题量与难度。

缺题目来源时先问一句，不要自己编一整套题。从 `knowledge/教材/…` 或 `knowledge/评测/题库/…` 取原题时保持题干、选项、答案不变。

## 2 版式规则

- 一页 A4 装得下：小学 ≤ 8 题、初中 ≤ 10 题、高中 ≤ 12 题；超出就分页（`<section class="sheet">` 每页一个）。
- 学生作答区留白：选择题留括号，填空题留下划线区域，简答留 3–5 行横线。
- 卡片头部：标题、班级、姓名、日期；页脚：得分、教师评语或家长签字。
- 字体只用系统栈：`"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif`。
- 颜色克制：黑白印刷也要能读；强调色只用于标题线和题号。
- 答案与讲评不放进学生卡片；需要时再单独问教师是否要答案版。

## 3 HTML 骨架

按这个结构写，样式写在 `<head>` 的 `<style>` 里，不要拆外部文件：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>作业卡片 · <课题></title>
<style>
  :root { --ink:#1f2430; --muted:#6b7280; --line:#d6dae2; --accent:#2f6fb2; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#eef1f5; color:var(--ink);
         font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif; }
  .sheet { width:210mm; min-height:297mm; margin:0 auto 20px; padding:16mm;
           background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.08); }
  .card-head { display:flex; justify-content:space-between; align-items:flex-end;
               border-bottom:2px solid var(--accent); padding-bottom:8px; }
  .card-head h1 { margin:0; font-size:20px; }
  .meta { font-size:12px; color:var(--muted); }
  .meta span { display:inline-block; margin-left:16px; }
  .hint { margin:12px 0 0; font-size:12px; color:var(--muted); }
  .question { margin:14px 0 0; font-size:14px; line-height:1.7; page-break-inside:avoid; }
  .question .no { font-weight:600; color:var(--accent); margin-right:6px; }
  .blank { border-bottom:1px solid var(--line); display:inline-block; min-width:80px; }
  .answer-lines i { display:block; border-bottom:1px solid var(--line); height:26px; }
  .card-foot { display:flex; justify-content:space-between; margin-top:18px;
               font-size:12px; color:var(--muted); border-top:1px solid var(--line); padding-top:8px; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { width:auto; min-height:0; margin:0; padding:12mm; box-shadow:none;
             page-break-after:always; }
    .sheet:last-child { page-break-after:auto; }
    .hint, .no-print { display:none !important; }
    @page { size:A4; margin:12mm; }
  }
</style>
</head>
<body>
  <section class="sheet">
    <header class="card-head">
      <h1>Unit 3 课后作业</h1>
      <div class="meta"><span>班级：______</span><span>姓名：______</span><span>日期：____</span></div>
    </header>
    <p class="hint">打印可直接出纸质卡片；需要图片时，在控制台「产出文件」中预览本页并导出 PNG。</p>
    <div class="question"><span class="no">1.</span> 根据汉语提示写出短语：<span class="blank"></span>（看望祖父母）</div>
    <div class="question"><span class="no">2.</span> 用 be going to 写两句话描述你的周末：
      <div class="answer-lines"><i></i><i></i></div>
    </div>
    <footer class="card-foot"><span>得分：______</span><span>教师评语：________________</span><span>家长签字：______</span></footer>
  </section>
</body>
</html>
```

可替换/扩展：`--accent` 换色即换主题；多页就复制 `<section class="sheet">`；听力或连线题在 `notes` 之外用表格实现，仍然只用内联样式。

## 4 落盘与校验

1. 文件名：`<学段>-<学科>-<单元>-<作业名>.html`，例如
   `artifacts/作业卡片/初中-英语-U3-周末计划-基础作业.html`；目录不存在先 `mkdir -p artifacts/作业卡片`。
2. 用 `write` 工具写入，不要用 shell heredoc 拼 HTML。
3. 回读校验：`read` 首尾各 20 行，确认 `<!DOCTYPE html>`、`@media print`、`</html>` 都在；文件应 ≥ 2 KB。
4. 报告：路径、文件大小、题量、建议打印方式（A4 竖版、边距 12mm）。
5. 页面上不要出现外链 `<link>`、`<script src>`，也不要出现以 `http` 开头的地址；需要交互时用内联 `<script>`，并保证去掉脚本后内容仍可读。
