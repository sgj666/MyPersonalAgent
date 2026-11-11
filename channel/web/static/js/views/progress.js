/* Teacher workbench progress: the topic list of one class, its planned and
   taught periods, and the pace those two imply. "讲完了" advances one period;
   a lesson-plan paste adds topics in bulk.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

let twPrClasses = [];
let twPrSelected = '';
let twPrItems = [];
let twPrLoadToken = 0;
let twPrWired = false;
let twPrImportRows = [];

function loadProgressView() {
    if (!twPrWired) {
        twPrWired = true;
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') twPrCloseDialogs();
        });
    }
    return twPrLoadClasses();
}

function twPrCloseDialogs() {
    ['topic-dialog', 'progress-import-dialog'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function twPrLoadClasses() {
    const token = ++twPrLoadToken;
    twAcadStatus('progress-status', '');
    return twAcadJSON('/api/teaching/classes')
        .then(data => {
            if (token !== twPrLoadToken) return;
            twPrClasses = Array.isArray(data.classes) ? data.classes : [];
            if (!twPrClasses.some(c => c.id === twPrSelected)) {
                twPrSelected = twPrClasses.length ? twPrClasses[0].id : '';
            }
            twPrRenderClasses();
            return twPrSelected ? twPrLoadItems() : twPrRenderNoClass();
        })
        .catch(err => {
            if (token !== twPrLoadToken) return;
            twAcadFail('progress-status', err);
            twPrRenderNoClass(err);
        });
}

function twPrCurrent() {
    return twPrClasses.find(c => c.id === twPrSelected) || null;
}

function twPrRenderClasses() {
    const list = document.getElementById('progress-classes');
    const add = document.getElementById('progress-add');
    const imp = document.getElementById('progress-import');
    if (add) add.disabled = !twPrSelected;
    if (imp) imp.disabled = !twPrSelected;
    if (!list) return;
    if (!twPrClasses.length) {
        list.innerHTML = `<div class="tw-empty"><i class="fas fa-users" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_pr_no_classes'))}</p>`
            + `<button type="button" class="tw-btn" onclick="navigateTo('classes')">${escapeHtml(t('tw_cls_new'))}</button></div>`;
        return;
    }
    list.innerHTML = twPrClasses.map(cls => {
        const meta = [cls.grade, cls.subject].filter(Boolean).join(' · ');
        return `<div class="tw-acad-item${cls.id === twPrSelected ? ' is-active' : ''}">
            <button type="button" class="tw-acad-item-main" onclick="twPrSelect('${twAcadAttr(cls.id)}')">
                <b>${escapeHtml(cls.name || '')}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
            </button>
        </div>`;
    }).join('');
}

function twPrSelect(id) {
    if (twPrSelected === id) return;
    twPrSelected = id;
    twPrRenderClasses();
    twPrLoadItems();
}

function twPrLoadItems() {
    const token = ++twPrLoadToken;
    const body = document.getElementById('progress-body');
    if (body) body.innerHTML = `<div class="tw-loading">${escapeHtml(t('tw_loading'))}</div>`;
    const cls = twPrCurrent();
    if (!cls) return twPrRenderNoClass();
    twAcadStatus('progress-status', '');
    return twAcadJSON('/api/teaching/progress?class_id=' + encodeURIComponent(cls.id))
        .then(data => {
            if (token !== twPrLoadToken) return;
            twPrItems = Array.isArray(data.items) ? data.items : [];
            twPrRenderItems();
        })
        .catch(err => {
            if (token !== twPrLoadToken) return;
            twAcadFail('progress-status', err);
            twPrRenderNoClass(err);
        });
}

function twPrTotals() {
    return twPrItems.reduce((acc, item) => {
        const planned = Number(item.planned_periods) || 0;
        const taught = Number(item.taught_periods) || 0;
        acc.planned += planned;
        acc.taught += Math.min(taught, planned);
        return acc;
    }, { planned: 0, taught: 0 });
}

/** Pace is taught against planned for the class as a whole: the plan is the
    yardstick a teacher actually has, not a term calendar the console lacks. */
