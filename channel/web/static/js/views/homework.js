/* Teacher workbench homework: one assignment can go to several classes; the
   due date defaults to the next lesson on the fixed timetable. Records are a
   per-student state block, PUT whole each time (docs/plans/teacher-academics.md
   §2-§3): submitted | excellent | fix | missing, blank when not recorded.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

const TW_HW_STATES = ['submitted', 'excellent', 'fix', 'missing'];

let twHwClasses = [];
let twHwItems = [];
let twHwRecordsAll = {};
let twHwTimetable = { slots: [] };
let twHwSelected = '';
let twHwStudents = [];
let twHwRecords = {};
let twHwLoadToken = 0;
let twHwWired = false;
let twHwSaving = false;
let twHwSaveQueued = false;
let twHwDueTouched = false;

function loadHomeworkView() {
    if (!twHwWired) {
        twHwWired = true;
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') twHwCloseDialogs();
        });
    }
    return twHwLoad();
}

function twHwCloseDialogs() {
    const dialog = document.getElementById('homework-dialog');
    if (dialog) dialog.classList.add('hidden');
}

function twHwLoad() {
    const token = ++twHwLoadToken;
    twAcadStatus('homework-status', '');
    const list = document.getElementById('homework-list');
    if (list && !twHwItems.length) {
        list.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    }
    return Promise.all([
        twAcadJSON('/api/teaching/classes'),
        twAcadJSON('/api/teaching/timetable'),
        twAcadJSON('/api/teaching/homework'),
    ]).then(([classesData, table, hw]) => {
        if (token !== twHwLoadToken) return;
        twHwClasses = Array.isArray(classesData.classes) ? classesData.classes : [];
        twHwTimetable = { slots: Array.isArray(table.slots) ? table.slots : [] };
        twHwItems = Array.isArray(hw.items) ? hw.items : [];
        twHwRecordsAll = hw.records && typeof hw.records === 'object' ? hw.records : {};
        if (!twHwItems.some(i => i.id === twHwSelected)) {
            twHwSelected = twHwItems.length ? twHwItems[0].id : '';
        }
        twHwRenderFilter();
        twHwRenderList();
        return twHwSelected ? twHwLoadRecords() : twHwRenderEmpty();
    }).catch(err => {
        if (token !== twHwLoadToken) return;
        twAcadFail('homework-status', err);
        if (list) {
            list.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                + `<button type="button" class="tw-btn" onclick="twHwLoad()">${escapeHtml(t('tw_retry'))}</button></div>`;
        }
    });
}

function twHwClassOf(id) {
    return twHwClasses.find(c => c.id === id) || null;
}

function twHwClassName(id) {
    const cls = twHwClassOf(id);
    return cls ? (cls.name || '') : '';
}

function twHwItem() {
    return twHwItems.find(i => i.id === twHwSelected) || null;
}

function twHwRenderFilter() {
    const select = document.getElementById('homework-filter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHtml(t('tw_hw_all_classes'))}</option>`
        + twHwClasses.map(cls => `<option value="${twAcadAttr(cls.id)}">${escapeHtml(cls.name || '')}</option>`).join('');
    select.value = twHwClasses.some(c => c.id === current) ? current : '';
}

function twHwFilteredItems() {
    const filter = (document.getElementById('homework-filter') || {}).value || '';
    return twHwItems
        .filter(item => !filter || (item.class_ids || []).indexOf(filter) !== -1)
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function twHwRenderList() {
    const list = document.getElementById('homework-list');
    if (!list) return;
    const visible = twHwFilteredItems();
    if (!twHwItems.length) {
        list.innerHTML = `<div class="tw-empty"><i class="fas fa-clipboard-check" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_hw_no_items'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="twHwOpenCreateDialog()">${escapeHtml(t('tw_hw_new'))}</button></div>`;
        return;
    }
    if (!visible.length) {
        list.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_hw_no_items'))}</p>`;
        return;
    }
    list.innerHTML = visible.map(item => {
        const names = (item.class_ids || []).map(twHwClassName).filter(Boolean).join('、');
        const due = item.due ? t('tw_hw_due_short').replace('{date}', item.due) : '';
        return `<div class="tw-acad-item${item.id === twHwSelected ? ' is-active' : ''}">
            <button type="button" class="tw-acad-item-main" onclick="twHwSelect('${twAcadAttr(item.id)}')">
                <b>${escapeHtml(item.title || t('tw_hw_untitled'))}</b>
                <small>${escapeHtml([names, due].filter(Boolean).join(' · '))}</small>
            </button>
        </div>`;
    }).join('');
}

function twHwSelect(id) {
    if (twHwSelected === id) return;
    twHwSelected = id;
    twHwRenderList();
    twHwLoadRecords();
}

function twHwRenderEmpty(err) {
    twHwStudents = [];
    twHwRecords = {};
    const body = document.getElementById('homework-body');
    const meta = document.getElementById('homework-meta');
    const rate = document.getElementById('homework-rate');
    const head = document.getElementById('homework-item-h');
    if (meta) meta.textContent = '';
    if (rate) rate.innerHTML = '';
    if (head) head.textContent = t('tw_hw_pick');
    ['homework-mark-rest', 'homework-copy-missing', 'homework-save', 'homework-delete'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
    });
    if (!body) return;
    body.innerHTML = err
        ? `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
            + `<button type="button" class="tw-btn" onclick="twHwLoad()">${escapeHtml(t('tw_retry'))}</button></div>`
        : `<div class="tw-empty"><i class="fas fa-clipboard-check" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_hw_pick_item'))}</p></div>`;
}

function twHwLoadRecords() {
    const item = twHwItem();
    if (!item) return twHwRenderEmpty();
    const token = ++twHwLoadToken;
    const body = document.getElementById('homework-body');
    if (body) body.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    const classIds = Array.isArray(item.class_ids) && item.class_ids.length
        ? item.class_ids : twHwClasses.map(c => c.id);
    return Promise.all(classIds.map(id =>
        twAcadJSON('/api/teaching/students?class_id=' + encodeURIComponent(id))
            .then(data => ({ classId: id, students: Array.isArray(data.students) ? data.students : [] }))
            .catch(() => ({ classId: id, students: [] }))
    )).then(groups => {
        if (token !== twHwLoadToken) return;
        const seen = new Set();
        twHwStudents = [];
        groups.forEach(group => group.students.forEach(stu => {
            if (seen.has(stu.id)) return;
            seen.add(stu.id);
            twHwStudents.push(Object.assign({}, stu, { class_id: stu.class_id || group.classId }));
        }));
        twHwStudents.sort((a, b) => {
            const ca = twHwClassName(a.class_id), cb = twHwClassName(b.class_id);
            return ca.localeCompare(cb, 'zh') || String(a.no || '').localeCompare(String(b.no || ''), 'zh');
        });
        const stored = twHwRecordsAll[item.id] || item.records || {};
        twHwRecords = Object.assign({}, stored);
        twHwRenderRecords();
    });
}

function twHwStateLabel(state) {
    const key = 'tw_hw_state_' + state;
    const label = t(key);
    return label === key ? state : label;
}

function twHwRenderRecords() {
    const item = twHwItem();
    const body = document.getElementById('homework-body');
    const meta = document.getElementById('homework-meta');
    const rate = document.getElementById('homework-rate');
    const head = document.getElementById('homework-item-h');
    if (!body || !item) return;
    const names = (item.class_ids || []).map(twHwClassName).filter(Boolean).join('、');
    if (head) head.textContent = item.title || t('tw_hw_untitled');
    if (meta) {
        meta.textContent = [names, item.due ? t('tw_hw_due_short').replace('{date}', item.due) : '',
            item.kind ? t('tw_hw_kind_' + item.kind) : ''].filter(Boolean).join(' · ');
    }
    const total = twHwStudents.length;
    const done = twHwStudents.filter(stu => {
        const st = twHwRecords[stu.id] || '';
        return st === 'submitted' || st === 'excellent';
    }).length;
    const percent = total ? Math.round(done / total * 100) : 0;
    if (rate) {
        rate.innerHTML = total
            ? `<span class="tw-hw-rate-num">${percent}%</span>
               <small>${escapeHtml(t('tw_hw_progress_line').replace('{a}', String(done)).replace('{b}', String(total)))}</small>`
            : '';
    }
    ['homework-mark-rest', 'homework-copy-missing', 'homework-save', 'homework-delete'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !total;
    });
    const save = document.getElementById('homework-save');
    if (save) save.disabled = !total;

    if (!total) {
        body.innerHTML = `<div class="tw-empty"><i class="fas fa-user-plus" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_hw_no_students'))}</p>`
            + `<button type="button" class="tw-btn" onclick="navigateTo('classes')">${escapeHtml(t('tw_hw_open_classes'))}</button></div>`;
        return;
    }

    body.innerHTML = `<div class="tw-table-wrap"><table class="tw-table tw-hw-table">
        <thead><tr>
            <th>${escapeHtml(t('tw_cls_no'))}</th>
            <th>${escapeHtml(t('tw_c_name'))}</th>
            <th>${escapeHtml(t('tw_c_class'))}</th>
            ${TW_HW_STATES.map(st => `<th>${escapeHtml(twHwStateLabel(st))}</th>`).join('')}
        </tr></thead>
        <tbody>${twHwStudents.map(stu => {
            const state = twHwRecords[stu.id] || '';
            return `<tr data-student-id="${twAcadAttr(stu.id)}" class="${state ? 'is-' + state : ''}">
                <td class="tw-mono">${escapeHtml(stu.no || '')}</td>
                <td>${escapeHtml(stu.name || '')}</td>
                <td class="tw-cell-note">${escapeHtml(twHwClassName(stu.class_id))}</td>
                ${TW_HW_STATES.map(st => `<td class="tw-hw-state-cell">
                    <button type="button" class="tw-hw-state is-${st}${state === st ? ' is-on' : ''}"
                            aria-pressed="${state === st ? 'true' : 'false'}"
                            onclick="twHwSetState('${twAcadAttr(stu.id)}', '${st}')">${escapeHtml(twHwStateLabel(st))}</button>
                </td>`).join('')}
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;
}

function twHwSetState(studentId, state) {
    if (!twHwItem()) return;
    if ((twHwRecords[studentId] || '') === state) return;
    twHwRecords[studentId] = state;
    twHwRenderRecords();
    twHwSaveRecords();
}

function twHwSaveRecords() {
    const item = twHwItem();
    if (!item) return Promise.resolve(false);
    // A click while a save is in flight would otherwise be lost: remember it
    // and run once more when the current request settles.
    if (twHwSaving) {
        twHwSaveQueued = true;
        return Promise.resolve(false);
    }
    // Blank rows are left out rather than sent: "not recorded" is the absence
    // of a state, and an empty string is not one of the four.
    const records = {};
    Object.keys(twHwRecords).forEach(sid => {
        const state = twHwRecords[sid];
        if (TW_HW_STATES.indexOf(state) !== -1) records[sid] = state;
    });
    twHwSaving = true;
    twAcadStatus('homework-status', '');
    return twAcadJSON('/api/teaching/homework/' + encodeURIComponent(item.id) + '/records', 'PUT', { records: records })
        .then(() => {
            twHwRecordsAll[item.id] = Object.assign({}, records);
            twAcadStatus('homework-status', t('tw_hw_saved'));
            return true;
        })
        .catch(err => {
            twAcadFail('homework-status', err);
            return false;
        })
        .finally(() => {
            twHwSaving = false;
            if (twHwSaveQueued) {
                twHwSaveQueued = false;
                twHwSaveRecords();
            }
        });
}

function twHwMarkRest() {
    if (!twHwItem() || !twHwStudents.length) return;
    twHwStudents.forEach(stu => {
        if (!twHwRecords[stu.id]) twHwRecords[stu.id] = 'submitted';
    });
    twHwRenderRecords();
    twHwSaveRecords();
}

function twHwMissingNames() {
    return twHwStudents
        .filter(stu => {
            const state = twHwRecords[stu.id] || '';
            return !state || state === 'missing';
        })
        .map(stu => [stu.no, stu.name].filter(Boolean).join(' '));
}

function twHwCopyMissing() {
    const item = twHwItem();
    if (!item) return;
    const names = twHwMissingNames();
    const text = (item.title || t('tw_hw_untitled')) + '\n'
        + t('tw_hw_missing_list') + '（' + names.length + '）：\n'
        + (names.length ? names.join('、') : t('tw_c_none'));
    twAcadCopy(text).then(ok => {
        twAcadStatus('homework-status', ok ? t('tw_hw_copied') : t('tw_c_copy_failed'), !ok);
    });
}

// ---------- create ----------

function twHwNextLesson(classId) {
    const slots = twHwTimetable.slots || [];
    if (!slots.some(s => s.class_id === classId)) return '';
    for (let i = 1; i <= 14; i++) {
        const date = twAcadAddDays(twAcadToday(), i);
        const weekday = twAcadWeekday(date);
        if (slots.some(s => s.class_id === classId && Number(s.weekday) === weekday)) return date;
    }
    return '';
}

function twHwRenderClassPicks() {
    const wrap = document.getElementById('homework-class-picks');
    if (!wrap) return;
    if (!twHwClasses.length) {
        wrap.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_tt_no_classes'))}</p>`;
        return;
    }
    wrap.innerHTML = twHwClasses.map(cls => {
        const next = twHwNextLesson(cls.id);
        const hint = next ? t('tw_hw_next_lesson').replace('{date}', next) : t('tw_hw_no_next_lesson');
        return `<label class="tw-hw-class-pick">
            <input type="checkbox" value="${twAcadAttr(cls.id)}" onchange="twHwClassPicked()">
            <span>${escapeHtml(cls.name || '')}</span>
            <small>${escapeHtml(hint)}</small>
        </label>`;
    }).join('');
}

function twHwPickedClasses() {
    return [...document.querySelectorAll('#homework-class-picks input:checked')].map(input => input.value);
}

function twHwDefaultDue() {
    const picked = twHwPickedClasses();
    if (!picked.length) return '';
    const dates = picked.map(twHwNextLesson).filter(Boolean).sort();
    return dates.length ? dates[0] : '';
}

function twHwClassPicked() {
    if (!twHwDueTouched) {
        const due = document.getElementById('homework-due-input');
        if (due) due.value = twHwDefaultDue();
    }
}

function twHwOpenCreateDialog() {
    twHwDueTouched = false;
    document.getElementById('homework-title-input').value = '';
    document.getElementById('homework-kind').value = 'homework';
    twHwRenderClassPicks();
    const filter = (document.getElementById('homework-filter') || {}).value || '';
    const boxes = [...document.querySelectorAll('#homework-class-picks input')];
    boxes.forEach(box => {
        box.checked = filter ? box.value === filter : false;
    });
    document.getElementById('homework-due-input').value = twHwDefaultDue();
    twAcadStatus('homework-dialog-status', '');
    document.getElementById('homework-dialog').classList.remove('hidden');
    document.getElementById('homework-title-input').focus();
}

async function twHwSubmitCreate(event) {
    if (event) event.preventDefault();
    const form = document.getElementById('homework-form');
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const title = document.getElementById('homework-title-input').value.trim();
    const classIds = twHwPickedClasses();
    const due = document.getElementById('homework-due-input').value || '';
    if (!title) {
        twAcadStatus('homework-dialog-status', t('tw_hw_missing_title'), true);
        return;
    }
    if (!classIds.length) {
        twAcadStatus('homework-dialog-status', t('tw_hw_pick_classes'), true);
        return;
    }
    try {
        const data = await twAcadJSON('/api/teaching/homework', 'POST', {
            title: title,
            kind: document.getElementById('homework-kind').value,
            class_ids: classIds,
            due: due,
        });
        const created = data.item && data.item.id ? data.item.id : (data.id || '');
        if (created) twHwSelected = created;
        document.getElementById('homework-dialog').classList.add('hidden');
        await twHwLoad();
    } catch (err) {
        twAcadFail('homework-dialog-status', err);
    }
}

function twHwDeleteItem() {
    const item = twHwItem();
    if (!item) return;
    showConfirmDialog({
        title: t('tw_hw_delete_title'),
        message: t('tw_hw_delete_msg').replace('{title}', item.title || ''),
        okText: t('tw_delete'),
        cancelText: t('tw_cancel'),
        tone: 'danger',
        onConfirm: async () => {
            try {
                await twAcadJSON('/api/teaching/homework?id=' + encodeURIComponent(item.id), 'DELETE', { id: item.id });
                twHwSelected = '';
                await twHwLoad();
            } catch (err) {
                twAcadFail('homework-status', err);
            }
        },
    });
}
