/* Teacher workbench task board: the four fixed status lanes, create/edit,
   drag or keyboard status changes, lane filter and due-date sort.

   The board API is per Agent (/api/tasks); the console's fetch wrapper adds
   the active agent_id to every request, so nothing here names one. These are
   classic scripts sharing one global scope; see channel/web/README.md before
   changing the load order. */

const TW_BOARD_STATUSES = ['todo', 'doing', 'blocked', 'done'];
const TW_BOARD_LANE_NONE = '__none__';

let twBoardTasks = [];
let twBoardLane = '';
let twBoardSortMode = 'due';
let twBoardLoadToken = 0;
let twBoardWired = false;
let twBoardDraggingId = '';
let twBoardSaving = false;

function twBoardToday() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function twBoardAttr(value) {
    return escapeHtml(String(value == null ? '' : value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function twBoardStatusLabel(status) {
    const key = 'tw_status_' + status;
    const label = t(key);
    return label === key ? status : label;
}

function twBoardPriorityLabel(priority) {
    const key = 'tw_priority_' + priority;
    const label = t(key);
    return label === key ? priority : label;
}

function twBoardIsOverdue(task) {
    return !!(task && task.due && task.status !== 'done' && task.due < twBoardToday());
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

function twBoardSorted(tasks) {
    const rows = tasks.slice();
    if (twBoardSortMode === 'created') {
        rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        return rows;
    }
    // Due first, soonest first; no-deadline rows last; ties by priority.
    const weight = { high: 0, normal: 1, low: 2 };
    rows.sort((a, b) => {
        if (a.due !== b.due) {
            if (!a.due) return 1;
            if (!b.due) return -1;
            return a.due.localeCompare(b.due);
        }
        const pa = weight[a.priority] == null ? 1 : weight[a.priority];
        const pb = weight[b.priority] == null ? 1 : weight[b.priority];
        if (pa !== pb) return pa - pb;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    return rows;
}

function twBoardVisibleTasks() {
    if (!twBoardLane) return twBoardTasks;
    if (twBoardLane === TW_BOARD_LANE_NONE) return twBoardTasks.filter(task => !task.lane);
    return twBoardTasks.filter(task => task.lane === twBoardLane);
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

function twBoardCard(task) {
    const overdue = twBoardIsOverdue(task);
    const dueChip = task.due
        ? `<span class="tw-chip ${overdue ? 'tw-chip-overdue' : 'tw-chip-due'}">`
            + `<i class="fas fa-calendar-day" aria-hidden="true"></i>${escapeHtml(task.due)}`
            + (overdue ? ` · ${escapeHtml(t('tw_task_overdue'))}` : '')
            + `</span>`
        : `<span class="tw-chip tw-chip-due">${escapeHtml(t('tw_task_none_due'))}</span>`;
    const laneChip = task.lane
        ? `<span class="tw-chip tw-chip-lane">${escapeHtml(task.lane)}</span>` : '';
    const prioChip = task.priority && task.priority !== 'normal'
        ? `<span class="tw-chip tw-chip-prio-${task.priority === 'high' ? 'high' : 'low'}">${escapeHtml(twBoardPriorityLabel(task.priority))}</span>`
        : '';
    const options = TW_BOARD_STATUSES.map(status =>
        `<option value="${status}"${status === task.status ? ' selected' : ''}>${escapeHtml(twBoardStatusLabel(status))}</option>`
    ).join('');
    return `<article class="tw-task${overdue ? ' is-overdue' : ''}" draggable="true" data-task-id="${twBoardAttr(task.id)}">
        <div class="tw-task-top">${prioChip}${dueChip}</div>
        <h3>${escapeHtml(task.title)}</h3>
        ${task.note ? `<p class="tw-task-note">${escapeHtml(task.note)}</p>` : ''}
        ${laneChip ? `<div class="tw-task-top" style="margin-top:8px">${laneChip}</div>` : ''}
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
    </article>`;
}

function twBoardRender() {
    twBoardRenderLaneOptions();
    const columns = document.getElementById('board-columns');
    const empty = document.getElementById('board-empty');
    const total = document.getElementById('board-total');
    if (!columns) return;
    if (total) total.textContent = t('tw_board_total').replace('{n}', String(twBoardTasks.length));
    // Four lanes are the board's shape, not a property of its contents: an
    // empty board still shows all four so a teacher can drop work into them.
    if (empty) empty.classList.add('hidden');
    columns.classList.remove('hidden');

    const visible = twBoardVisibleTasks();
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

function twBoardSetSort(mode) {
    twBoardSortMode = mode === 'created' ? 'created' : 'due';
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
    set('board-task-priority', (task && task.priority) || 'normal');
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
    if (!title) {
        if (status) {
            status.textContent = t('tw_task_title_required');
            status.classList.add('is-error');
        }
        const input = document.getElementById('board-task-title');
        if (input) input.focus();
        return;
    }
    const body = {
        title: title,
        note: value('board-task-note'),
        lane: value('board-task-lane'),
        due: value('board-task-due'),
        priority: value('board-task-priority') || 'normal',
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
        if (status) {
            status.textContent = t('tw_task_save_failed').replace('{msg}', err.message);
            status.classList.add('is-error');
        }
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