function twPrPace() {
    const totals = twPrTotals();
    if (!totals.planned) return { key: 'tw_pr_pace_none', percent: 0 };
    const percent = Math.round(totals.taught / totals.planned * 100);
    const key = percent >= 100 ? 'tw_pr_pace_done' : percent >= 60 ? 'tw_pr_pace_ok' : 'tw_pr_pace_slow';
    return { key: key, percent: percent };
}

function twPrRenderItems() {
    const body = document.getElementById('progress-body');
    const meta = document.getElementById('progress-meta');
    const pace = document.getElementById('progress-pace');
    if (!body) return;
    const cls = twPrCurrent();
    if (meta) {
        const totals = twPrTotals();
        meta.textContent = cls.name + ' · ' + t('tw_pr_count')
            .replace('{n}', String(twPrItems.length))
            .replace('{t}', String(totals.planned));
    }
    const p = twPrPace();
    if (pace) {
        pace.innerHTML = twPrItems.length
            ? `<span class="tw-pr-pace-chip is-${p.key.split('_').pop()}">${escapeHtml(t(p.key))}</span>
               <span class="tw-pr-pace-pct">${p.percent}%</span>`
            : '';
    }

    if (!twPrItems.length) {
        body.innerHTML = `<div class="tw-empty"><i class="fas fa-list-check" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_pr_no_topics'))}</p>`
            + `<button type="button" class="tw-btn tw-btn-primary" onclick="twPrOpenTopicDialog()">${escapeHtml(t('tw_pr_add'))}</button></div>`;
        return;
    }

    const rows = twPrItems.slice().sort((a, b) =>
        (Number(a.order) || 0) - (Number(b.order) || 0)
        || String(a.topic || '').localeCompare(String(b.topic || ''), 'zh'));

    body.innerHTML = `<div class="tw-table-wrap"><table class="tw-table tw-pr-table">
        <thead><tr>
            <th>${escapeHtml(t('tw_pr_topic'))}</th>
            <th>${escapeHtml(t('tw_pr_planned'))}</th>
            <th>${escapeHtml(t('tw_pr_taught'))}</th>
            <th>${escapeHtml(t('tw_pr_pace'))}</th>
            <th>${escapeHtml(t('tw_pr_state'))}</th>
            <th class="tw-col-actions">${escapeHtml(t('tw_cls_col_actions'))}</th>
        </tr></thead>
        <tbody>${rows.map(item => {
            const planned = Number(item.planned_periods) || 0;
            const taught = Number(item.taught_periods) || 0;
            const done = planned > 0 && taught >= planned;
            const percent = planned ? Math.min(100, Math.round(taught / planned * 100)) : 0;
            const stateKey = done ? 'tw_pr_complete' : (taught > 0 ? 'tw_pr_in_progress' : 'tw_pr_not_started');
            const canAdvance = !done;
            return `<tr data-topic-id="${twAcadAttr(item.id)}">
                <td><b>${escapeHtml(item.topic || '')}</b></td>
                <td>${planned}</td>
                <td>${taught}</td>
                <td class="tw-pr-bar-cell">
                    <span class="tw-pr-bar" role="img" aria-label="${percent}%"><span style="width:${percent}%"></span></span>
                    <small>${percent}%</small>
                </td>
                <td><span class="tw-chip ${done ? 'tw-chip-done' : (taught ? 'tw-chip-doing' : '')}">${escapeHtml(t(stateKey))}</span></td>
                <td class="tw-col-actions">
                    <button type="button" class="tw-btn tw-btn-sm${canAdvance ? ' tw-btn-primary' : ''}"
                            onclick="twPrAdvance('${twAcadAttr(item.id)}')" ${canAdvance ? '' : 'disabled'}
                            title="${twAcadAttr(t('tw_pr_done_once'))}">
                        <i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(t('tw_pr_done'))}</span>
                    </button>
                    <button type="button" class="tw-icon-btn" onclick="twPrOpenTopicDialog('${twAcadAttr(item.id)}')"
                            aria-label="${twAcadAttr(t('tw_c_edit'))}" title="${twAcadAttr(t('tw_c_edit'))}">
                        <i class="fas fa-pen" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="tw-icon-btn is-danger" onclick="twPrDelete('${twAcadAttr(item.id)}')"
                            aria-label="${twAcadAttr(t('tw_delete'))}" title="${twAcadAttr(t('tw_delete'))}">
                        <i class="fas fa-trash" aria-hidden="true"></i>
                    </button>
                </td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;
}

