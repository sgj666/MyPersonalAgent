/* Teacher workbench academics: shared API helper plus the classes & students
   view (class list, roster, paste import, add/edit/delete).

   The five academics views (classes, timetable, progress, homework, scores)
   all talk to /api/teaching/*, code to the contract in
   docs/plans/teacher-academics.md §3, and report a {status:"error",message}
   inline rather than throwing at the user. This file loads first, so the
   helpers at the top are the ones the other four call at run time.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

// ---------------------------------------------------------------------
// Shared helpers (used by all five academics views)
// ---------------------------------------------------------------------

/** One request against the teaching API. Resolves with the parsed body, throws
    an Error carrying the server's message -- the views catch it and print it
    in their own status line, so a failed call never blanks the page. */
async function twAcadJSON(url, method, body) {
    const init = { headers: { Accept: 'application/json' }, method: method || 'GET' };
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

/** For text that goes inside an attribute: escapeHtml leaves quotes alone. */
function twAcadAttr(value) {
    return escapeHtml(String(value == null ? '' : value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function twAcadPad(n) {
    return String(n).padStart(2, '0');
}

/** Local calendar date as yyyy-mm-dd; the APIs take dates, not instants. */
function twAcadToday() {
    const now = new Date();
    return `${now.getFullYear()}-${twAcadPad(now.getMonth() + 1)}-${twAcadPad(now.getDate())}`;
}

function twAcadAddDays(isoDate, days) {
    const parts = String(isoDate || '').split('-').map(Number);
    const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
    d.setDate(d.getDate() + (days || 0));
    return `${d.getFullYear()}-${twAcadPad(d.getMonth() + 1)}-${twAcadPad(d.getDate())}`;
}

/** Weekday as 1=Monday … 7=Sunday, which is what the timetable stores. */
function twAcadWeekday(isoDate) {
    const parts = String(isoDate || '').split('-').map(Number);
    const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
    return d.getDay() === 0 ? 7 : d.getDay();
}

function twAcadStatus(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
}

function twAcadFail(id, err) {
    twAcadStatus(id, (err && err.message) || t('tw_load_failed'), true);
}

/** Clipboard write with a selection fallback for browsers that refuse it. */
async function twAcadCopy(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* fall through to the textarea */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(area);
    return ok;
}

/** "标签1, 标签2" -> ['标签1', '标签2']; the tags field is stored as an array. */
function twAcadSplitTags(raw) {
    return String(raw || '').split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------
// Classes & students
// ---------------------------------------------------------------------

const TW_CLS_CLASS_HEADERS = {
    no: ['学号', '學號', 'no', 'id', '学籍号'],
    name: ['姓名', '名字', 'name', '学生', '學生'],
    gender: ['性别', '性別', 'gender', 'sex'],
    tags: ['标签', '標籤', 'tags', 'tag'],
    note: ['备注', '備註', 'note', 'remark'],
};

let twClsClasses = [];
let twClsStudents = [];
let twClsSelected = '';
let twClsLoadToken = 0;
let twClsWired = false;
let twClsImportRows = [];

function loadClassesView() {
    if (!twClsWired) {
        twClsWired = true;
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (document.querySelector('.tw-modal:not(.hidden)')) twClsCloseDialogs();
        });
    }
    return twClsLoad();
}

function twClsCloseDialogs() {
    ['class-dialog', 'student-dialog', 'import-dialog'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function twClsLoad() {
    const token = ++twClsLoadToken;
    twAcadStatus('classes-status', '');
    const list = document.getElementById('classes-list');
    if (list && !twClsClasses.length) {
        list.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    }
    return twAcadJSON('/api/teaching/classes')
        .then(data => {
            if (token !== twClsLoadToken) return;
            twClsClasses = Array.isArray(data.classes) ? data.classes : [];
            if (!twClsClasses.some(c => c.id === twClsSelected)) {
                twClsSelected = twClsClasses.length ? twClsClasses[0].id : '';
            }
            twClsRenderClasses();
            return twClsSelected ? twClsLoadStudents() : twClsRenderNoClass();
        })
        .catch(err => {
            if (token !== twClsLoadToken) return;
            twAcadFail('classes-status', err);
            if (list) {
                list.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                    + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                    + `<button type="button" class="tw-btn" onclick="twClsLoad()">${escapeHtml(t('tw_retry'))}</button></div>`;
            }
        });
}

function twClsCurrent() {
    return twClsClasses.find(c => c.id === twClsSelected) || null;
}

function twClsRenderClasses() {
    const list = document.getElementById('classes-list');
    const count = document.getElementById('classes-count');
    if (count) count.textContent = twClsClasses.length ? t('tw_c_count').replace('{n}', String(twClsClasses.length)) : '';
    if (!list) return;
    if (!twClsClasses.length) {
        list.innerHTML = `<div class="tw-empty"><i class="fas fa-users" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_cls_empty_classes'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="twClsOpenClassDialog()">${escapeHtml(t('tw_cls_new'))}</button></div>`;
        return;
    }
    list.innerHTML = twClsClasses.map(cls => {
        const meta = [cls.grade, cls.subject, cls.room].filter(Boolean).join(' · ');
        return `<div class="tw-acad-item${cls.id === twClsSelected ? ' is-active' : ''}" data-class-id="${twClsAttr(cls.id)}">
            <button type="button" class="tw-acad-item-main" onclick="twClsSelect('${twClsAttr(cls.id)}')">
                <b>${escapeHtml(cls.name || '')}</b>
                ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
            </button>
            <span class="tw-acad-item-actions">
                <button type="button" class="tw-icon-btn" onclick="twClsOpenClassDialog('${twClsAttr(cls.id)}')"
                        aria-label="${twClsAttr(t('tw_c_edit'))}" title="${twClsAttr(t('tw_c_edit'))}">
                    <i class="fas fa-pen" aria-hidden="true"></i>
                </button>
                <button type="button" class="tw-icon-btn is-danger" onclick="twClsDeleteClass('${twClsAttr(cls.id)}')"
                        aria-label="${twClsAttr(t('tw_delete'))}" title="${twClsAttr(t('tw_delete'))}">
                    <i class="fas fa-trash" aria-hidden="true"></i>
                </button>
            </span>
        </div>`;
    }).join('');
}

function twClsAttr(value) {
    return twAcadAttr(value);
}

function twClsSelect(id) {
    if (twClsSelected === id) return;
    twClsSelected = id;
    twClsRenderClasses();
    twClsLoadStudents();
}

function twClsRenderNoClass() {
    twClsStudents = [];
    const meta = document.getElementById('roster-meta');
    if (meta) meta.textContent = '';
    const add = document.getElementById('roster-add');
    const imp = document.getElementById('roster-import');
    if (add) add.disabled = true;
    if (imp) imp.disabled = true;
    const body = document.getElementById('roster-body');
    if (body) {
        body.innerHTML = `<div class="tw-empty"><i class="fas fa-users" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_cls_empty_classes'))}</p></div>`;
    }
    return Promise.resolve();
}

function twClsLoadStudents() {
    const token = ++twClsLoadToken;
    const body = document.getElementById('roster-body');
    if (body) body.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    const cls = twClsCurrent();
    if (!cls) return twClsRenderNoClass();
    return twAcadJSON('/api/teaching/students?class_id=' + encodeURIComponent(cls.id))
        .then(data => {
            if (token !== twClsLoadToken) return;
            twClsStudents = Array.isArray(data.students) ? data.students : [];
            twClsRenderRoster();
        })
        .catch(err => {
            if (token !== twClsLoadToken) return;
            twAcadFail('classes-status', err);
            if (body) {
                body.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                    + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                    + `<button type="button" class="tw-btn" onclick="twClsLoadStudents()">${escapeHtml(t('tw_retry'))}</button></div>`;
            }
        });
}

function twClsMatchesQuery(stu, query) {
    if (!query) return true;
    const hay = [stu.no, stu.name].map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
    return hay.indexOf(query) !== -1;
}

function twClsSortedStudents() {
    const query = String((document.getElementById('roster-search') || {}).value || '').trim().toLowerCase();
    const mode = (document.getElementById('roster-sort') || {}).value || 'no';
    return twClsStudents
        .filter(stu => twClsMatchesQuery(stu, query))
        .sort((a, b) => {
            const ka = mode === 'name' ? String(a.name || '') : String(a.no || '');
            const kb = mode === 'name' ? String(b.name || '') : String(b.no || '');
            // Numeric 学号 (01, 2, 10) must sort as numbers, not text.
            if (mode !== 'name' && /^\d+$/.test(ka) && /^\d+$/.test(kb)) {
                return Number(ka) - Number(kb);
            }
            return ka.localeCompare(kb, 'zh') || String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        });
}

function twClsRenderRoster() {
    const body = document.getElementById('roster-body');
    const meta = document.getElementById('roster-meta');
    const add = document.getElementById('roster-add');
    const imp = document.getElementById('roster-import');
    if (!body) return;
    const cls = twClsCurrent();
    const canEdit = !!cls;
    if (add) add.disabled = !canEdit;
    if (imp) imp.disabled = !canEdit;
    if (!cls) return twClsRenderNoClass();

    const rows = twClsSortedStudents();
    if (meta) {
        meta.textContent = t('tw_cls_count').replace('{n}', String(twClsStudents.length))
            + (cls.grade ? ' · ' + cls.grade : '');
    }
    if (!twClsStudents.length) {
        body.innerHTML = `<div class="tw-empty"><i class="fas fa-user-plus" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_cls_empty_roster'))}</p></div>`;
        return;
    }
    if (!rows.length) {
        body.innerHTML = `<div class="tw-empty"><i class="fas fa-magnifying-glass" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_cls_no_match'))}</p></div>`;
        return;
    }
    body.innerHTML = `<div class="tw-table-wrap"><table class="tw-table tw-roster-table">
        <thead><tr>
            <th>${escapeHtml(t('tw_cls_no'))}</th>
            <th>${escapeHtml(t('tw_c_name'))}</th>
            <th>${escapeHtml(t('tw_cls_gender'))}</th>
            <th>${escapeHtml(t('tw_cls_tags'))}</th>
            <th>${escapeHtml(t('tw_cls_note'))}</th>
            <th class="tw-col-actions">${escapeHtml(t('tw_cls_col_actions'))}</th>
        </tr></thead>
        <tbody>${rows.map(stu => `<tr data-student-id="${twClsAttr(stu.id)}">
            <td class="tw-mono">${escapeHtml(stu.no || '')}</td>
            <td><b>${escapeHtml(stu.name || '')}</b></td>
            <td>${escapeHtml(stu.gender || '')}</td>
            <td>${(Array.isArray(stu.tags) ? stu.tags : []).map(tag => `<span class="tw-chip">${escapeHtml(tag)}</span>`).join('')}</td>
            <td class="tw-cell-note">${escapeHtml(stu.note || '')}</td>
            <td class="tw-col-actions">
                <button type="button" class="tw-icon-btn" onclick="twClsOpenStudentDialog('${twClsAttr(stu.id)}')"
                        aria-label="${twClsAttr(t('tw_c_edit'))}" title="${twClsAttr(t('tw_c_edit'))}">
                    <i class="fas fa-pen" aria-hidden="true"></i>
                </button>
                <button type="button" class="tw-icon-btn is-danger" onclick="twClsDeleteStudent('${twClsAttr(stu.id)}')"
                        aria-label="${twClsAttr(t('tw_delete'))}" title="${twClsAttr(t('tw_delete'))}">
                    <i class="fas fa-trash" aria-hidden="true"></i>
                </button>
            </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

// ---------- class dialog ----------

function twClsOpenClassDialog(id) {
    const cls = id ? twClsClasses.find(c => c.id === id) : null;
    document.getElementById('class-id').value = cls ? cls.id : '';
    document.getElementById('class-name').value = cls ? (cls.name || '') : '';
    document.getElementById('class-grade').value = cls ? (cls.grade || '') : '';
    document.getElementById('class-subject').value = cls ? (cls.subject || '') : '';
    document.getElementById('class-room').value = cls ? (cls.room || '') : '';
    document.getElementById('class-dialog-title').textContent = t(cls ? 'tw_c_edit' : 'tw_cls_new');
    twAcadStatus('class-dialog-status', '');
    document.getElementById('class-dialog').classList.remove('hidden');
    document.getElementById('class-name').focus();
}

async function twClsSubmitClass(event) {
    if (event) event.preventDefault();
    const form = document.getElementById('class-form');
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const id = document.getElementById('class-id').value;
    const body = {
        name: document.getElementById('class-name').value.trim(),
        grade: document.getElementById('class-grade').value.trim(),
        subject: document.getElementById('class-subject').value.trim(),
        room: document.getElementById('class-room').value.trim(),
    };
    if (!body.name) {
        twAcadStatus('class-dialog-status', t('tw_cls_missing_name'), true);
        return;
    }
    if (id) body.id = id;
    twAcadStatus('class-dialog-status', '');
    try {
        await twAcadJSON('/api/teaching/classes', id ? 'PATCH' : 'POST', body);
        document.getElementById('class-dialog').classList.add('hidden');
        if (!id) twClsSelected = '';
        // Reload first: the loader clears the status line before it fetches.
        await twClsLoad();
        twAcadStatus('classes-status', t(id ? 'tw_c_saved' : 'tw_cls_class_created'));
    } catch (err) {
        twAcadFail('class-dialog-status', err);
    }
}

function twClsDeleteClass(id) {
    const cls = twClsClasses.find(c => c.id === id);
    if (!cls) return;
    showConfirmDialog({
        title: t('tw_cls_delete_class_title'),
        message: t('tw_cls_delete_class_msg').replace('{name}', cls.name || ''),
        okText: t('tw_delete'),
        cancelText: t('tw_cancel'),
        tone: 'danger',
        onConfirm: async () => {
            try {
                await twAcadJSON('/api/teaching/classes', 'DELETE', { id: id });
                if (twClsSelected === id) twClsSelected = '';
                await twClsLoad();
            } catch (err) {
                twAcadFail('classes-status', err);
            }
        },
    });
}

// ---------- student dialog ----------

function twClsOpenStudentDialog(id) {
    const stu = id ? twClsStudents.find(s => s.id === id) : null;
    if (!twClsCurrent()) return;
    document.getElementById('student-id').value = stu ? stu.id : '';
    document.getElementById('student-no').value = stu ? (stu.no || '') : '';
    document.getElementById('student-name').value = stu ? (stu.name || '') : '';
    document.getElementById('student-gender').value = stu ? (stu.gender || '') : '';
    document.getElementById('student-tags').value = stu && Array.isArray(stu.tags) ? stu.tags.join(', ') : '';
    document.getElementById('student-note').value = stu ? (stu.note || '') : '';
    document.getElementById('student-dialog-title').textContent = t(stu ? 'tw_c_edit' : 'tw_cls_new_student');
    twAcadStatus('student-dialog-status', '');
    document.getElementById('student-dialog').classList.remove('hidden');
    document.getElementById('student-name').focus();
}

function twClsStudentFromForm() {
    return {
        no: document.getElementById('student-no').value.trim(),
        name: document.getElementById('student-name').value.trim(),
        gender: document.getElementById('student-gender').value,
        tags: twAcadSplitTags(document.getElementById('student-tags').value),
        note: document.getElementById('student-note').value.trim(),
    };
}

async function twClsSubmitStudent(event) {
    if (event) event.preventDefault();
    const form = document.getElementById('student-form');
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const cls = twClsCurrent();
    if (!cls) return;
    const id = document.getElementById('student-id').value;
    const stu = twClsStudentFromForm();
    if (!stu.name) {
        twAcadStatus('student-dialog-status', t('tw_cls_missing_name'), true);
        return;
    }
    try {
        if (id) {
            await twAcadJSON('/api/teaching/students/' + encodeURIComponent(id), 'PATCH', stu);
        } else {
            await twAcadJSON('/api/teaching/students', 'POST', { class_id: cls.id, students: [stu] });
        }
        document.getElementById('student-dialog').classList.add('hidden');
        await twClsLoadStudents();
        twAcadStatus('classes-status', t('tw_cls_student_saved'));
    } catch (err) {
        twAcadFail('student-dialog-status', err);
    }
}

function twClsDeleteStudent(id) {
    const stu = twClsStudents.find(s => s.id === id);
    if (!stu) return;
    showConfirmDialog({
        title: t('tw_cls_delete_student_title'),
        message: t('tw_cls_delete_student_msg').replace('{name}', stu.name || ''),
        okText: t('tw_delete'),
        cancelText: t('tw_cancel'),
        tone: 'danger',
        onConfirm: async () => {
            try {
                await twAcadJSON('/api/teaching/students/' + encodeURIComponent(id), 'DELETE');
                await twClsLoadStudents();
            } catch (err) {
                twAcadFail('classes-status', err);
            }
        },
    });
}

// ---------- paste import ----------

function twClsOpenImportDialog() {
    if (!twClsCurrent()) return;
    twClsImportRows = [];
    document.getElementById('import-text').value = '';
    document.getElementById('import-preview').innerHTML = '';
    document.getElementById('import-submit').disabled = true;
    document.getElementById('import-submit').textContent = t('tw_cls_import');
    twAcadStatus('import-dialog-status', '');
    document.getElementById('import-dialog').classList.remove('hidden');
    document.getElementById('import-text').focus();
}

function twClsSplitRow(line) {
    if (line.indexOf('\t') !== -1) return line.split('\t');
    if (line.indexOf('，') !== -1 || line.indexOf(',') !== -1) {
        return line.split(/[,，]/);
    }
    // Fall back to two or more spaces, which is what a copied PDF table gives.
    return line.split(/\s{2,}/);
}

function twClsHeaderMap(cells) {
    const map = {};
    let hits = 0;
    cells.forEach((cell, index) => {
        const key = String(cell || '').trim().toLowerCase();
        if (!key) return;
        for (const field in TW_CLS_CLASS_HEADERS) {
            if (TW_CLS_CLASS_HEADERS[field].indexOf(key) !== -1) {
                map[field] = index;
                hits++;
                return;
            }
        }
    });
    return hits >= 2 ? map : null;
}

/** Parse Excel/CSV paste into students. Pure: the preview and the submit use
    the same rows, so what the teacher sees is what gets written. */
function twClsParseImport(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.replace(/\s+$/, '')).filter(line => line.trim());
    if (!lines.length) return [];
    let map = twClsHeaderMap(twClsSplitRow(lines[0]));
    let start = 0;
    if (map) start = 1;
    else map = { no: 0, name: 1 };
    const rows = [];
    for (let i = start; i < lines.length; i++) {
        const cells = twClsSplitRow(lines[i]).map(cell => cell.trim());
        if (!cells.join('')) continue;
        const pick = field => map[field] == null ? '' : String(cells[map[field]] || '').trim();
        let name = pick('name');
        let no = pick('no');
        if (!map.name && cells.length === 1) {
            // A single column is a name list; 学号 stays blank.
            name = cells[0];
            no = '';
        }
        if (!name && !no) continue;
        rows.push({
            no: no,
            name: name || no,
            gender: pick('gender'),
            tags: twAcadSplitTags(pick('tags')),
            note: pick('note'),
        });
    }
    return rows;
}

function twClsPreviewImport() {
    const rows = twClsParseImport(document.getElementById('import-text').value);
    twClsImportRows = rows;
    const preview = document.getElementById('import-preview');
    const submit = document.getElementById('import-submit');
    if (submit) {
        submit.disabled = !rows.length;
        submit.textContent = t('tw_cls_import') + ' ' + rows.length;
    }
    if (!preview) return;
    if (!rows.length) {
        preview.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_cls_import_none'))}</p>`;
        return;
    }
    preview.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_cls_preview'))}</p>`
        + `<div class="tw-table-wrap tw-import-table"><table class="tw-table"><thead><tr>`
        + `<th>${escapeHtml(t('tw_cls_no'))}</th><th>${escapeHtml(t('tw_c_name'))}</th>`
        + `<th>${escapeHtml(t('tw_cls_gender'))}</th><th>${escapeHtml(t('tw_cls_tags'))}</th><th>${escapeHtml(t('tw_cls_note'))}</th>`
        + `</tr></thead><tbody>${rows.map(row => `<tr>
            <td class="tw-mono">${escapeHtml(row.no)}</td><td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.gender)}</td><td>${escapeHtml(row.tags.join('、'))}</td>
            <td>${escapeHtml(row.note)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function twClsSubmitImport() {
    const cls = twClsCurrent();
    if (!cls || !twClsImportRows.length) return;
    const submit = document.getElementById('import-submit');
    if (submit) submit.disabled = true;
    twAcadStatus('import-dialog-status', '');
    try {
        const data = await twAcadJSON('/api/teaching/students', 'POST', {
            class_id: cls.id,
            students: twClsImportRows,
        });
        const n = Number(data.imported == null ? twClsImportRows.length : data.imported);
        document.getElementById('import-dialog').classList.add('hidden');
        await twClsLoadStudents();
        twAcadStatus('classes-status', t('tw_cls_import_result').replace('{n}', String(n)));
    } catch (err) {
        twAcadFail('import-dialog-status', err);
        if (submit) submit.disabled = false;
    }
}
