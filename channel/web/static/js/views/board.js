/* Teacher workbench task board: the four fixed status lanes, Eisenhower
   quadrants and categories, due date with an optional time, create/edit, drag
   or keyboard status changes, lane/quadrant filters and three sorts.

   The board API is per Agent (/api/tasks); the console's fetch wrapper adds
   the active agent_id to every request, so nothing here names one. These are
   classic scripts sharing one global scope; see channel/web/README.md before
   changing the load order. */

const TW_BOARD_STATUSES = ['todo', 'doing', 'blocked', 'done'];
const TW_BOARD_LANE_NONE = '__none__';

/* Eisenhower quadrants in display order. The codes are the API contract
   (agent/board/store.py PRIORITIES), not labels: each code's text lives in
   i18n as tw_quad_<code> and its colour is a .tw-quad-<code> class in
   board.css. `important` means important but not urgent; `urgent` the other
   way round. */
const TW_BOARD_QUADRANTS = ['urgent_important', 'important', 'urgent', 'neither'];
const TW_BOARD_QUADRANT_RANK = { urgent_important: 0, important: 1, urgent: 2, neither: 3 };
/* Boards written before the quadrants carried a three-step scale. The store
   migrates those on read; this mapping only keeps a stale payload from
   rendering a pill with no colour. */
const TW_BOARD_LEGACY_PRIORITY = { high: 'urgent_important', normal: 'important', low: 'neither' };
/* The store's own default when a create omits priority. */
const TW_BOARD_DEFAULT_QUADRANT = 'important';
const TW_BOARD_MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let twBoardTasks = [];
let twBoardLane = '';
let twBoardQuadrant = '';
let twBoardSortMode = 'due';
let twBoardLoadToken = 0;
let twBoardWired = false;
let twBoardDraggingId = '';
let twBoardSaving = false;

function twBoardPad(n) {
    return String(n).padStart(2, '0');
}

/* A YYYY-MM-DD key `offset` days from today, in the teacher's own timezone. */
function twBoardDateKey(offset) {
    const now = new Date();
    now.setDate(now.getDate() + (offset || 0));
    return `${now.getFullYear()}-${twBoardPad(now.getMonth() + 1)}-${twBoardPad(now.getDate())}`;
}

function twBoardToday() {
    return twBoardDateKey(0);
}

