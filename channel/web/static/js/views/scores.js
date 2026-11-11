/* Teacher workbench scores: exam setup, a keyboard-driven score grid with
   block paste, and the analysis panel. A blank cell is an absence: it is sent
   as null and the server leaves it out of every average (documented in
   docs/plans/teacher-academics.md §2-§3).

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

let twScClasses = [];
let twScExams = [];
let twScSelected = '';
let twScClassName = '';
let twScStudents = [];
let twScScores = {};
let twScLoaded = false;
let twScTab = 'enter';
let twScLoadToken = 0;
let twScWired = false;
let twScDirty = false;

function loadScoresView() {
    if (!twScWired) {
        twScWired = true;
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') twScCloseDialogs();
        });
        const grid = document.getElementById('scores-grid');
        if (grid) {
            grid.addEventListener('keydown', twScGridKeydown);
            grid.addEventListener('paste', twScGridPaste);
        }
    }
    return twScLoad();
}

function twScCloseDialogs() {
    const dialog = document.getElementById('exam-dialog');
    if (dialog) dialog.classList.add('hidden');
}

function twScExam() {
    return twScExams.find(e => e.id === twScSelected) || null;
}

function twScClassOf(id) {
    return twScClasses.find(c => c.id === id) || null;
}

function twScClassNameOf(id) {
    const cls = twScClassOf(id);
    return cls ? (cls.name || '') : '';
}

function twScLoad() {
    const token = ++twScLoadToken;
    twAcadStatus('scores-status', '');
    const list = document.getElementById('scores-exam-list');
    if (list && !twScExams.length) {
        list.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    }
    return Promise.all([
        twAcadJSON('/api/teaching/classes'),
        twAcadJSON('/api/teaching/exams'),
    ]).then(([classesData, examsData]) => {
        if (token !== twScLoadToken) return;
        twScClasses = Array.isArray(classesData.classes) ? classesData.classes : [];
        twScExams = Array.isArray(examsData.exams) ? examsData.exams : [];
        if (!twScExams.some(e => e.id === twScSelected)) {
            twScSelected = twScExams.length ? twScExams[0].id : '';
        }
        twScRenderExamList();
        return twScSelected ? twScLoadEntry() : twScRenderEmpty();
    }).catch(err => {
        if (token !== twScLoadToken) return;
        twAcadFail('scores-status', err);
        if (list) {
            list.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                + `<button type="button" class="tw-btn" onclick="twScLoad()">${escapeHtml(t('tw_retry'))}</button></div>`;
        }
    });
}

function twScExamClassIds() {
    const exam = twScExam();
    const ids = exam && Array.isArray(exam.class_ids) ? exam.class_ids : [];
    return ids.length ? ids : twScClasses.map(c => c.id);
}

function twScRenderExamList() {
    const list = document.getElementById('scores-exam-list');
    if (!list) return;
    if (!twScExams.length) {
        list.innerHTML = `<div class="tw-empty"><i class="fas fa-file-pen" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_sc_no_exams'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="twScOpenExamDialog()">${escapeHtml(t('tw_sc_new'))}</button></div>`;
        return;
    }
    const rows = twScExams.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    list.innerHTML = rows.map(exam => {
        const names = (exam.class_ids || []).map(twScClassNameOf).filter(Boolean).join('、');
        const meta = [exam.date, names].filter(Boolean).join(' · ');
        return `<div class="tw-acad-item${exam.id === twScSelected ? ' is-active' : ''}">
            <button type="button" class="tw-acad-item-main" onclick="twScSelectExam('${twAcadAttr(exam.id)}')">
                <b>${escapeHtml(exam.name || '')}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
            </button>
        </div>`;
    }).join('');
}

function twScSelectExam(id) {
    if (twScSelected === id) return;
    twScSelected = id;
    twScDirty = false;
    twScRenderExamList();
    twScLoadEntry();
}

function twScRenderEmpty(err) {
    twScStudents = [];
    twScScores = {};
    twScLoaded = false;
    const meta = document.getElementById('scores-meta');
    const head = document.getElementById('scores-exam-h');
    const del = document.getElementById('scores-delete');
    const save = document.getElementById('scores-save');
    if (meta) meta.textContent = '';
    if (head) head.textContent = t('tw_sc_pick_exam');
    if (del) del.disabled = true;
    if (save) save.disabled = true;
    const grid = document.getElementById('scores-grid');
    if (grid) {
        grid.innerHTML = err
            ? `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `<p>${escapeHtml(err.message || t('tw_load_failed'))}</p>`
                + `<button type="button" class="tw-btn" onclick="twScLoad()">${escapeHtml(t('tw_retry'))}</button></div>`
            : `<div class="tw-empty"><i class="fas fa-table-cells" aria-hidden="true"></i>`
                + `<p>${escapeHtml(t('tw_sc_pick_exam'))}</p></div>`;
    }
}

function twScRenderClassSelect() {
    const select = document.getElementById('scores-class');
    if (!select) return;
    const ids = twScExamClassIds();
    select.innerHTML = ids.map(id => {
        const cls = twScClassOf(id);
        return `<option value="${twAcadAttr(id)}">${escapeHtml(cls ? (cls.name || '') : id)}</option>`;
    }).join('');
    select.value = ids.indexOf(twScClassName) !== -1 ? twScClassName : (ids[0] || '');
    twScClassName = select.value;
}

function twScLoadEntry() {
    const token = ++twScLoadToken;
    const exam = twScExam();
    if (!exam) return twScRenderEmpty();
    twScRenderClassSelect();
    if (!twScClassName) return twScRenderEmpty(new Error(t('tw_sc_class_not_in_exam')));
    const grid = document.getElementById('scores-grid');
    if (grid) grid.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    twAcadStatus('scores-status', '');
    const studentsUrl = '/api/teaching/students?class_id=' + encodeURIComponent(twScClassName);
    const scoresUrl = '/api/teaching/scores/' + encodeURIComponent(exam.id)
        + '?class_id=' + encodeURIComponent(twScClassName);
    return Promise.all([
        twAcadJSON(studentsUrl),
        // The contract names the score resource for writing; the read half of
        // the same resource is what an edit view needs. A server that does not
        // answer it yet still leaves the grid usable for entry.
        twAcadJSON(scoresUrl).then(data => data.scores || data.by_student || {}).catch(() => null),
    ]).then(([studentsData, scores]) => {
        if (token !== twScLoadToken) return;
        twScStudents = Array.isArray(studentsData.students) ? studentsData.students : [];
        twScStudents.sort((a, b) => String(a.no || '').localeCompare(String(b.no || ''), 'zh'));
        twScScores = scores && typeof scores === 'object' ? scores : {};
        twScLoaded = scores !== null;
        twScRenderGrid();
    }).catch(err => {
        if (token !== twScLoadToken) return;
        twAcadFail('scores-status', err);
        twScRenderEmpty(err);
    });
}

function twScClassChanged() {
    const select = document.getElementById('scores-class');
    twScClassName = select ? select.value : '';
    twScLoadEntry();
}

function twScGridColumns() {
    const exam = twScExam();
    const items = exam && Array.isArray(exam.items) ? exam.items : [];
    return items.map(item => ({ key: item.key, label: item.label || item.key, full: item.full }))
        .concat([{ key: 'total', label: t('tw_sc_total'), full: exam ? exam.full_score : '' }]);
}

function twScScoreOf(studentId) {
    return twScScores[studentId] || {};
}

function twScRenderGrid() {
    const exam = twScExam();
    const grid = document.getElementById('scores-grid');
    if (!exam || !grid) return;
    const meta = document.getElementById('scores-meta');
    const head = document.getElementById('scores-exam-h');
    const del = document.getElementById('scores-delete');
    const save = document.getElementById('scores-save');
    if (head) head.textContent = exam.name || '';
    if (meta) {
        meta.textContent = [
            exam.date || '',
            exam.subject || '',
            t('tw_sc_full_value').replace('{n}', String(exam.full_score == null ? '' : exam.full_score)),
            t('tw_hw_classes') + '：' + (exam.class_ids || []).map(twScClassNameOf).filter(Boolean).join('、'),
        ].filter(Boolean).join(' · ');
    }
    if (del) del.disabled = false;
    if (save) save.disabled = !twScStudents.length || !twScLoaded;

    if (!twScStudents.length) {
        grid.innerHTML = `<div class="tw-empty"><i class="fas fa-user-plus" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_hw_no_students'))}</p>`
            + `<button type="button" class="tw-btn" onclick="navigateTo('classes')">${escapeHtml(t('tw_hw_open_classes'))}</button></div>`;
        return;
    }
    const columns = twScGridColumns();
    const headCells = columns.map(col => `<th>${escapeHtml(col.label)}`
        + (col.full !== undefined && col.full !== '' ? `<small> / ${escapeHtml(String(col.full))}</small>` : '')
        + '</th>').join('');
    grid.innerHTML = `<div class="tw-table-wrap"><table class="tw-table tw-sc-table">
        <thead><tr>
            <th>${escapeHtml(t('tw_cls_no'))}</th>
            <th>${escapeHtml(t('tw_c_name'))}</th>
            ${headCells}
        </tr></thead>
        <tbody>${twScStudents.map((stu, row) => {
            const score = twScScoreOf(stu.id);
            const items = score.items && typeof score.items === 'object' ? score.items : {};
            const cells = columns.map((col, colIndex) => {
                const value = col.key === 'total' ? score.total : items[col.key];
                return `<td class="tw-sc-cell">
                    <input class="tw-input tw-sc-input" inputmode="decimal" autocomplete="off"
                           data-sid="${twAcadAttr(stu.id)}" data-key="${twAcadAttr(col.key)}"
                           data-row="${row}" data-col="${colIndex}"
                           value="${value == null ? '' : twAcadAttr(value)}"
                           oninput="twScDirty = true"
                           aria-label="${twAcadAttr((stu.name || '') + ' ' + col.label)}">
                </td>`;
            }).join('');
            return `<tr><td class="tw-mono">${escapeHtml(stu.no || '')}</td><td>${escapeHtml(stu.name || '')}</td>${cells}</tr>`;
        }).join('')}</tbody>
    </table></div>`
        + (twScLoaded ? '' : `<p class="tw-status is-error">${escapeHtml(t('tw_sc_scores_unreadable'))}</p>`);
}

// ---------- keyboard + block paste ----------

function twScInputAt(row, col) {
    return document.querySelector(`#scores-grid .tw-sc-input[data-row="${row}"][data-col="${col}"]`);
}

function twScGridKeydown(e) {
    const input = e.target.closest('.tw-sc-input');
    if (!input) return;
    const row = Number(input.dataset.row);
    const col = Number(input.dataset.col);
    const focus = (next) => {
        if (!next) return false;
        next.focus();
        if (typeof next.select === 'function') next.select();
        return true;
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
        if (focus(twScInputAt(row + 1, col))) e.preventDefault();
    } else if (e.key === 'ArrowUp') {
        if (focus(twScInputAt(row - 1, col))) e.preventDefault();
    } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) {
        if (focus(twScInputAt(row, col + 1))) e.preventDefault();
    } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
        if (focus(twScInputAt(row, col - 1))) e.preventDefault();
    }
}

function twScPasteRows(text) {
    const rows = String(text || '').replace(/\r/g, '').split('\n')
        .map(line => line.replace(/\s+$/, ''))
        .filter(line => line.trim().length);
    // The first row of an Excel copy often carries the column names.
    if (rows.length && /姓名|學號|学号|总分|總分|name|total/i.test(rows[0]) && /\t/.test(rows[0])) {
        rows.shift();
    }
    return rows.map(line => line.indexOf('\t') !== -1 ? line.split('\t') : line.split(/[,，]/));
}

function twScGridPaste(e) {
    const input = e.target.closest('.tw-sc-input');
    if (!input) return;
    const clipboard = e.clipboardData || window.clipboardData;
    if (!clipboard) return;
    const text = clipboard.getData('text');
    if (!text) return;
    const matrix = twScPasteRows(text);
    if (!matrix.length) return;
    const startRow = Number(input.dataset.row);
    const startCol = Number(input.dataset.col);
    matrix.forEach((cells, dr) => {
        cells.forEach((raw, dc) => {
            const target = twScInputAt(startRow + dr, startCol + dc);
            if (target) target.value = String(raw || '').trim();
        });
    });
    twScDirty = true;
    e.preventDefault();
}

// ---------- saving ----------

function twScNumberOrNull(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    const n = Number(text);
    return isFinite(n) ? n : null;
}

function twScSaveScores() {
    const exam = twScExam();
    if (!exam || !twScStudents.length) return Promise.resolve(false);
    if (!twScLoaded) {
        twAcadStatus('scores-status', t('tw_sc_scores_unreadable'), true);
        return Promise.resolve(false);
    }
    const columns = twScGridColumns().filter(col => col.key !== 'total');
    const scores = {};
    twScStudents.forEach((stu, row) => {
        const entry = { items: {} };
        let itemSum = 0;
        let anyItem = false;
        columns.forEach((col, index) => {
            const el = twScInputAt(row, index);
            const value = twScNumberOrNull(el ? el.value : '');
            entry.items[col.key] = value;
            if (value !== null) {
                itemSum += value;
                anyItem = true;
            }
        });
        const totalEl = twScInputAt(row, columns.length);
        let total = twScNumberOrNull(totalEl ? totalEl.value : '');
        // A teacher who filled the items but not the total gets the sum, which
        // is what the exam's full score means when the items cover it.
        if (total === null && anyItem) total = Math.round(itemSum * 100) / 100;
        entry.total = total;
        scores[stu.id] = entry;
    });
    twAcadStatus('scores-status', '');
    return twAcadJSON('/api/teaching/scores/' + encodeURIComponent(exam.id), 'PUT', {
        class_id: twScClassName,
        scores: scores,
    }).then(() => {
        twScDirty = false;
        twAcadStatus('scores-status', t('tw_sc_saved'));
        return true;
    }).catch(err => {
        twAcadFail('scores-status', err);
        return false;
    });
}

// ---------- analysis ----------

function twScSwitchTab(kind) {
    twScTab = kind === 'analysis' ? 'analysis' : 'enter';
    const enter = document.getElementById('scores-enter-panel');
    const analysis = document.getElementById('scores-analysis-panel');
    const enterSeg = document.getElementById('scores-seg-enter');
    const analysisSeg = document.getElementById('scores-seg-analysis');
    if (enter) enter.classList.toggle('hidden', twScTab !== 'enter');
    if (analysis) analysis.classList.toggle('hidden', twScTab !== 'analysis');
    if (enterSeg) enterSeg.setAttribute('aria-selected', twScTab === 'enter' ? 'true' : 'false');
    if (analysisSeg) analysisSeg.setAttribute('aria-selected', twScTab === 'analysis' ? 'true' : 'false');
    if (twScTab === 'analysis') twScLoadAnalysis();
}

function twScPercent(value) {
    const n = Number(value);
    if (!isFinite(n) || value === null || value === '') return null;
    return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function twScRateText(value) {
    const p = twScPercent(value);
    return p === null ? '—' : p + '%';
}

function twScNumText(value) {
    const n = Number(value);
    return isFinite(n) && value !== null && value !== '' ? String(Math.round(n * 100) / 100) : '—';
}

function twScMetric(label, value) {
    return `<div class="tw-metric tw-metric-c"><span class="tw-metric-label">${escapeHtml(label)}</span>`
        + `<b>${escapeHtml(value)}</b></div>`;
}

function twScTrendValues(entry) {
    const history = entry.history || entry.trend || entry.exams || entry.scores || [];
    if (!Array.isArray(history)) return [];
    return history.map(h => {
        if (h == null) return null;
        if (typeof h === 'number' || typeof h === 'string') return twScNumText(h);
        const value = h.total != null ? h.total : (h.score != null ? h.score : h.value);
        return value == null ? null : twScNumText(value);
    }).filter(v => v !== null && v !== '—');
}

function twScLoadAnalysis() {
    const exam = twScExam();
    const panel = document.getElementById('scores-analysis');
    if (!panel) return;
    if (!exam) {
        panel.innerHTML = `<div class="tw-empty"><i class="fas fa-chart-simple" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_sc_analysis_empty'))}</p></div>`;
        return;
    }
    panel.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    const url = '/api/teaching/analysis?exam_id=' + encodeURIComponent(exam.id)
        + '&class_id=' + encodeURIComponent(twScClassName || '');
    return twAcadJSON(url)
        .then(data => twScRenderAnalysis(data))
        .catch(err => {
            panel.innerHTML = `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
                + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
                + `<p class="tw-hint">${escapeHtml(err && err.message ? err.message : '')}</p>`
                + `<button type="button" class="tw-btn" onclick="twScLoadAnalysis()">${escapeHtml(t('tw_retry'))}</button></div>`;
        });
}

function twScRenderAnalysis(data) {
    const panel = document.getElementById('scores-analysis');
    if (!panel) return;
    const summary = (data.summary && typeof data.summary === 'object') ? data.summary : data;
    const metrics = [];
    const avg = summary.avg != null ? summary.avg : summary.average;
    if (avg != null) metrics.push(twScMetric(t('tw_sc_avg'), twScNumText(avg)));
    if (summary.pass_rate != null) metrics.push(twScMetric(t('tw_sc_pass_rate'), twScRateText(summary.pass_rate)));
    if (summary.excellent_rate != null) metrics.push(twScMetric(t('tw_sc_excellent_rate'), twScRateText(summary.excellent_rate)));
    const std = summary.std != null ? summary.std : summary.stdev;
    if (std != null) metrics.push(twScMetric(t('tw_sc_std'), twScNumText(std)));
    const count = summary.count != null ? summary.count : summary.n;
    if (count != null) metrics.push(twScMetric(t('tw_sc_count'), t('tw_sc_count_value').replace('{n}', String(count))));
    if (summary.max != null) metrics.push(twScMetric(t('tw_sc_max'), twScNumText(summary.max)));
    if (summary.min != null) metrics.push(twScMetric(t('tw_sc_min'), twScNumText(summary.min)));

    const byClass = Array.isArray(data.by_class) ? data.by_class : [];
    const items = Array.isArray(data.items) ? data.items : [];
    const critical = Array.isArray(data.critical) ? data.critical : [];
    const students = Array.isArray(data.students) ? data.students : [];

    if (!metrics.length && !byClass.length && !items.length && !critical.length && !students.length) {
        panel.innerHTML = `<div class="tw-empty"><i class="fas fa-chart-simple" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_sc_no_scores'))}</p></div>`;
        return;
    }

    let html = '';
    if (metrics.length) {
        html += `<h3 class="tw-sc-section-h">${escapeHtml(t('tw_sc_summary'))}</h3>`
            + `<div class="tw-metrics tw-sc-metrics">${metrics.join('')}</div>`;
    }
    if (byClass.length) {
        html += `<h3 class="tw-sc-section-h">${escapeHtml(t('tw_sc_by_class'))}</h3>`
            + `<div class="tw-table-wrap"><table class="tw-table"><thead><tr>`
            + `<th>${escapeHtml(t('tw_c_class'))}</th><th>${escapeHtml(t('tw_sc_avg'))}</th>`
            + `<th>${escapeHtml(t('tw_sc_pass_rate'))}</th><th>${escapeHtml(t('tw_sc_excellent_rate'))}</th>`
            + `<th>${escapeHtml(t('tw_sc_count'))}</th></tr></thead><tbody>`
            + byClass.map(row => {
                const name = row.name || row.class_name || twScClassNameOf(row.class_id) || '—';
                return `<tr><td>${escapeHtml(name)}</td><td>${twScNumText(row.avg != null ? row.avg : row.average)}</td>`
                    + `<td>${twScRateText(row.pass_rate)}</td><td>${twScRateText(row.excellent_rate)}</td>`
                    + `<td>${row.count != null ? row.count : (row.n != null ? row.n : '—')}</td></tr>`;
            }).join('') + `</tbody></table></div>`;
    }
    if (items.length) {
        html += `<h3 class="tw-sc-section-h">${escapeHtml(t('tw_sc_items_rate'))}</h3>`
            + `<div class="tw-sc-item-rates">${items.map(item => {
                const rate = twScPercent(item.rate != null ? item.rate : item.score_rate);
                const width = rate === null ? 0 : Math.max(0, Math.min(100, rate));
                const label = item.label || item.key || '';
                return `<div class="tw-sc-rate-row">
                    <span class="tw-sc-rate-label">${escapeHtml(label)}</span>
                    <span class="tw-pr-bar"><span style="width:${width}%"></span></span>
                    <b>${rate === null ? '—' : rate + '%'}</b>
                    <small>${item.full != null ? escapeHtml(String(item.full)) : ''}</small>
                </div>`;
            }).join('')}</div>`;
    }
    if (critical.length) {
        html += `<h3 class="tw-sc-section-h">${escapeHtml(t('tw_sc_critical'))}</h3>`
            + `<div class="tw-table-wrap"><table class="tw-table"><thead><tr>`
            + `<th>${escapeHtml(t('tw_sc_student'))}</th><th>${escapeHtml(t('tw_c_class'))}</th>`
            + `<th>${escapeHtml(t('tw_sc_total'))}</th><th>${escapeHtml(t('tw_sc_reason'))}</th>`
            + `</tr></thead><tbody>${critical.map(row => {
                const name = row.name || row.student_name || '';
                const cls = row.class_name || twScClassNameOf(row.class_id);
                return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(cls)}</td>`
                    + `<td>${twScNumText(row.score != null ? row.score : row.total)}</td>`
                    + `<td>${escapeHtml(row.reason || '')}</td></tr>`;
            }).join('')}</tbody></table></div>`;
    }
    if (students.length) {
        html += `<h3 class="tw-sc-section-h">${escapeHtml(t('tw_sc_students'))}</h3>`
            + `<div class="tw-table-wrap"><table class="tw-table"><thead><tr>`
            + `<th>${escapeHtml(t('tw_sc_student'))}</th><th>${escapeHtml(t('tw_sc_last'))}</th>`
            + `<th>${escapeHtml(t('tw_sc_delta'))}</th><th>${escapeHtml(t('tw_sc_history'))}</th>`
            + `</tr></thead><tbody>${students.map(row => {
                const name = row.name || row.student_name || '';
                const trend = twScTrendValues(row);
                const last = row.last != null ? row.last : (row.total != null ? row.total : (trend.length ? trend[trend.length - 1] : null));
                const delta = row.delta != null ? row.delta : row.change;
                const deltaText = delta == null ? '—' : (Number(delta) > 0 ? '+' : '') + twScNumText(delta);
                return `<tr><td>${escapeHtml(name)}</td><td>${last == null ? '—' : escapeHtml(String(last))}</td>`
                    + `<td class="${Number(delta) < 0 ? 'tw-sc-down' : ''}">${escapeHtml(deltaText)}</td>`
                    + `<td class="tw-mono">${escapeHtml(trend.join(' / ') || '—')}</td></tr>`;
            }).join('')}</tbody></table></div>`;
    }
    panel.innerHTML = html;
}

// ---------- exam dialog ----------

function twScRenderExamClassPicks() {
    const wrap = document.getElementById('exam-class-picks');
    if (!wrap) return;
    wrap.innerHTML = twScClasses.map(cls => `<label class="tw-hw-class-pick">
        <input type="checkbox" value="${twAcadAttr(cls.id)}">
        <span>${escapeHtml(cls.name || '')}</span>
        <small>${escapeHtml([cls.grade, cls.subject].filter(Boolean).join(' · '))}</small>
    </label>`).join('');
}

function twScAddItemRow(key, label, full) {
    const box = document.getElementById('exam-items-box');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'tw-sc-item-row';
    row.innerHTML = `<input class="tw-input exam-item-key" type="text" maxlength="20" placeholder="key"
                        aria-label="${twAcadAttr(t('tw_sc_item_key'))}" value="${twAcadAttr(key || '')}">
        <input class="tw-input exam-item-label" type="text" maxlength="40"
                        aria-label="${twAcadAttr(t('tw_sc_item_label'))}" value="${twAcadAttr(label || '')}">
        <input class="tw-input exam-item-full" type="number" min="0" max="1000" placeholder="0"
                        aria-label="${twAcadAttr(t('tw_sc_item_full'))}" value="${twAcadAttr(full == null ? '' : full)}">
        <button type="button" class="tw-icon-btn is-danger" onclick="twScRemoveItemRow(this)"
                aria-label="${twAcadAttr(t('tw_delete'))}" title="${twAcadAttr(t('tw_delete'))}">
            <i class="fas fa-xmark" aria-hidden="true"></i>
        </button>`;
    box.appendChild(row);
    const keyInput = row.querySelector('.exam-item-key');
    if (keyInput && !key) keyInput.value = 'i' + (box.children.length);
}

function twScRemoveItemRow(button) {
    const row = button.closest('.tw-sc-item-row');
    if (row) row.remove();
}

function twScOpenExamDialog() {
    document.getElementById('exam-name').value = '';
    document.getElementById('exam-date').value = twAcadToday();
    document.getElementById('exam-subject').value = twScClasses.length ? (twScClasses[0].subject || '') : '';
    document.getElementById('exam-full-score').value = '100';
    document.getElementById('exam-items-box').innerHTML = '';
    twScRenderExamClassPicks();
    twAcadStatus('exam-dialog-status', '');
    document.getElementById('exam-dialog').classList.remove('hidden');
    document.getElementById('exam-name').focus();
}

function twScExamItems() {
    const rows = [...document.querySelectorAll('#exam-items-box .tw-sc-item-row')];
    const seen = new Set();
    return rows.map((row, index) => {
        const label = row.querySelector('.exam-item-label').value.trim();
        let key = row.querySelector('.exam-item-key').value.trim();
        const full = Number(row.querySelector('.exam-item-full').value);
        if (!label) return null;
        if (!key) key = 'i' + (index + 1);
        while (seen.has(key)) key = key + '_' + (index + 1);
        seen.add(key);
        return { key: key, label: label, full: isFinite(full) ? full : 0 };
    }).filter(Boolean);
}

async function twScSubmitExam(event) {
    if (event) event.preventDefault();
    const form = document.getElementById('exam-form');
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const name = document.getElementById('exam-name').value.trim();
    const classIds = [...document.querySelectorAll('#exam-class-picks input:checked')].map(i => i.value);
    if (!name) {
        twAcadStatus('exam-dialog-status', t('tw_sc_missing_name'), true);
        return;
    }
    if (!classIds.length) {
        twAcadStatus('exam-dialog-status', t('tw_hw_pick_classes'), true);
        return;
    }
    try {
        const data = await twAcadJSON('/api/teaching/exams', 'POST', {
            name: name,
            date: document.getElementById('exam-date').value || '',
            subject: document.getElementById('exam-subject').value.trim(),
            class_ids: classIds,
            full_score: Number(document.getElementById('exam-full-score').value) || 100,
            items: twScExamItems(),
        });
        const created = data.exam && data.exam.id ? data.exam.id : (data.id || '');
        if (created) {
            twScSelected = created;
            twScClassName = classIds[0];
        }
        document.getElementById('exam-dialog').classList.add('hidden');
        await twScLoad();
    } catch (err) {
        twAcadFail('exam-dialog-status', err);
    }
}

function twScDeleteExam() {
    const exam = twScExam();
    if (!exam) return;
    showConfirmDialog({
        title: t('tw_sc_delete_title'),
        message: t('tw_sc_delete_msg').replace('{name}', exam.name || ''),
        okText: t('tw_delete'),
        cancelText: t('tw_cancel'),
        tone: 'danger',
        onConfirm: async () => {
            try {
                await twAcadJSON('/api/teaching/exams?id=' + encodeURIComponent(exam.id), 'DELETE', { id: exam.id });
                twScSelected = '';
                await twScLoad();
            } catch (err) {
                twAcadFail('scores-status', err);
            }
        },
    });
}