function twPrRenderNoClass(err) {
    twPrItems = [];
    const body = document.getElementById('progress-body');
    const meta = document.getElementById('progress-meta');
    const pace = document.getElementById('progress-pace');
    if (meta) meta.textContent = '';
    if (pace) pace.innerHTML = '';
    const add = document.getElementById('progress-add');
    const imp = document.getElementById('progress-import');
    if (add) add.disabled = !twPrCurrent();
    if (imp) imp.disabled = !twPrCurrent();
    if (!body) return;
    body.innerHTML = err
        ? `<div class="tw-empty"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>`
            + `<p>${escapeHtml(t('tw_load_failed'))}</p>`
            + `<button type="button" class="tw-btn" onclick="twPrLoadClasses()">${escapeHtml(t('tw_retry'))}</button></div>`
        : `<div class="tw-empty"><i class="fas fa-list-check" aria-hidden="true"></i>`
            + `<p>${escapeHtml(twPrClasses.length ? t('tw_pr_pick') : t('tw_pr_no_classes'))}</p></div>`;
}

// ---------- writes ----------

function twPrAdvance(id) {
    const item = twPrItems.find(i => i.id === id);
    if (!item) return;
    const planned = Number(item.planned_periods) || 0;
    const taught = Number(item.taught_periods) || 0;
    if (planned && taught >= planned) return;
    const next = taught + 1;
    twAcadStatus('progress-status', '');
    return twAcadJSON('/api/teaching/progress', 'PATCH', { id: id, taught_periods: next })
        .then(() => {
            item.taught_periods = next;
            twPrRenderItems();
            twAcadStatus('progress-status', t('tw_pr_saved'));
        })
        .catch(err => twAcadFail('progress-status', err));
}

function twPrOpenTopicDialog(id) {
    const item = id ? twPrItems.find(i => i.id === id) : null;
    if (!twPrSelected) return;
    document.getElementById('topic-id').value = item ? item.id : '';
    document.getElementById('topic-name').value = item ? (item.topic || '') : '';
    document.getElementById('topic-planned').value = String(item ? (item.planned_periods || 1) : 1);
    document.getElementById('topic-dialog-title').textContent = t(item ? 'tw_pr_edit_title' : 'tw_pr_add_title');
    twAcadStatus('topic-dialog-status', '');
    document.getElementById('topic-dialog').classList.remove('hidden');
    document.getElementById('topic-name').focus();
}

async function twPrSubmitTopic(event) {
    if (event) event.preventDefault();
    const form = document.getElementById('topic-form');
    if (form && typeof form.reportValidity === 'function' && !form.reportValidity()) return;
    const id = document.getElementById('topic-id').value;
    const topic = document.getElementById('topic-name').value.trim();
    const planned = Math.max(1, Number(document.getElementById('topic-planned').value) || 1);
    if (!topic) {
        twAcadStatus('topic-dialog-status', t('tw_pr_missing_topic'), true);
        return;
    }
    try {
        if (id) {
            await twAcadJSON('/api/teaching/progress', 'PATCH', { id: id, topic: topic, planned_periods: planned });
        } else {
            const order = twPrItems.reduce((max, i) => Math.max(max, Number(i.order) || 0), 0) + 1;
            await twAcadJSON('/api/teaching/progress', 'POST', {
                class_id: twPrSelected, topic: topic, planned_periods: planned, taught_periods: 0, order: order,
            });
        }
        document.getElementById('topic-dialog').classList.add('hidden');
        await twPrLoadItems();
        twAcadStatus('progress-status', t('tw_pr_saved'));
    } catch (err) {
        twAcadFail('topic-dialog-status', err);
    }
}