function twBoardAttr(value) {
    return escapeHtml(String(value == null ? '' : value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function twBoardStatusLabel(status) {
    const key = 'tw_status_' + status;
    const label = t(key);
    return label === key ? status : label;
}

function twBoardQuadrantOf(task) {
    const raw = task && task.priority ? String(task.priority) : '';
    if (TW_BOARD_QUADRANT_RANK[raw] != null) return raw;
    return TW_BOARD_LEGACY_PRIORITY[raw] || '';
}

function twBoardQuadrantLabel(quadrant) {
    const key = 'tw_quad_' + quadrant;
    const label = t(key);
    return label === key ? quadrant : label;
}

/* Sort key for a deadline: the date, then the time, so 18:00 on the 2nd sorts
   after 09:00 on the 2nd and a date without a time sorts before both (the day
   starts at 00:00). Empty string means no deadline and sorts last. */
function twBoardDueKey(task) {
    if (!task || !task.due) return '';
    const time = /^\d{2}:\d{2}$/.test(String(task.due_time || '')) ? task.due_time : '00:00';
    return task.due + 'T' + time;
}

/* Whole days a task is past its date. Date-based on purpose: a task due today
   at 09:00 is still "today's" work, not overdue, until the date rolls over. */
function twBoardOverdueDays(task) {
    if (!task || !task.due || task.status === 'done') return 0;
    const today = twBoardToday();
    if (task.due >= today) return 0;
    const dueMs = Date.parse(task.due + 'T00:00:00Z');
    const todayMs = Date.parse(today + 'T00:00:00Z');
    if (isNaN(dueMs) || isNaN(todayMs)) return 0;
    return Math.max(1, Math.round((todayMs - dueMs) / 86400000));
}

function twBoardIsOverdue(task) {
    return twBoardOverdueDays(task) > 0;
}

function twBoardMonthDay(dateKey) {
    const parts = String(dateKey || '').split('-');
    if (parts.length !== 3) return String(dateKey || '');
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!month || !day) return String(dateKey || '');
    if (typeof currentLang !== 'undefined' && currentLang === 'en') {
        return `${TW_BOARD_MONTHS_EN[month - 1] || month} ${day}`;
    }
    return `${month}月${day}日`;
}

/* "今天 18:00" / "明天 09:30" / "9月2日 14:00" / "无期限". */
function twBoardDueLabel(task) {
    if (!task || !task.due) return t('tw_task_none_due');
    const time = task.due_time ? ' ' + task.due_time : '';
    if (task.due === twBoardToday()) return t('tw_due_today') + time;
    if (task.due === twBoardDateKey(1)) return t('tw_due_tomorrow') + time;
    return twBoardMonthDay(task.due) + time;
}

/* Server timestamps are ISO-8601 UTC; show them in the teacher's timezone. */
function twBoardStamp(iso) {
    if (!iso) return '';
    const at = new Date(iso);
    if (isNaN(at.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const dateKey = `${at.getFullYear()}-${twBoardPad(at.getMonth() + 1)}-${twBoardPad(at.getDate())}`;
    return `${twBoardMonthDay(dateKey)} ${twBoardPad(at.getHours())}:${twBoardPad(at.getMinutes())}`;
}

function twBoardSetStatusText(text, isError) {
    const el = document.getElementById('board-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
}

function twBoardAnnounce(text) {
    const live = document.getElementById('board-live');
    if (!live) return;
    // Clearing first makes a same-text announcement speak again.
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
}

async function twBoardJSON(url, body) {
    const opts = { headers: { Accept: 'application/json' } };
    if (body) {
        opts.method = 'POST';
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status !== 'success') {
        throw new Error((data && data.message) || ('HTTP ' + res.status));
    }
    return data;
}

function loadBoardView() {
    if (!twBoardWired) {
        twBoardWired = true;
        const sort = document.getElementById('board-sort');
        if (sort) sort.value = twBoardSortMode;
        const quadrant = document.getElementById('board-quadrant-filter');
        if (quadrant) quadrant.value = twBoardQuadrant;
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            const dialog = document.getElementById('board-dialog');
            if (dialog && !dialog.classList.contains('hidden')) twBoardCloseDialog();
        });
    }
    return twBoardLoad();
}

function twBoardLoad() {
    const token = ++twBoardLoadToken;
    twBoardSetStatusText('');
    const columns = document.getElementById('board-columns');
    if (columns && !twBoardTasks.length) {
        columns.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    }
    return twBoardJSON('/api/tasks')
        .then(data => {
            if (token !== twBoardLoadToken) return;
            twBoardTasks = Array.isArray(data.tasks) ? data.tasks : [];
            twBoardRender();
        })
        .catch(err => {
            if (token !== twBoardLoadToken) return;
            twBoardSetStatusText(t('tw_load_failed') + ' — ' + err.message, true);
            if (columns) {
                columns.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                    + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                    + `<button type="button" class="tw-btn" onclick="twBoardLoad()">${escapeHtml(t('tw_retry'))}</button></div>`;
            }
        });
}

function twBoardTaskOf(id) {
    return twBoardTasks.find(task => task.id === id) || null;
}

function twBoardLanes() {
    const seen = new Set();
    let loose = false;
    twBoardTasks.forEach(task => {
        if (task.lane) seen.add(task.lane);
        else loose = true;
    });
    return { lanes: [...seen].sort((a, b) => a.localeCompare(b, 'zh')), loose: loose };
}

function twBoardPriorityRank(task) {
    const quadrant = twBoardQuadrantOf(task);
    return quadrant ? TW_BOARD_QUADRANT_RANK[quadrant] : TW_BOARD_QUADRANTS.length;
}

function twBoardCompareDue(a, b) {
    const ka = twBoardDueKey(a);
    const kb = twBoardDueKey(b);
    if (ka === kb) return 0;
    if (!ka) return 1;
    if (!kb) return -1;
    return ka.localeCompare(kb);
}

function twBoardSorted(tasks) {
    const rows = tasks.slice();
    const createdAsc = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));
    if (twBoardSortMode === 'created') {
        // Newest first: the task just added is at the top of its column.
        rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        return rows;
    }
    if (twBoardSortMode === 'priority') {
        // Quadrant first (urgent+important first), then the same deadline order
        // inside a quadrant so a column still reads top-down by urgency.
        rows.sort((a, b) => (twBoardPriorityRank(a) - twBoardPriorityRank(b))
            || twBoardCompareDue(a, b)
            || createdAsc(a, b));
        return rows;
    }
    // Due first, soonest first; undated rows last; ties by quadrant.
    rows.sort((a, b) => twBoardCompareDue(a, b)
        || (twBoardPriorityRank(a) - twBoardPriorityRank(b))
        || createdAsc(a, b));
    return rows;
}

function twBoardVisibleTasks() {
    let rows = twBoardTasks;
    if (twBoardLane === TW_BOARD_LANE_NONE) rows = rows.filter(task => !task.lane);
    else if (twBoardLane) rows = rows.filter(task => task.lane === twBoardLane);
    if (twBoardQuadrant) rows = rows.filter(task => twBoardQuadrantOf(task) === twBoardQuadrant);
    return rows;
}

function twBoardRenderLaneOptions() {
    const select = document.getElementById('board-lane-filter');
    const datalist = document.getElementById('board-lane-options');
    const { lanes, loose } = twBoardLanes();
    if (datalist) {
        datalist.innerHTML = lanes.map(lane => `<option value="${twBoardAttr(lane)}"></option>`).join('');
    }
    if (!select) return;
    if (twBoardLane && twBoardLane !== TW_BOARD_LANE_NONE && !lanes.includes(twBoardLane)) {
        twBoardLane = '';
    }
    if (twBoardLane === TW_BOARD_LANE_NONE && !loose) twBoardLane = '';
    select.innerHTML = `<option value="">${escapeHtml(t('tw_board_lane_all'))}</option>`
        + lanes.map(lane => `<option value="${twBoardAttr(lane)}">${escapeHtml(lane)}</option>`).join('')
        + (loose ? `<option value="${TW_BOARD_LANE_NONE}">${escapeHtml(t('tw_board_lane_none'))}</option>` : '');
    select.value = twBoardLane;
}

/* One card. The tag row carries the quadrant, the category and the lane; the
   marks row carries the deadline, the overdue count and the completion time;
   the footer keeps the status select and the row actions where the board has
   always put them. */
function twBoardCard(task) {
    const quadrant = twBoardQuadrantOf(task);
    const overdueDays = twBoardOverdueDays(task);
    const tags = [
        quadrant
            ? `<span class="tw-chip tw-quad tw-quad-${quadrant}">${escapeHtml(twBoardQuadrantLabel(quadrant))}</span>`
            : '',
        task.category
            ? `<span class="tw-chip tw-chip-cat"><i class="fas fa-tag" aria-hidden="true"></i>${escapeHtml(task.category)}</span>`
            : '',
        task.lane ? `<span class="tw-chip tw-chip-lane">${escapeHtml(task.lane)}</span>` : '',
    ].join('');
    const marks = [
        `<span class="tw-chip tw-chip-due${overdueDays ? ' is-overdue' : ''}">`
            + `<i class="fas fa-calendar-day" aria-hidden="true"></i>${escapeHtml(twBoardDueLabel(task))}</span>`,
        overdueDays
            ? `<span class="tw-chip tw-chip-overdue"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `${escapeHtml(t('tw_task_overdue_days').replace('{n}', String(overdueDays)))}</span>`
            : '',
        task.status === 'done' && task.done_at
            ? `<span class="tw-chip tw-chip-done"><i class="fas fa-check" aria-hidden="true"></i>`
                + `${escapeHtml(t('tw_task_done_at').replace('{time}', twBoardStamp(task.done_at)))}</span>`
            : '',
    ].join('');
    const options = TW_BOARD_STATUSES.map(status =>
        `<option value="${status}"${status === task.status ? ' selected' : ''}>${escapeHtml(twBoardStatusLabel(status))}</option>`
    ).join('');
    const updated = task.updated_at
        ? `<p class="tw-task-updated">${escapeHtml(t('tw_task_meta_updated').replace('{time}', twBoardStamp(task.updated_at)))}</p>`
        : '';
    return `<article class="tw-task${overdueDays ? ' is-overdue' : ''}${task.status === 'done' ? ' is-done' : ''}" draggable="true" data-task-id="${twBoardAttr(task.id)}">
        <div class="tw-task-tags">${tags}</div>
        <h3>${escapeHtml(task.title)}</h3>
        ${task.note ? `<p class="tw-task-note">${escapeHtml(task.note)}</p>` : ''}
        <div class="tw-task-tags tw-task-marks">${marks}</div>
        <div class="tw-task-foot">
            <select class="tw-select" aria-label="${twBoardAttr(t('tw_task_move'))}"
                    onchange="twBoardSetStatus('${twBoardAttr(task.id)}', this.value)">
                ${options}
            </select>
            <button type="button" class="tw-icon-btn" onclick="twBoardEdit('${twBoardAttr(task.id)}')"
                    aria-label="${twBoardAttr(t('tw_task_edit'))}" title="${twBoardAttr(t('tw_task_edit'))}">
                <i class="fas fa-pen" aria-hidden="true"></i>
            </button>
            <button type="button" class="tw-icon-btn is-danger" onclick="twBoardDelete('${twBoardAttr(task.id)}')"
                    aria-label="${twBoardAttr(t('tw_task_delete'))}" title="${twBoardAttr(t('tw_task_delete'))}">
                <i class="fas fa-trash" aria-hidden="true"></i>
            </button>
        </div>
        ${updated}
    </article>`;
}

function twBoardRender() {
    twBoardRenderLaneOptions();
    const columns = document.getElementById('board-columns');
    const empty = document.getElementById('board-empty');
    const total = document.getElementById('board-total');
    if (!columns) return;
    // Four lanes are the board's shape, not a property of its contents: an
    // empty board still shows all four so a teacher can drop work into them.
    if (empty) empty.classList.add('hidden');
    columns.classList.remove('hidden');

    const visible = twBoardVisibleTasks();
    if (total) total.textContent = t('tw_board_total').replace('{n}', String(visible.length));
    columns.innerHTML = TW_BOARD_STATUSES.map(status => {
        const tasks = twBoardSorted(visible.filter(task => task.status === status));
        const body = tasks.length
            ? tasks.map(twBoardCard).join('')
            : `<div class="tw-lane-empty">${escapeHtml(t('tw_board_empty_col'))}</div>`;
        return `<section class="tw-lane" data-status="${status}" aria-labelledby="board-lane-${status}">
            <div class="tw-lane-head">
                <h2 id="board-lane-${status}">${escapeHtml(twBoardStatusLabel(status))}</h2>
                <span class="tw-lane-count">${tasks.length}</span>
            </div>
            <div class="tw-lane-body">${body}</div>
        </section>`;
    }).join('');

    twBoardWireDnd();
}

function twBoardWireDnd() {
    const root = document.getElementById('board-columns');
    if (!root) return;
    root.querySelectorAll('.tw-task').forEach(card => {
        card.addEventListener('dragstart', e => {
            twBoardDraggingId = card.dataset.taskId || '';
            card.classList.add('is-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', twBoardDraggingId);
            }
        });
        card.addEventListener('dragend', () => {
            twBoardDraggingId = '';
            card.classList.remove('is-dragging');
            root.querySelectorAll('.tw-lane').forEach(lane => lane.classList.remove('is-drop-target'));
        });
    });
    root.querySelectorAll('.tw-lane').forEach(lane => {
        lane.addEventListener('dragover', e => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            lane.classList.add('is-drop-target');
        });
        lane.addEventListener('dragleave', e => {
            if (!lane.contains(e.relatedTarget)) lane.classList.remove('is-drop-target');
        });
        lane.addEventListener('drop', e => {
            e.preventDefault();
            lane.classList.remove('is-drop-target');
            const id = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || twBoardDraggingId;
            if (id) twBoardSetStatus(id, lane.dataset.status);
        });
    });
}

function twBoardSetLane(lane) {
    twBoardLane = lane || '';
    twBoardRender();
}

function twBoardSetQuadrant(quadrant) {
    twBoardQuadrant = TW_BOARD_QUADRANTS.indexOf(quadrant) === -1 ? '' : quadrant;
    const select = document.getElementById('board-quadrant-filter');
    if (select) select.value = twBoardQuadrant;
    twBoardRender();
}

function twBoardSetSort(mode) {
    twBoardSortMode = mode === 'created' || mode === 'priority' ? mode : 'due';
    const select = document.getElementById('board-sort');
    if (select) select.value = twBoardSortMode;
    twBoardRender();
}

async function twBoardSetStatus(id, status) {
    if (twBoardSaving || TW_BOARD_STATUSES.indexOf(status) === -1) return;
    const task = twBoardTaskOf(id);
    if (!task || task.status === status) return;
    twBoardSaving = true;
    try {
        await twBoardJSON('/api/tasks/update', { id: id, status: status });
        task.status = status;
        if (status === 'done') task.done_at = new Date().toISOString();
        else task.done_at = '';
        twBoardSetStatusText('');
        twBoardAnnounce(t('tw_task_moved').replace('{title}', task.title).replace('{status}', twBoardStatusLabel(status)));
        // Refetch so counts, done_at and the server's ordering are the source
        // of truth rather than the optimistic copy above.
        await twBoardLoad();
        // The re-render replaced the select that had focus. Put it back on the
        // same task so a keyboard user can carry on from where they were.
        const moved = document.querySelector(`.tw-task[data-task-id="${twBoardAttr(id)}"] select`);
        if (moved) moved.focus();
    } catch (err) {
        // Reload first: twBoardLoad clears the status line it owns.
        await twBoardLoad();
        const message = t('tw_task_save_failed').replace('{msg}', err.message);
        twBoardSetStatusText(message, true);
        twBoardAnnounce(message);
    } finally {
        twBoardSaving = false;
    }
}

function twBoardOpenCreate() {
    twBoardOpenDialog(null);
}

function twBoardEdit(id) {
    const task = twBoardTaskOf(id);
    if (task) twBoardOpenDialog(task);
}

function twBoardSetQuadrantPick(quadrant) {
    document.querySelectorAll('input[name="board-task-priority"]').forEach(input => {
        input.checked = input.value === quadrant;
    });
}

function twBoardOpenDialog(task) {
    const dialog = document.getElementById('board-dialog');
    if (!dialog) return;
    const title = document.getElementById('board-dialog-title');
    if (title) title.textContent = task ? t('tw_task_edit') : t('tw_board_new');
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value == null ? '' : value;
    };
    set('board-task-id', task ? task.id : '');
    set('board-task-title', task ? task.title : '');
    set('board-task-note', task ? task.note : '');
    set('board-task-lane', task ? task.lane : (twBoardLane && twBoardLane !== TW_BOARD_LANE_NONE ? twBoardLane : ''));
    set('board-task-due', task ? task.due : '');
    set('board-task-due-time', task ? task.due_time : '');
    set('board-task-category', task ? task.category : '');
    set('board-task-status', (task && task.status) || 'todo');
    twBoardSetQuadrantPick((task && twBoardQuadrantOf(task)) || TW_BOARD_DEFAULT_QUADRANT);

    // Created/updated are derived by the server, so the dialog shows them read
    // only, and only for an existing task.
    const meta = document.getElementById('board-task-meta');
    const created = document.getElementById('board-task-created');
    const updated = document.getElementById('board-task-updated');
    if (created) created.textContent = task ? (twBoardStamp(task.created_at) || '—') : '—';
    if (updated) updated.textContent = task ? (twBoardStamp(task.updated_at) || '—') : '—';
    if (meta) meta.classList.toggle('hidden', !task);

    const status = document.getElementById('board-dialog-status');
    if (status) {
        status.textContent = '';
        status.classList.remove('is-error');
    }
    dialog.classList.remove('hidden');
    const input = document.getElementById('board-task-title');
    if (input) input.focus();
}

function twBoardCloseDialog() {
    const dialog = document.getElementById('board-dialog');
    if (dialog) dialog.classList.add('hidden');
}

async function twBoardSubmit(event) {
    if (event) event.preventDefault();
    if (twBoardSaving) return;
    const value = id => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };
    const id = value('board-task-id');
    const title = value('board-task-title');
    const status = document.getElementById('board-dialog-status');
    const fail = text => {
        if (status) {
            status.textContent = text;
            status.classList.add('is-error');
        }
    };
    if (!title) {
        fail(t('tw_task_title_required'));
        const input = document.getElementById('board-task-title');
        if (input) input.focus();
        return;
    }
    const due = value('board-task-due');
    const dueTime = value('board-task-due-time');
    // A time with no date has nothing to attach to; the server would drop it.
    if (dueTime && !due) {
        fail(t('tw_task_time_needs_due'));
        const input = document.getElementById('board-task-due');
        if (input) input.focus();
        return;
    }
    const picked = document.querySelector('input[name="board-task-priority"]:checked');
    const body = {
        title: title,
        note: value('board-task-note'),
        lane: value('board-task-lane'),
        due: due,
        due_time: dueTime,
        category: value('board-task-category'),
        priority: (picked && picked.value) || TW_BOARD_DEFAULT_QUADRANT,
        status: value('board-task-status') || 'todo',
    };
    twBoardSaving = true;
    try {
        if (id) await twBoardJSON('/api/tasks/update', Object.assign({ id: id }, body));
        else await twBoardJSON('/api/tasks', body);
        twBoardCloseDialog();
        twBoardSetStatusText('');
        twBoardAnnounce(id
            ? t('tw_task_updated').replace('{title}', title)
            : t('tw_task_created').replace('{title}', title));
        await twBoardLoad();
    } catch (err) {
        fail(t('tw_task_save_failed').replace('{msg}', err.message));
    } finally {
        twBoardSaving = false;
    }
}

function twBoardDelete(id) {
    const task = twBoardTaskOf(id);
    if (!task) return;
    const run = async () => {
        try {
            await twBoardJSON('/api/tasks/delete', { id: id });
            twBoardSetStatusText('');
            twBoardAnnounce(t('tw_task_deleted').replace('{title}', task.title));
            await twBoardLoad();
        } catch (err) {
            twBoardSetStatusText(t('tw_task_save_failed').replace('{msg}', err.message), true);
        }
    };
    if (typeof showConfirmDialog === 'function') {
        showConfirmDialog({
            title: t('tw_task_delete_title'),
            message: t('tw_task_delete_confirm').replace('{title}', task.title),
            okText: t('tw_delete'),
            cancelText: t('tw_cancel'),
            tone: 'danger',
            onConfirm: run,
        });
        return;
    }
    if (window.confirm(t('tw_task_delete_confirm').replace('{title}', task.title))) run();
}
