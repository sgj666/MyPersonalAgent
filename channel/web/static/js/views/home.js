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
}

function twHomeOpenTool(tool) {
    // The card's href is the shareable form (/teaching?tool=...); the console
    // itself routes by path, so the destination is applied through the router
    // and the tool is selected there.
    navigateTo('teaching');
    if (typeof twTeachSelectTool === 'function') twTeachSelectTool(tool);
    return false;
}

async function _twHomeJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
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
