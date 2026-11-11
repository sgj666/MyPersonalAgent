/* Teacher workbench timetable: Monday–Friday × periods, one fixed slot per
   cell, plus dated one-off changes and cancellations that never touch the
   fixed table. The whole table is read and written with GET/PUT
   /api/teaching/timetable (docs/plans/teacher-academics.md §3).

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

const TW_TT_WEEKDAYS = [1, 2, 3, 4, 5];
// The store's enum (agent/teaching/store.py TIMETABLE_KINDS); labels are ours.
const TW_TT_KINDS = ['regular', 'morning', 'tutor', 'evening', 'after_school', 'research', 'duty'];
const TW_TT_DEFAULT_PERIODS = [
    { start: '08:00', end: '08:40' },
    { start: '08:50', end: '09:30' },
    { start: '10:00', end: '10:40' },
    { start: '10:50', end: '11:30' },
    { start: '14:00', end: '14:40' },
    { start: '14:50', end: '15:30' },
    { start: '15:50', end: '16:30' },
    { start: '16:40', end: '17:20' },
];

let twTtData = { periods: [], slots: [], overrides: [] };
let twTtClasses = [];
let twTtCell = null;
let twTtLoadToken = 0;
let twTtWired = false;
let twTtSaving = false;

function loadTimetableView() {
    if (!twTtWired) {
        twTtWired = true;
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') twTtCloseDialog();
        });
    }
    return twTtLoad();
}

function twTtKindLabel(kind) {
    const key = 'tw_tt_kind_' + kind;
    const label = t(key);
    return label === key ? kind : label;
}

function twTtWeekLabel(weekday) {
    const key = 'tw_tt_week_' + weekday;
    const label = t(key);
    return label === key ? String(weekday) : label;
}

function twTtClassOf(id) {
    return twTtClasses.find(c => c.id === id) || null;
}

function twTtClassName(id) {
    const cls = twTtClassOf(id);
    return cls ? (cls.name || '') : '';
}

function twTtSlotAt(weekday, period) {
    return twTtData.slots.find(s => Number(s.weekday) === Number(weekday)
        && Number(s.period) === Number(period)) || null;
}

function twTtLoad() {
    const token = ++twTtLoadToken;
    twAcadStatus('timetable-status', '');
    const grid = document.getElementById('tt-grid');
    if (grid && !twTtData.periods.length) {
        grid.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    }
    return Promise.all([
        twAcadJSON('/api/teaching/classes'),
        twAcadJSON('/api/teaching/timetable'),
    ]).then(([classesData, table]) => {
        if (token !== twTtLoadToken) return;
        twTtClasses = Array.isArray(classesData.classes) ? classesData.classes : [];
        twTtData = {
            periods: Array.isArray(table.periods) ? table.periods.slice() : [],
            slots: Array.isArray(table.slots) ? table.slots.slice() : [],
            overrides: Array.isArray(table.overrides) ? table.overrides.slice() : [],
        };
        if (!twTtData.periods.length) {
            // A first visit gets a usable grid in memory; nothing is written
            // until the teacher actually assigns a lesson.
            twTtData.periods = TW_TT_DEFAULT_PERIODS.map((p, i) => ({
                index: i + 1, start: p.start, end: p.end,
            }));
        }
        twTtRender();
    }).catch(err => {
        if (token !== twTtLoadToken) return;
        twAcadFail('timetable-status', err);
        if (grid) {
            grid.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                + `<button type="button" class="tw-btn" onclick="twTtLoad()">${escapeHtml(t('tw_retry'))}</button></div>`;
        }
    });
}

function twTtRender() {
    twTtRenderGrid();
    twTtRenderStats();
    twTtRenderOverrides();
}

function twTtRenderGrid() {
    const wrap = document.getElementById('tt-grid');
    if (!wrap) return;
    const note = document.getElementById('tt-week-note');
    if (note) {
        note.textContent = t('tw_tt_hours_note').replace('{n}', String(twTtData.slots.length));
    }
    if (!twTtData.periods.length) {
        wrap.innerHTML = `<div class="tw-empty"><i class="fas fa-table-cells" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_tt_empty_grid'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="twTtAddPeriod()">${escapeHtml(t('tw_tt_add_period'))}</button></div>`;
        return;
    }
    const head = `<thead><tr><th class="tw-tt-corner">${escapeHtml(t('tw_tt_period'))}</th>`
        + TW_TT_WEEKDAYS.map(w => `<th>${escapeHtml(twTtWeekLabel(w))}</th>`).join('')
        + '</tr></thead>';

    const body = twTtData.periods.slice()
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map(period => {
            const p = Number(period.index);
            const cells = TW_TT_WEEKDAYS.map(w => {
                const slot = twTtSlotAt(w, p);
                const cls = slot ? twTtClassName(slot.class_id) : '';
                const kind = slot ? (slot.kind || 'regular') : '';
                const label = [twTtWeekLabel(w), t('tw_tt_period_n').replace('{n}', String(p)), cls].join(' ');
                if (!slot) {
                    return `<td class="tw-tt-td"><button type="button" class="tw-tt-cell is-empty"
                            onclick="twTtOpenCell(${w}, ${p})" aria-label="${twAcadAttr(label + ' ' + t('tw_tt_cell_empty'))}">
                        <i class="fas fa-plus" aria-hidden="true"></i><span>${escapeHtml(t('tw_tt_cell_empty'))}</span>
                    </button></td>`;
                }
                return `<td class="tw-tt-td"><button type="button" class="tw-tt-cell is-${escapeHtml(kind)}"
                        onclick="twTtOpenCell(${w}, ${p})" aria-label="${twAcadAttr(label)}">
                    <b>${escapeHtml(cls || '—')}</b>
                    <small>${escapeHtml(slot.subject || twTtKindLabel(kind))}</small>
                    <span class="tw-tt-kind">${escapeHtml(twTtKindLabel(kind))}</span>
                </button></td>`;
            }).join('');
            return `<tr>
                <th class="tw-tt-period" scope="row">
                    <span>${escapeHtml(t('tw_tt_period_n').replace('{n}', String(p)))}</span>
                    <span class="tw-tt-times">
                        <input type="time" class="tw-input tw-input-time" value="${twAcadAttr(period.start || '')}"
                               data-period="${p}" data-edge="start" aria-label="${twAcadAttr(t('tw_tt_start'))}"
                               onchange="twTtTimeChanged(this)">
                        <input type="time" class="tw-input tw-input-time" value="${twAcadAttr(period.end || '')}"
                               data-period="${p}" data-edge="end" aria-label="${twAcadAttr(t('tw_tt_end'))}"
                               onchange="twTtTimeChanged(this)">
                    </span>
                </th>${cells}
            </tr>`;
        }).join('');

    wrap.innerHTML = `<table class="tw-tt"><caption class="tw-sr-only">${escapeHtml(t('tw_tt_week_title'))}</caption>${head}<tbody>${body}</tbody></table>`;
}

function twTtRenderStats() {
    const el = document.getElementById('tt-stats');
    if (!el) return;
    const rows = twTtClasses.map(cls => {
        const own = twTtData.slots.filter(s => s.class_id === cls.id);
        const normal = own.filter(s => (s.kind || 'regular') === 'regular').length;
        return { cls: cls, total: own.length, normal: normal, other: own.length - normal };
    }).sort((a, b) => b.total - a.total || String(a.cls.name || '').localeCompare(String(b.cls.name || ''), 'zh'));

    if (!rows.length) {
        el.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_tt_no_classes'))}</p>`;
        return;
    }
    el.innerHTML = `<div class="tw-table-wrap"><table class="tw-table tw-tt-stats-table">
        <thead><tr><th>${escapeHtml(t('tw_c_class'))}</th><th>${escapeHtml(t('tw_tt_kind_regular'))}</th>
            <th>${escapeHtml(t('tw_tt_other'))}</th><th>${escapeHtml(t('tw_tt_hours'))}</th></tr></thead>
        <tbody>${rows.map(row => `<tr${row.total ? '' : ' class="is-muted"'}>
            <td>${escapeHtml(row.cls.name || '')}</td>
            <td>${row.normal}</td><td>${row.other}</td>
            <td><b>${row.total}</b></td></tr>`).join('')}
        </tbody></table></div>`;
}

function twTtRenderOverrides() {
    const el = document.getElementById('tt-overrides');
    if (!el) return;
    const rows = twTtData.overrides.slice().sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) || Number(a.period) - Number(b.period));
    if (!rows.length) {
        el.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_tt_no_overrides'))}</p>`;
        return;
    }
    el.innerHTML = rows.map(ov => {
        const cancelled = ov.state === 'cancelled';
        const cls = twTtClassName(ov.class_id);
        return `<div class="tw-ov-item${cancelled ? ' is-cancelled' : ''}">
            <span class="tw-ov-date">${escapeHtml(ov.date || '')}</span>
            <span class="tw-ov-body">
                <b>${escapeHtml(t('tw_tt_period_n').replace('{n}', String(ov.period || '')))}</b>
                ${escapeHtml(cls || '—')}
                <small>${escapeHtml(cancelled ? t('tw_tt_cancelled') : (ov.subject || twTtKindLabel(ov.kind || 'normal')))}</small>
            </span>
            <button type="button" class="tw-icon-btn is-danger" onclick="twTtRemoveOverride('${twAcadAttr(ov.date || '')}', ${Number(ov.period) || 0})"
                    aria-label="${twAcadAttr(t('tw_tt_remove'))}" title="${twAcadAttr(t('tw_tt_remove'))}">
                <i class="fas fa-xmark" aria-hidden="true"></i>
            </button>
        </div>`;
    }).join('');
}

// ---------- writing ----------

function twTtSave() {
    if (twTtSaving) return Promise.resolve(false);
    twTtSaving = true;
    twAcadStatus('timetable-status', t('tw_tt_saving'));
    return twAcadJSON('/api/teaching/timetable', 'PUT', {
        periods: twTtData.periods,
        slots: twTtData.slots,
        overrides: twTtData.overrides,
    }).then(() => {
        twAcadStatus('timetable-status', t('tw_tt_saved'));
        return true;
    }).catch(err => {
        twAcadFail('timetable-status', err);
        return false;
    }).finally(() => { twTtSaving = false; });
}

function twTtNewId() {
    return 'ts_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function twTtTimeChanged(input) {
    const period = twTtData.periods.find(p => Number(p.index) === Number(input.dataset.period));
    if (!period) return;
    period[input.dataset.edge === 'end' ? 'end' : 'start'] = input.value;
    twTtSave();
}

function twTtAddPeriod() {
    const next = twTtData.periods.reduce((max, p) => Math.max(max, Number(p.index) || 0), 0) + 1;
    twTtData.periods.push({ index: next, start: '', end: '' });
    twTtRender();
    twTtSave();
}

function twTtDropPeriod() {
    if (twTtData.periods.length <= 1) return;
    const last = twTtData.periods.reduce((max, p) => Math.max(max, Number(p.index) || 0), 0);
    twTtData.periods = twTtData.periods.filter(p => Number(p.index) !== last);
    twTtData.slots = twTtData.slots.filter(s => Number(s.period) <= last - 1);
    twTtData.overrides = twTtData.overrides.filter(o => Number(o.period) <= last - 1);
    twTtRender();
    twTtSave();
}

function twTtRemoveOverride(date, period) {
    twTtData.overrides = twTtData.overrides.filter(o =>
        !(String(o.date) === String(date) && Number(o.period) === Number(period)));
    twTtRenderOverrides();
    twTtSave();
}

function twTtPrint() {
    window.print();
}

// ---------- cell dialog ----------

function twTtEnsureKindOptions() {
    const select = document.getElementById('tt-kind');
    if (!select || select.options.length) return;
    select.innerHTML = TW_TT_KINDS.map(kind =>
        `<option value="${kind}" data-i18n="tw_tt_kind_${kind}">${escapeHtml(twTtKindLabel(kind))}</option>`).join('');
}

function twTtRenderClassOptions(selected) {
    const select = document.getElementById('tt-class');
    if (!select) return;
    select.innerHTML = `<option value="">—</option>` + twTtClasses.map(cls =>
        `<option value="${twAcadAttr(cls.id)}">${escapeHtml(cls.name || '')}</option>`).join('');
    select.value = selected || '';
}

function twTtRenderSubjectOptions() {
    const list = document.getElementById('tt-subject-options');
    if (!list) return;
    const subjects = [...new Set(twTtClasses.map(c => c.subject).filter(Boolean))];
    list.innerHTML = subjects.map(s => `<option value="${twAcadAttr(s)}"></option>`).join('');
}

function twTtOpenCell(weekday, period) {
    twTtEnsureKindOptions();
    twTtCell = { weekday: Number(weekday), period: Number(period) };
    const slot = twTtSlotAt(weekday, period);
    twTtRenderClassOptions(slot ? slot.class_id : '');
    twTtRenderSubjectOptions();
    document.getElementById('tt-subject').value = slot ? (slot.subject || '') : '';
    document.getElementById('tt-kind').value = slot ? (slot.kind || 'regular') : 'regular';
    document.getElementById('tt-mode').value = 'fixed';
    document.getElementById('tt-date').value = twAcadToday();
    const where = document.getElementById('tt-dialog-where');
    if (where) {
        where.textContent = twTtWeekLabel(weekday) + ' · ' + t('tw_tt_period_n').replace('{n}', String(period));
    }
    twAcadStatus('tt-dialog-status', '');
    twTtModeChanged();
    const clear = document.querySelector('#tt-form .tw-tt-clear');
    if (clear) clear.disabled = !slot;
    document.getElementById('tt-dialog').classList.remove('hidden');
}

function twTtCloseDialog() {
    const dialog = document.getElementById('tt-dialog');
    if (dialog) dialog.classList.add('hidden');
    twTtCell = null;
}

function twTtModeChanged() {
    const mode = (document.getElementById('tt-mode') || {}).value || 'fixed';
    const field = document.getElementById('tt-date-field');
    if (field) field.classList.toggle('hidden', mode !== 'once');
    const cancel = document.querySelector('#tt-form .tw-tt-danger');
    if (cancel) cancel.classList.toggle('hidden', mode !== 'once');
    const clear = document.querySelector('#tt-form .tw-tt-clear');
    if (clear) clear.classList.toggle('hidden', mode !== 'fixed');
}

function twTtClassChanged() {
    const subject = document.getElementById('tt-subject');
    const cls = twTtClassOf((document.getElementById('tt-class') || {}).value || '');
    if (subject && cls && !subject.value) subject.value = cls.subject || '';
}

async function twTtSubmit(event) {
    if (event) event.preventDefault();
    if (!twTtCell) return;
    const classId = (document.getElementById('tt-class') || {}).value || '';
    const subject = (document.getElementById('tt-subject') || {}).value.trim();
    const kind = (document.getElementById('tt-kind') || {}).value || 'regular';
    const mode = (document.getElementById('tt-mode') || {}).value || 'fixed';
    if (!classId) {
        twAcadStatus('tt-dialog-status', t('tw_tt_pick_class'), true);
        return;
    }
    twAcadStatus('tt-dialog-status', '');
    if (mode === 'fixed') {
        const existing = twTtSlotAt(twTtCell.weekday, twTtCell.period);
        if (existing) {
            existing.class_id = classId;
            existing.subject = subject;
            existing.kind = kind;
        } else {
            twTtData.slots.push({
                id: twTtNewId(), class_id: classId, weekday: twTtCell.weekday,
                period: twTtCell.period, subject: subject, kind: kind,
            });
        }
        twTtCloseDialog();
        twTtRender();
        await twTtSave();
        return;
    }
    const date = (document.getElementById('tt-date') || {}).value || '';
    if (!date) {
        twAcadStatus('tt-dialog-status', t('tw_tt_pick_date'), true);
        return;
    }
    twTtData.overrides.push({
        date: date, period: twTtCell.period, class_id: classId,
        subject: subject, kind: kind, state: 'changed',
    });
    twTtCloseDialog();
    twTtRender();
    await twTtSave();
}

async function twTtClearCell() {
    if (!twTtCell) return;
    twTtData.slots = twTtData.slots.filter(s => !(Number(s.weekday) === twTtCell.weekday
        && Number(s.period) === twTtCell.period));
    twTtCloseDialog();
    twTtRender();
    await twTtSave();
}

async function twTtCancelSlot() {
    if (!twTtCell) return;
    const classId = (document.getElementById('tt-class') || {}).value || '';
    const date = (document.getElementById('tt-date') || {}).value || '';
    if (!date) {
        twAcadStatus('tt-dialog-status', t('tw_tt_pick_date'), true);
        return;
    }
    twTtData.overrides.push({
        date: date, period: twTtCell.period, class_id: classId,
        subject: '', kind: 'regular', state: 'cancelled',
    });
    twTtCloseDialog();
    twTtRender();
    await twTtSave();
}
