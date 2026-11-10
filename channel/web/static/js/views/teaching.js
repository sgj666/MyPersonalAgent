/* Teacher workbench teaching tools: five small forms that turn into one
   Chinese prompt and hand it to the existing chat flow (newChat + sendMessage)
   rather than opening a second conversation surface.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. Everything here is
   called at run time from loadTeachingView()/the inline handlers. */

const TW_TEACH_TOOLS = ['plan', 'courseware', 'card', 'advice', 'schedule'];
const TW_TEACH_FALLBACK = '未填写';

let twTeachTool = 'plan';

function twTeachStatus(text, isError) {
    const el = document.getElementById('teach-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
}

function twTeachToolFromUrl() {
    let tool = '';
    try {
        tool = new URLSearchParams(location.search).get('tool') || '';
    } catch (_) { /* older browsers: fall through to the hash */ }
    if (TW_TEACH_TOOLS.indexOf(tool) === -1) {
        // The home cards link with #/teaching?tool=<id>; honour that too so a
        // copied link lands on the tool it names.
        const hash = String(location.hash || '');
        if (hash.indexOf('#/teaching') === 0 && hash.indexOf('?') !== -1) {
            try {
                tool = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('tool') || '';
            } catch (_) { /* leave the current tool */ }
        }
    }
    return TW_TEACH_TOOLS.indexOf(tool) === -1 ? '' : tool;
}

function loadTeachingView() {
    const fromUrl = twTeachToolFromUrl();
    twTeachSelectTool(fromUrl || twTeachTool);
}

function twTeachSelectTool(tool) {
    if (TW_TEACH_TOOLS.indexOf(tool) === -1) return;
    twTeachTool = tool;
    TW_TEACH_TOOLS.forEach(id => {
        const tab = document.getElementById('teach-tab-' + id);
        if (tab) tab.setAttribute('aria-selected', id === tool ? 'true' : 'false');
        const panel = document.getElementById('teach-form-' + id);
        if (panel) panel.classList.toggle('hidden', id !== tool);
    });
    twTeachStatus('');
    twTeachRefreshPreview();
}

function twTeachValues(tool) {
    const out = {};
    const form = document.getElementById('teach-form-' + tool);
    if (!form) return out;
    form.querySelectorAll('[name]').forEach(field => {
        out[field.name] = String(field.value || '').trim();
    });
    return out;
}

function twTeachValue(values, key) {
    return values[key] ? values[key] : TW_TEACH_FALLBACK;
}

function twTeachBuildPrompt(tool) {
    const values = twTeachValues(tool);
    const v = key => twTeachValue(values, key);
    if (tool === 'plan') {
        return [
            '请生成一份教案（Markdown 输出）。',
            `学段：${v('stage')}`,
            `学科：${v('subject')}`,
            `教材版本：${v('book')}`,
            `单元 / 课题：${v('unit')}`,
            `课型：${v('lesson_type')}`,
            `课时：${v('hours')} 课时`,
            `教学目标：${v('goal')}`,
            '',
            '要求：',
            '1. 按「教学目标 / 教学重难点 / 教学准备 / 教学过程（分环节并标注时间）/ 板书设计 / 作业布置 / 课后反思」组织。',
            '2. 教学过程写出教师活动、学生活动和设计意图。',
            '3. 语言面向教师，可直接照着上课；引用教材内容请注明出处。',
            '4. 生成后保存到知识库的「教案」分类。',
        ].join('\n');
    }
    if (tool === 'courseware') {
        return [
            '请生成一套课件（.pptx）。',
            `单元 / 课题：${v('unit')}`,
            `教案来源：${v('source')}`,
            `母版模板：${v('template')}`,
            `页数：约 ${v('slides')} 页`,
            '',
            '要求：',
            '1. 先生成结构化内容：封面、目录、每页标题 + 要点 + 备注稿。',
            `2. 使用「${v('template')}」母版；只用主题字体，不嵌字体，避免跨机版式错乱。`,
            '3. 输出真实 .pptx 文件到产出目录，完成后告诉我文件路径。',
        ].join('\n');
    }
    if (tool === 'card') {
        return [
            '请生成一份作业卡片（单文件 HTML）。',
            `题目来源：${v('source')}`,
            `版式：${v('layout')}`,
            `题目数量：${v('count')} 道`,
            '',
            '要求：',
            '1. 单文件自包含：内联 CSS，无外链、无网络请求，便于在产出视图内嵌预览。',
            '2. 页面内提供「导出图片」，打印样式隐藏按钮与页边距。',
            '3. 字体使用系统字体栈（PingFang SC / Microsoft YaHei 回退），不引 webfont。',
            '4. 生成后保存到产出目录的「作业卡片」分类。',
        ].join('\n');
    }
    if (tool === 'advice') {
        return [
            '请给出教学建议。',
            `班级情况：${v('class_name')}`,
            `单元 / 课题：${v('unit')}`,
            `关注点：${v('focus')}`,
            '',
            '要求：结合学情给出可执行的课堂策略（导入、活动、分层任务、评价与作业），并指出 2–3 个需要提前准备的风险点。',
        ].join('\n');
    }
    if (tool === 'schedule') {
        return [
            '请生成学期教学计划（Markdown 表格）。',
            `学期：${v('term')}`,
            `单元范围：${v('scope')}`,
            `周数：${v('weeks')} 周`,
            '',
            '要求：',
            '1. 表格列：周次 / 单元 / 课题 / 课时 / 教学目标 / 评价方式。',
            '2. 课时总量与周数匹配，注明期中、期末复习周。',
            '3. 表格可直接打印。',
        ].join('\n');
    }
    return '';
}

function twTeachRefreshPreview() {
    const preview = document.getElementById('teach-prompt-preview');
    if (!preview) return;
    preview.value = twTeachBuildPrompt(twTeachTool);
}

function twTeachSubmit(tool, event) {
    if (event) event.preventDefault();
    const form = document.getElementById('teach-form-' + tool);
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const prompt = twTeachBuildPrompt(tool).trim();
    if (!prompt) return;

    // navigateTo returns false when a document editor refuses to drop unsaved
    // changes; sending then would leave the prompt nowhere.
    if (navigateTo('chat') === false) {
        twTeachStatus(t('tw_teach_leave_blocked'), true);
        return;
    }
    if (typeof newChat === 'function') newChat();
    if (typeof chatInput === 'undefined' || !chatInput) {
        twTeachStatus(t('tw_load_failed'), true);
        return;
    }
    chatInput.value = prompt;
    if (typeof autoResizeComposer === 'function') autoResizeComposer();
    chatInput.focus();
    if (typeof sendMessage === 'function') sendMessage();
}