function twPrDelete(id) {
    const item = twPrItems.find(i => i.id === id);
    if (!item) return;
    showConfirmDialog({
        title: t('tw_pr_delete_title'),
        message: t('tw_pr_delete_msg').replace('{topic}', item.topic || ''),
        okText: t('tw_delete'),
        cancelText: t('tw_cancel'),
        tone: 'danger',
        onConfirm: async () => {
            try {
                await twAcadJSON('/api/teaching/progress?id=' + encodeURIComponent(id), 'DELETE', { id: id });
                await twPrLoadItems();
            } catch (err) {
                twAcadFail('progress-status', err);
            }
        },
    });
}

// ---------- paste import ----------

function twPrOpenImportDialog() {
    if (!twPrSelected) return;
    twPrImportRows = [];
    document.getElementById('progress-import-text').value = '';
    document.getElementById('progress-import-preview').innerHTML = '';
    document.getElementById('progress-import-submit').disabled = true;
    twAcadStatus('progress-import-status', '');
    document.getElementById('progress-import-dialog').classList.remove('hidden');
    document.getElementById('progress-import-text').focus();
}

function twPrParseLine(line) {
    const trimmed = line.replace(/\s+$/, '');
    if (!trimmed.trim()) return null;
    let topic = trimmed.trim();
    let planned = 1;
    const cells = trimmed.indexOf('\t') !== -1 ? trimmed.split('\t') : trimmed.split(/[,，]/);
    if (cells.length >= 2) {
        const tail = String(cells[cells.length - 1] || '').trim();
        const rest = cells.slice(0, -1).join(' ').trim();
        if (/^\d+$/.test(tail) && rest) {
            topic = rest;
            planned = Number(tail);
        }
    } else {
        // A plan copied out of a document often ends the line with the hours.
        const match = trimmed.match(/^(.*\S)\s+(\d+)\s*(?:课时|課時|节|節)?$/);
        if (match) {
            topic = match[1].trim();
            planned = Number(match[2]);
        }
    }
    planned = Math.max(1, Math.min(60, planned || 1));
    return topic ? { topic: topic, planned_periods: planned } : null;
}

function twPrParseImport(text) {
    return String(text || '').split(/\r?\n/).map(twPrParseLine).filter(Boolean);
}

function twPrPreviewImport() {
    const rows = twPrParseImport(document.getElementById('progress-import-text').value);
    twPrImportRows = rows;
    const preview = document.getElementById('progress-import-preview');
    const submit = document.getElementById('progress-import-submit');
    if (submit) {
        submit.disabled = !rows.length;
        submit.textContent = t('tw_pr_import') + ' ' + rows.length;
    }
    if (!preview) return;
    if (!rows.length) {
        preview.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_pr_import_none'))}</p>`;
        return;
    }
    preview.innerHTML = `<p class="tw-hint">${escapeHtml(t('tw_cls_preview'))}</p>`
        + `<div class="tw-table-wrap tw-import-table"><table class="tw-table"><thead><tr>`
        + `<th>${escapeHtml(t('tw_pr_topic'))}</th><th>${escapeHtml(t('tw_pr_planned'))}</th>`
        + `</tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.topic)}</td>`
        + `<td>${row.planned_periods}</td></tr>`).join('')}</tbody></table></div>`;
}

async function twPrSubmitImport() {
    if (!twPrSelected || !twPrImportRows.length) return;
    const submit = document.getElementById('progress-import-submit');
    if (submit) submit.disabled = true;
    twAcadStatus('progress-import-status', '');
    let order = twPrItems.reduce((max, i) => Math.max(max, Number(i.order) || 0), 0);
    try {
        for (const row of twPrImportRows) {
            order += 1;
            await twAcadJSON('/api/teaching/progress', 'POST', {
                class_id: twPrSelected,
                topic: row.topic,
                planned_periods: row.planned_periods,
                taught_periods: 0,
                order: order,
            });
        }
        document.getElementById('progress-import-dialog').classList.add('hidden');
        await twPrLoadItems();
        twAcadStatus('progress-status', t('tw_pr_import_result').replace('{n}', String(twPrImportRows.length)));
    } catch (err) {
        twAcadFail('progress-import-status', err);
        if (submit) submit.disabled = false;
    }
}
