/* Teacher workbench home: greeting, board metrics, quick tools, and the
   recent artifacts / knowledge the teacher last produced.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. Everything here is
   called at run time from loadHomeView(), so nothing at top level may read a
   declaration from a later file. */

let twHomeLoadToken = 0;

const TW_HOME_ARTIFACT_ICONS = {
    pptx: 'fa-file-powerpoint', ppt: 'fa-file-powerpoint',
    html: 'fa-code', htm: 'fa-code',
    image: 'fa-image', video: 'fa-film', audio: 'fa-music',
    pdf: 'fa-file-pdf', markdown: 'fa-file-lines', text: 'fa-file-lines',
    office: 'fa-file-word', csv: 'fa-file-csv', code: 'fa-code',
};

function twHomeAttr(value) {
    return escapeHtml(String(value == null ? '' : value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function twHomeRenderDate() {
    const el = document.getElementById('home-date');
    if (!el) return;
    const locale = currentLang === 'en' ? 'en-US' : 'zh-CN';
    try {
        el.textContent = new Intl.DateTimeFormat(locale, {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
        }).format(new Date());
    } catch (_) {
        el.textContent = new Date().toLocaleDateString();
    }
    const hello = document.getElementById('home-hello');
    if (hello) {
        const hour = new Date().getHours();
        hello.textContent = t(hour < 12 ? 'tw_home_hi_morning'
            : hour < 18 ? 'tw_home_hi_afternoon' : 'tw_home_hi_evening');
    }
    // The greeting and the line under it come from the teacher profile, so the
    // name and the daily motto match the desktop client.
    fetch('/api/teaching/greeting').then(r => r.json()).then(data => {
        if (data.status !== 'success') return;
        if (hello && data.greeting) hello.textContent = data.greeting;
        const motto = document.getElementById('home-motto');
        if (motto) motto.textContent = data.motto || '';
    }).catch(() => {});
}

function twHomeOpenTool(tool) {
    // The card's href is the shareable form (/teaching?tool=...); the console
    // itself routes by path, so the destination is applied through the router
    // and the tool is selected there.
    navigateTo('teaching');
    if (typeof twTeachSelectTool === 'function') twTeachSelectTool(tool);
    return false;
}

async function _twHomeJSON(url, method, body) {
    const init = { headers: { Accept: 'application/json' } };
    if (method && method !== 'GET') init.method = method;
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status !== 'success') {
        throw new Error((data && data.message) || ('HTTP ' + res.status));
    }
    return data;
}

/** Load everything the home page shows. Each panel fails on its own: a missing
    artifact index must not blank the board metrics. */
function loadHomeView() {
    const token = ++twHomeLoadToken;
    const status = document.getElementById('home-status');
    if (status) {
        status.textContent = '';
        status.classList.remove('is-error');
    }
    twHomeRenderDate();

    _twHomeJSON('/api/tasks')
        .then(data => { if (token === twHomeLoadToken) twHomeRenderBoard(data.board || {}); })
        .catch(err => { if (token === twHomeLoadToken) twHomePanelError('home-board-mini', err); });

    _twHomeJSON('/api/artifacts?limit=5')
        .then(data => { if (token === twHomeLoadToken) twHomeRenderArtifacts(data.items || []); })
        .catch(err => { if (token === twHomeLoadToken) twHomePanelError('home-artifacts', err); });

    _twHomeJSON('/api/knowledge/list')
        .then(data => { if (token === twHomeLoadToken) twHomeRenderKnowledge(data); })
        .catch(err => { if (token === twHomeLoadToken) twHomePanelError('home-knowledge', err); });

    twHomeLoadDay(token);
    twHomeLoadSettings(token);
}

// ---------- today's lessons, digest and reminders ----------

let twHomeClassNames = {};
let twHomeClassNamesPending = null;
let twHomeDigestText = '';
let twHomeSettings = null;

/** class_id -> name, so a lesson the API returns with only an id still reads.
    One request per page load; a failure only costs the fallback label. */
function twHomeEnsureClassNames() {
    if (!twHomeClassNamesPending) {
        twHomeClassNamesPending = _twHomeJSON('/api/teaching/classes')
            .then(data => {
                (Array.isArray(data.classes) ? data.classes : []).forEach(cls => {
                    if (cls && cls.id) twHomeClassNames[cls.id] = cls.name || '';
                });
                return true;
            })
            .catch(() => false);
    }
    return twHomeClassNamesPending;
}

function twHomeDayLessons(payload) {
    const src = payload || {};
    const list = src.slots || src.lessons || src.items || src.courses || [];
    return Array.isArray(list) ? list : [];
}

function twHomeLessonClass(lesson) {
    if (lesson.class_name) return lesson.class_name;
    if (typeof lesson.class === 'string') return lesson.class;
    if (lesson.class && typeof lesson.class.name === 'string') return lesson.class.name;
    return twHomeClassNames[lesson.class_id] || '';
}

function twHomeLessonTime(lesson) {
    if (lesson.time) return String(lesson.time);
    const start = lesson.start || lesson.start_time || '';
    const end = lesson.end || lesson.end_time || '';
    return start && end ? start + '–' + end : start;
}

function twHomeRenderDigest(text) {
    twHomeDigestText = typeof text === 'string' ? text.trim() : '';
    const el = document.getElementById('home-digest');
    if (el) {
        el.textContent = twHomeDigestText || t('tw_digest_empty');
        el.classList.toggle('is-empty', !twHomeDigestText);
    }
    const copy = document.getElementById('home-digest-copy');
    if (copy) copy.disabled = !twHomeDigestText;
}

function twHomeRenderToday(payload) {
    twHomeRenderDigest(payload && (typeof payload.digest_text === 'string'
        ? payload.digest_text : payload.digest));

    const el = document.getElementById('home-today');
    if (!el) return;
    const lessons = twHomeDayLessons(payload).slice()
        .sort((a, b) => (Number(a.period) || 0) - (Number(b.period) || 0));
    if (!lessons.length) {
        el.innerHTML = `<div class="tw-empty"><i class="fas fa-mug-hot" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_today_empty'))}</p></div>`;
        return;
    }
    el.innerHTML = lessons.map(lesson => {
        const mine = lesson.mine !== false;
        const period = lesson.period == null ? ''
            : t('tw_tt_period_n').replace('{n}', String(lesson.period));
        const time = twHomeLessonTime(lesson);
        const cls = twHomeLessonClass(lesson);
        const subject = lesson.subject || '';
        const topic = lesson.topic || lesson.content || '';
        const detail = [subject, topic].filter(Boolean).join(' · ');
        const label = [period, time, cls, detail].filter(Boolean).join(' ');
        return `<button type="button" class="tw-today-item${mine ? ' is-mine' : ''}"
                onclick="navigateTo('timetable')" title="${twHomeAttr(label)}">
            <span class="tw-today-dot" aria-hidden="true"></span>
            <span class="tw-today-period">${escapeHtml(period)}</span>
            <span class="tw-today-time">${escapeHtml(time)}</span>
            <span class="tw-today-body">
                <b>${escapeHtml(cls || '—')}</b>
                <small>${escapeHtml(detail || '')}</small>
            </span>
        </button>`;
    }).join('');
}

function twHomeCopyDigest() {
    if (!twHomeDigestText) return;
    const report = ok => twAcadStatus('home-digest-status',
        ok ? t('tw_digest_copied') : t('tw_c_copy_failed'), !ok);
    if (typeof twAcadCopy === 'function') {
        twAcadCopy(twHomeDigestText).then(report);
        return;
    }
    navigator.clipboard.writeText(twHomeDigestText)
        .then(() => report(true), () => report(false));
}

function twHomeLoadDay(token) {
    return Promise.all([
        _twHomeJSON('/api/teaching/today'),
        twHomeEnsureClassNames(),
    ]).then(([data]) => {
        if (token === twHomeLoadToken) twHomeRenderToday(data);
    }).catch(err => {
        if (token !== twHomeLoadToken) return;
        twHomePanelError('home-today', err);
        twHomeRenderDigest('');
    });
}

/** Settings arrive either flat or under `settings`; defaults are §7.1's. */
function twHomeSettingsOf(payload) {
    const root = payload || {};
    const src = root.settings && typeof root.settings === 'object' ? root.settings : root;
    const morning = src.morning && typeof src.morning === 'object' ? src.morning : {};
    const lesson = src.lesson && typeof src.lesson === 'object' ? src.lesson : {};
    const minutes = Number(lesson.minutes);
    return {
        channel: src.channel || 'web',
        morning: {
            enabled: morning.enabled !== false,
            time: /^\d{2}:\d{2}$/.test(String(morning.time || '')) ? String(morning.time) : '07:30',
        },
        lesson: {
            enabled: lesson.enabled !== false,
            // The store accepts 1–60 minutes; anything else is repaired here
            // rather than bounced back as a validation error on save.
            minutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 10,
        },
    };
}

function twHomeToggleRemind() {
    const morning = document.getElementById('home-morning-enabled');
    const time = document.getElementById('home-morning-time');
    if (morning && time) time.disabled = !morning.checked;
    const lesson = document.getElementById('home-lesson-enabled');
    const minutes = document.getElementById('home-lesson-minutes');
    if (lesson && minutes) minutes.disabled = !lesson.checked;
}

function twHomeRenderSettings(payload) {
    twHomeSettings = twHomeSettingsOf(payload);
    const morning = document.getElementById('home-morning-enabled');
    const time = document.getElementById('home-morning-time');
    const lesson = document.getElementById('home-lesson-enabled');
    const minutes = document.getElementById('home-lesson-minutes');
    if (morning) morning.checked = twHomeSettings.morning.enabled;
    if (time) time.value = twHomeSettings.morning.time;
    if (lesson) lesson.checked = twHomeSettings.lesson.enabled;
    if (minutes) minutes.value = String(twHomeSettings.lesson.minutes);
    twHomeToggleRemind();
}

function twHomeRenderPreview(payload) {
    const root = payload || {};
    const src = root.preview && typeof root.preview === 'object' ? root.preview : root;
    const text = [src.digest, src.next_lesson || src.lesson]
        .filter(part => typeof part === 'string' && part.trim())
        .join('\n\n');
    const el = document.getElementById('home-remind-preview');
    if (!el) return;
    el.textContent = text || t('tw_remind_preview_empty');
    el.classList.toggle('is-empty', !text);
}

function twHomeLoadSettings(token) {
    return Promise.all([
        _twHomeJSON('/api/teaching/settings'),
        _twHomeJSON('/api/teaching/reminders/preview').catch(() => null),
    ]).then(([data, preview]) => {
        if (token !== twHomeLoadToken) return;
        twHomeRenderSettings(data);
        twHomeRenderPreview(preview);
    }).catch(err => {
        if (token !== twHomeLoadToken) return;
        twAcadStatus('home-remind-status', (err && err.message) || t('tw_load_failed'), true);
        twHomeRenderPreview(null);
    });
}

async function twHomeSaveSettings(event) {
    if (event) event.preventDefault();
    const morningEl = document.getElementById('home-morning-enabled');
    const timeEl = document.getElementById('home-morning-time');
    const lessonEl = document.getElementById('home-lesson-enabled');
    const minutesEl = document.getElementById('home-lesson-minutes');
    const time = (timeEl && timeEl.value) || '07:30';
    const minutes = Number(minutesEl && minutesEl.value);
    const payload = {
        morning: {
            enabled: !!(morningEl && morningEl.checked),
            time: /^\d{2}:\d{2}$/.test(time) ? time : '07:30',
        },
        lesson: {
            enabled: !!(lessonEl && lessonEl.checked),
            minutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 10,
        },
        channel: (twHomeSettings && twHomeSettings.channel) || 'web',
    };
    twAcadStatus('home-remind-status', t('tw_remind_saving'));
    try {
        await _twHomeJSON('/api/teaching/settings', 'PUT', payload);
        await _twHomeJSON('/api/teaching/reminders/sync', 'POST', {});
        twHomeSettings = payload;
        twHomeToggleRemind();
        twAcadStatus('home-remind-status', t('tw_remind_saved'));
        _twHomeJSON('/api/teaching/reminders/preview')
            .then(twHomeRenderPreview)
            .catch(() => { /* the saved state is what matters; preview is advisory */ });
    } catch (err) {
        twAcadStatus('home-remind-status', (err && err.message) || t('tw_load_failed'), true);
    }
}

function twHomePanelError(id, err) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
        + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
        + `<p class="tw-hint">${escapeHtml(err && err.message ? err.message : '')}</p>`
        + `<button type="button" class="tw-btn" onclick="loadHomeView()">${escapeHtml(t('tw_retry'))}</button></div>`;
}

function twHomeStatusLabel(status, fallback) {
    const key = 'tw_status_' + status;
    const label = t(key);
    return label === key ? (fallback || status) : label;
}

function twHomeIsOverdue(task) {
    return !!(task && task.due && task.status !== 'done' && task.due < twHomeToday());
}

function twHomeToday() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function twHomeRenderBoard(board) {
    const counts = board.counts || {};
    [['todo', 'home-count-todo'], ['doing', 'home-count-doing'], ['done', 'home-count-done']]
        .forEach(([status, id]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(counts[status] || 0);
        });

    const mini = document.getElementById('home-board-mini');
    if (!mini) return;
    const columns = Array.isArray(board.columns) ? board.columns : [];
    if (!columns.length) {
        mini.innerHTML = `<div class="tw-empty"><p>${escapeHtml(t('tw_home_empty_board'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="navigateTo('board')">${escapeHtml(t('tw_board_new'))}</button></div>`;
        return;
    }
    mini.innerHTML = columns.map(col => {
        const tasks = (col.tasks || []).slice(0, 3);
        const cards = tasks.length
            ? tasks.map(task => `<button type="button" class="tw-mini-task${twHomeIsOverdue(task) ? ' is-overdue' : ''}"
                       onclick="navigateTo('board')" title="${twHomeAttr(task.title)}">
                     ${escapeHtml(task.title)}
                 </button>`).join('')
            : `<div class="tw-mini-empty">${escapeHtml(t('tw_board_empty_col'))}</div>`;
        return `<div class="tw-mini-col">
            <h3><span>${escapeHtml(twHomeStatusLabel(col.status, col.label))}</span><span>${(col.tasks || []).length}</span></h3>
            ${cards}
        </div>`;
    }).join('');
}

function twHomeArtifactIcon(item) {
    const ext = String(item.file_name || '').split('.').pop().toLowerCase();
    return TW_HOME_ARTIFACT_ICONS[ext] || TW_HOME_ARTIFACT_ICONS[item.kind] || 'fa-file';
}

function twHomeRenderArtifacts(items) {
    const el = document.getElementById('home-artifacts');
    if (!el) return;
    if (!items.length) {
        el.innerHTML = `<div class="tw-empty"><i class="fas fa-box-open" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_home_empty_artifacts'))}</p></div>`;
        return;
    }
    el.innerHTML = items.map(item => {
        const name = item.title || item.file_name || item.rel_path || '';
        const when = item.created_at ? String(item.created_at).replace('T', ' ').slice(0, 16) : '';
        return `<button type="button" class="tw-list-item" onclick="navigateTo('artifacts')" title="${twHomeAttr(item.rel_path || name)}">
            <i class="fas ${twHomeArtifactIcon(item)}" aria-hidden="true"></i>
            <span>${escapeHtml(name)}</span>
            <small>${escapeHtml(when)}</small>
        </button>`;
    }).join('');
}

/** Flatten the knowledge tree into documents, keeping the folder as the path. */
function twHomeKnowledgeDocs(tree, prefix, out) {
    const rows = out || [];
    const dir = prefix || '';
    (tree || []).forEach(node => {
        const nodeDir = dir ? dir + '/' + node.dir : node.dir;
        (node.files || []).forEach(file => {
            rows.push({ title: file.title || file.name, path: nodeDir + '/' + file.name });
        });
        twHomeKnowledgeDocs(node.children, nodeDir, rows);
    });
    return rows;
}

function twHomeRenderKnowledge(data) {
    const el = document.getElementById('home-knowledge');
    if (!el) return;
    const root = (data.root_files || []).map(file => ({
        title: file.title || file.name,
        path: file.name,
    }));
    const docs = root.concat(twHomeKnowledgeDocs(data.tree || [], '', []));
    if (!docs.length) {
        el.innerHTML = `<div class="tw-empty"><i class="fas fa-book-open" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_home_empty_knowledge'))}</p></div>`;
        return;
    }
    const pages = (data.stats && data.stats.pages) || docs.length;
    el.innerHTML = docs.slice(0, 5).map(doc => `<button type="button" class="tw-list-item"
            onclick="navigateTo('knowledge')" title="${twHomeAttr(doc.path)}">
            <i class="fas fa-file-lines" aria-hidden="true"></i>
            <span>${escapeHtml(doc.title)}</span>
        </button>`).join('')
        + `<p class="tw-footnote">${escapeHtml(t('tw_knowledge_pages').replace('{n}', String(pages)))}</p>`;
}
