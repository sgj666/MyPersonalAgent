/* Video download view: paste → probe → download (SSE progress) → play, plus
   the optional account import (QR for Bilibili, a browser window for the other
   two).

   The page never guesses: every number on screen comes from /api/video/probe,
   and the stage only advances when the backend says so. Six visual states live
   in one card (`#vd-stage[data-stage]`), so the layout never jumps between
   them.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. Everything here is
   called at run time from loadVideoView(), so nothing at top level may read a
   declaration from a later file. */

let vdInfo = null;            // last successful probe
let vdQuality = 'best';
let vdSource = '';            // Douyin's resolved stream, reused by download
let vdFolder = '';            // folder of the last finished file
let vdStream = null;          // EventSource of the running download
let vdLastPath = '';          // last finished file
let vdLoginPlatform = '';
let vdLoginKey = '';
let vdLoginTimer = null;
let vdWired = false;
let vdStatus = null;

const VD_PLATFORM_CLASS = { douyin: 'vd-plat-douyin', xiaohongshu: 'vd-plat-xhs', bilibili: 'vd-plat-bili' };
const VD_ERROR_COPY = {
    needs_login: { title: 'tw_video_err_login_title', message: 'tw_video_err_login_body' },
    no_browser: { title: 'tw_video_err_browser_title', message: 'tw_video_err_browser_body' },
    not_found: { title: 'tw_video_err_not_found_title', message: 'tw_video_err_not_found_body' },
    not_video: { title: 'tw_video_err_not_video_title', message: 'tw_video_err_not_video_body' },
    unsupported: { title: 'tw_video_err_unsupported_title', message: 'tw_video_err_unsupported_body' },
    unsupported_url: { title: 'tw_video_err_unsupported_title', message: 'tw_video_err_unsupported_body' },
    no_link: { title: 'tw_video_err_nolink_title', message: 'tw_video_err_nolink_body' },
    too_large: { title: 'tw_video_err_large_title', message: 'tw_video_err_large_body' },
    disk: { title: 'tw_video_err_disk_title', message: 'tw_video_err_disk_body' },
    busy: { title: 'tw_video_err_busy_title', message: 'tw_video_err_busy_body' },
    network: { title: 'tw_video_err_network_title', message: 'tw_video_err_network_body' },
    timeout: { title: 'tw_video_err_timeout_title', message: 'tw_video_err_timeout_body' },
    dep: { title: 'tw_video_err_dep_title', message: 'tw_video_err_dep_body' },
    default: { title: 'tw_video_err_default_title', message: 'tw_video_err_default_body' },
};

function vdBytes(size) {
    if (!size) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = Number(size), i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return (i === 0 ? value : value.toFixed(1)) + ' ' + units[i];
}

function vdClock(seconds) {
    if (seconds == null || isNaN(seconds)) return '';
    const total = Math.round(Number(seconds));
    const m = Math.floor(total / 60), s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function vdSetStage(stage) {
    const el = document.getElementById('vd-stage');
    if (el) el.dataset.stage = stage;
    if (stage !== 'downloading' && vdStream) {
        vdStream.close();
        vdStream = null;
    }
}

function vdEl(id) { return document.getElementById(id); }

async function vdJSON(url, body) {
    const opts = { headers: { Accept: 'application/json' } };
    if (body) {
        opts.method = 'POST';
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status !== 'success') {
        const err = new Error((data && data.message) || ('HTTP ' + res.status));
        err.code = (data && data.code) || 'unknown';
        throw err;
    }
    return data;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

function loadVideoView() {
    vdWire();
    vdLoadStatus();
    vdLoadRecent();
}

function vdWire() {
    if (vdWired) return;
    vdWired = true;

    const url = vdEl('vd-url');
    if (!url) return;

    url.addEventListener('input', () => {
        vdEl('vd-parse-btn').disabled = !url.value.trim();
    });
    url.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && url.value.trim()) vdParse();
    });

    const drop = vdEl('vd-drop');
    ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, e => {
        e.preventDefault();
        drop.classList.add('is-drag');
    }));
    ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, e => {
        e.preventDefault();
        drop.classList.remove('is-drag');
    }));
    drop.addEventListener('drop', e => {
        const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (!text) return;
        url.value = text.trim();
        url.dispatchEvent(new Event('input'));
        vdParse();
    });

    vdEl('vd-quality').addEventListener('click', e => {
        const btn = e.target.closest('button[data-quality]');
        if (!btn) return;
        vdQuality = btn.dataset.quality;
        vdEl('vd-quality').querySelectorAll('button')
            .forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    });

    vdEl('vd-mode').addEventListener('click', e => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        vdEl('vd-mode').querySelectorAll('button')
            .forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        const note = vdEl('vd-mode-note');
        note.querySelector('span:last-child').textContent = btn.dataset.mode === 'account'
            ? t('tw_video_account_note')
            : t('tw_video_guest_note');
    });

    vdEl('vd-accounts').addEventListener('click', e => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const platform = btn.dataset.platform;
        if (btn.dataset.act === 'login') vdLoginStart(platform);
        else vdLogout(platform);
    });
}

// ---------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------

let vdStatusTimer = null;

async function vdLoadStatus() {
    if (vdStatusTimer) { clearTimeout(vdStatusTimer); vdStatusTimer = null; }
    try {
        vdStatus = await vdJSON('/api/video/status');
        vdRenderStatus();
        // The backend installs a missing engine on its own; keep asking until
        // it is either ready or has given up, so the pill resolves by itself.
        if (vdStatus.installing) {
            vdStatusTimer = setTimeout(vdLoadStatus, 2500);
        }
    } catch (e) {
        // Two very different causes look the same from here: an engine that is
        // not installed, and a backend older than this page (the endpoint does
        // not exist yet). Say which, because the fix is different.
        const stale = e && (e.code === 'not_found' || /HTTP 404/.test(String(e.message)));
        vdEngineProblem(stale ? 'stale' : 'missing');
    }
}

/* One line under the paste box, only while something is actually wrong.
   A pill that says "not ready" with no next step is the same as no message. */
function vdEngineProblem(kind) {
    const pill = vdEl('vd-pill-engine');
    if (pill) {
        pill.classList.add('is-warn');
        pill.querySelector('span').textContent = t(kind === 'stale'
            ? 'tw_video_engine_stale' : 'tw_video_engine_missing');
    }
    const hint = vdEl('vd-engine-hint');
    if (!hint) return;
    hint.classList.remove('hidden');
    hint.innerHTML = kind === 'stale'
        ? t('tw_video_engine_stale_hint')
        : kind === 'failed'
            ? t('tw_video_engine_missing_hint') +
              (vdStatus && vdStatus.install_error ? ' ' + vdEsc(vdStatus.install_error) : '')
            : t('tw_video_engine_missing_hint');
}

/* First use on an older install: the backend is pip-installing yt-dlp itself. */
function vdEngineInstalling() {
    const pill = vdEl('vd-pill-engine');
    if (pill) {
        pill.classList.add('is-warn');
        pill.querySelector('span').textContent = t('tw_video_engine_installing');
    }
    const hint = vdEl('vd-engine-hint');
    if (!hint) return;
    hint.classList.remove('hidden');
    hint.innerHTML = t('tw_video_engine_installing_hint');
}

function vdClearEngineProblem() {
    const hint = vdEl('vd-engine-hint');
    if (hint) hint.classList.add('hidden');
}

function vdRenderStatus() {
    const pill = vdEl('vd-pill-engine');
    if (pill && vdStatus) {
        pill.classList.remove('is-warn');
        if (vdStatus.installing) {
            vdEngineInstalling();
        } else if (!vdStatus.ytdlp) {
            vdEngineProblem(vdStatus.install_error ? 'failed' : 'missing');
        } else {
            vdClearEngineProblem();
            pill.querySelector('span').textContent =
                'yt-dlp ' + (vdStatus.version || '') + ' · ffmpeg ' + (vdStatus.ffmpeg ? '✓' : '✗');
        }
    }
    vdRenderAccounts();
}

function vdRenderAccounts() {
    const list = vdEl('vd-accounts');
    if (!list || !vdStatus || !vdStatus.accounts) return;
    const labels = { bilibili: 'B 站', xiaohongshu: '小红书', douyin: '抖音' };
    list.innerHTML = Object.keys(vdStatus.accounts).map(platform => {
        const info = vdStatus.accounts[platform] || {};
        const on = !!info.logged_in;
        return '<li class="vd-account">' +
            '<span class="who">' + labels[platform] + '</span>' +
            '<span class="state ' + (on ? 'on' : '') + '">' +
            t(on ? 'tw_video_logged_in' : 'tw_video_not_logged_in') + '</span>' +
            '<button type="button" data-act="' + (on ? 'logout' : 'login') + '" data-platform="' + platform + '">' +
            t(on ? 'tw_video_logout' : 'tw_video_login') + '</button>' +
            '</li>';
    }).join('');
}

// ---------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------

function vdPasteFromClipboard() {
    const url = vdEl('vd-url');
    if (!navigator.clipboard || !navigator.clipboard.readText) {
        url.focus();
        return;
    }
    navigator.clipboard.readText().then(text => {
        if (!text) return;
        url.value = text.trim();
        url.dispatchEvent(new Event('input'));
        url.focus();
    }).catch(() => url.focus());
}

async function vdParse() {
    const raw = vdEl('vd-url').value.trim();
    if (!raw) { vdEl('vd-url').focus(); return; }
    vdSetStage('probing');
    try {
        const info = await vdJSON('/api/video/probe?url=' + encodeURIComponent(raw));
        vdInfo = info;
        vdRenderInfo(info);
        vdSetStage('ready');
    } catch (e) {
        vdShowError(e.code || 'unknown', e.message, '');
    }
}

function vdRenderInfo(info) {
    const badge = vdEl('vd-platform-badge');
    badge.textContent = info.label || '';
    badge.className = 'vd-plat ' + (VD_PLATFORM_CLASS[info.platform] || 'vd-plat-none');

    vdEl('vd-title').textContent = info.title || '';
    vdEl('vd-uploader').textContent = [info.uploader, info.via === 'browser' ? t('tw_video_via_browser') : '']
        .filter(Boolean).join(' · ');

    const res = (info.width && info.height) ? (info.width + ' × ' + info.height) : '—';
    vdEl('vd-spec-res').textContent = res;
    vdEl('vd-spec-size').textContent = vdBytes(info.size);
    vdEl('vd-spec-duration').textContent = vdClock(info.duration) || '—';

    const cover = vdEl('vd-cover');
    const old = cover.querySelector('img');
    if (old) old.remove();
    if (info.thumbnail) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        // 平台封面走本站代理：直连 CDN 的 http 图在 https 控制台里会被拦。
        img.src = '/api/video/thumb?url=' + encodeURIComponent(info.thumbnail);
        img.onerror = () => img.remove();
        cover.appendChild(img);
    }
    vdEl('vd-duration').textContent = vdClock(info.duration) || '';

    vdSource = info.source || '';
    // Douyin serves one rendition through the browser, so a quality picker that
    // does nothing would be a lie.
    const quality = vdEl('vd-quality');
    quality.style.display = info.platform === 'douyin' && !vdStatus?.accounts?.douyin?.logged_in
        ? 'none' : '';
}

// ---------------------------------------------------------------------
// Download (SSE)
// ---------------------------------------------------------------------

function vdDownload() {
    const raw = vdEl('vd-url').value.trim();
    if (!raw) { vdEl('vd-url').focus(); return; }
    if (vdStream) return;

    const busyTitle = vdEl('vd-busy-title');
    busyTitle.textContent = (vdInfo && vdInfo.title) || raw;
    const badge = vdEl('vd-busy-badge');
    if (vdInfo) {
        badge.textContent = vdInfo.label || '';
        badge.className = 'vd-plat ' + (VD_PLATFORM_CLASS[vdInfo.platform] || 'vd-plat-none');
    }
    vdResetProgress();
    vdSetStage('downloading');

    const params = new URLSearchParams({ url: raw, quality: vdQuality });
    if (vdSource) params.set('source', vdSource);
    if (vdInfo && vdInfo.title) params.set('title', vdInfo.title);

    const stream = new EventSource('/api/video/download?' + params.toString());
    vdStream = stream;

    stream.onmessage = event => {
        let payload = null;
        try { payload = JSON.parse(event.data); } catch (_) { return; }
        if (payload.stage === 'transcode') {
            // The file downloaded fine but its codec would not open on Windows;
            // the backend re-encodes it before handing it over.
            vdRenderProgress(payload);
            const note = vdEl('vd-busy-note');
            if (note) note.textContent = payload.message || t('tw_video_transcoding');
            return;
        }
        if (payload.stage === 'download') {
            vdRenderProgress(payload);
        } else if (payload.stage === 'done') {
            vdFinish(payload);
        } else if (payload.stage === 'error') {
            vdShowError(payload.reason || 'unknown', payload.message || '', payload.detail || '');
        }
    };
    stream.onerror = () => {
        // EventSource retries on its own; only a closed stream with no result
        // means the job is gone.
        if (stream.readyState === EventSource.CLOSED) {
            vdShowError('network', t('tw_video_err_stream_body'), '');
        }
    };
}

function vdRenderProgress(event) {
    const percent = event.percent;
    if (percent != null) {
        vdEl('vd-bar').style.width = Math.max(0, Math.min(100, percent)) + '%';
        vdEl('vd-pct').textContent = Math.round(percent);
    }
    vdEl('vd-stat-done').textContent = event.downloaded
        ? vdBytes(event.downloaded) + (event.total ? ' / ' + vdBytes(event.total) : '')
        : '—';
    vdEl('vd-stat-speed').textContent = event.speed || '—';
    // yt-dlp estimates per fragment, so mid-way it reports 00:00 (or NA) for a
    // job that is still running; showing that as "0 seconds left" reads broken.
    const eta = String(event.eta || '').trim();
    vdEl('vd-stat-eta').textContent = /^(00:0?0|NA|\?|-+)$/i.test(eta) ? '—' : (eta || '—');
}

function vdResetProgress() {
    vdEl('vd-bar').style.width = '0%';
    vdEl('vd-pct').textContent = '0';
    vdEl('vd-stat-done').textContent = '—';
    vdEl('vd-stat-speed').textContent = '—';
    vdEl('vd-stat-eta').textContent = '—';
}

function vdFinish(result) {
    if (vdStream) { vdStream.close(); vdStream = null; }
    vdLastPath = result.path || '';
    vdFolder = vdLastPath.replace(/[\\/][^\\/]+$/, '');

    const name = vdLastPath.split(/[\\/]/).pop() || '';
    vdEl('vd-file-name').textContent = name;
    vdEl('vd-file-name').title = vdLastPath;
    vdEl('vd-file-dim').textContent = [vdBytes(result.size), vdQuality === 'best' ? '' : vdQuality + 'P']
        .filter(Boolean).join(' · ');

    const player = vdEl('vd-player');
    player.src = '/api/file?path=' + encodeURIComponent(vdLastPath);
    // The downloaded file is the best source of a cover: the platform thumbnail
    // is missing for Douyin and often softer than the frame itself.
    player.poster = '/api/video/poster?path=' + encodeURIComponent(vdLastPath);

    vdSetStage('done');
    vdLoadRecent();
    vdLoadStatus();
}

function vdCancel() {
    if (vdStream) { vdStream.close(); vdStream = null; }
    // Tell the backend too: closing the stream alone leaves the transfer
    // running and still writes the file.
    fetch('/api/video/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
    }).catch(() => {});
    vdResetProgress();
    vdSetStage(vdInfo ? 'ready' : 'idle');
}

function vdReset() {
    if (vdStream) { vdStream.close(); vdStream = null; }
    vdInfo = null;
    vdSource = '';
    vdLastPath = '';
    const player = vdEl('vd-player');
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
    vdEl('vd-url').value = '';
    vdEl('vd-parse-btn').disabled = true;
    vdSetStage('idle');
    vdEl('vd-url').focus();
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

function vdShowError(code, message, detail) {
    if (vdStream) { vdStream.close(); vdStream = null; }
    const copy = VD_ERROR_COPY[code] || VD_ERROR_COPY.default;
    vdEl('vd-error-title').textContent = t(copy.title);
    vdEl('vd-error-message').textContent = message || t(copy.message);
    vdEl('vd-error-detail').textContent = detail || '';

    // The account action only makes sense where an account would actually help.
    const needsAccount = code === 'needs_login' || code === 'no_browser';
    vdEl('vd-error-login').style.display = needsAccount ? '' : 'none';
    vdSetStage('error');
}

function vdErrorLogin() {
    const platform = (vdInfo && vdInfo.platform) || 'bilibili';
    vdLoginStart(platform);
}

// ---------------------------------------------------------------------
// Recent downloads
// ---------------------------------------------------------------------

async function vdLoadRecent() {
    try {
        const data = await vdJSON('/api/video/recent');
        vdRenderRecent(data.items || []);
    } catch (_) { /* history is a nicety; the stage still works */ }
}

/* The downloaded file name carries the platform's id, which is enough to name
   the platform without storing anything extra: BV… is Bilibili, a 24-hex id is
   a Xiaohongshu note, plain digits are Douyin. */
function vdPlatformOf(name) {
    // Duplicates land as `title [id] (2).mp4`, so the suffix has to be optional.
    const match = /\[([A-Za-z0-9]+)\](?:\s*\(\d+\))?\.\w+$/.exec(name || '');
    const id = match ? match[1] : '';
    if (/^BV/i.test(id)) return 'bilibili';
    if (/^[0-9a-f]{24}$/i.test(id)) return 'xiaohongshu';
    // Douyin's aweme_id is 19 digits; a bare short number is Bilibili's `aid`.
    if (/^\d{15,}$/.test(id)) return 'douyin';
    if (/^\d{1,10}$/.test(id)) return 'bilibili';
    return '';
}

const VD_PLATFORM_LABEL = { douyin: '抖音', xiaohongshu: '小红书', bilibili: 'B 站' };

function vdRenderRecent(items) {
    const grid = vdEl('vd-recent');
    const empty = vdEl('vd-recent-empty');
    if (!grid) return;
    grid.innerHTML = items.map(item => {
        const name = item.name || '';
        const title = name.replace(/\s*\[[^\]]+\](?:\s*\(\d+\))?\.\w+$/, '').replace(/\.\w+$/, '');
        const platform = item.platform || vdPlatformOf(name);
        const chip = platform
            ? '<span class="vd-plat ' + (VD_PLATFORM_CLASS[platform] || 'vd-plat-none') + '">' +
              VD_PLATFORM_LABEL[platform] + '</span>'
            : '';
        const poster = '/api/video/poster?path=' + encodeURIComponent(item.path);
        return '<div class="vd-tile" data-path="' + vdEsc(item.path) + '">' +
            '<div class="vd-tile-thumb">' +
            '<i class="fas fa-play"></i>' +
            '<img class="vd-tile-poster" src="' + vdEsc(poster) + '" alt="" loading="lazy" ' +
            'onerror="this.remove()">' +
            '</div>' +
            '<span class="t" title="' + vdEsc(name) + '">' + vdEsc(title) + '</span>' +
            '<span class="m">' + chip + vdBytes(item.size) + ' · ' + vdWhen(item.mtime) +
            '<button type="button" class="vd-tile-open" data-act="reveal" title="' +
            vdEsc(t('tw_video_open_folder')) + '" aria-label="' + vdEsc(t('tw_video_open_folder')) +
            '"><i class="fas fa-folder-open"></i></button>' +
            '<button type="button" class="vd-tile-del" data-act="delete" title="' +
            vdEsc(t('tw_video_delete')) + '" aria-label="' + vdEsc(t('tw_video_delete')) +
            '"><i class="fas fa-trash"></i></button></span>' +
            '</div>';
    }).join('');
    empty.classList.toggle('is-shown', items.length === 0);

    grid.onclick = e => {
        const tile = e.target.closest('.vd-tile');
        if (!tile) return;
        if (e.target.closest('[data-act="delete"]') || e.target.closest('.vd-tile-x')) {
            vdDelete(tile.dataset.path);
            return;
        }
        if (e.target.closest('[data-act="reveal"]')) {
            // The folder action lives inside the tile, so stop the play handler
            // from also firing.
            e.stopPropagation();
            fetch('/api/file/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ path: tile.dataset.path }),
            }).catch(() => {});
            return;
        }
        window.open('/api/file?path=' + encodeURIComponent(tile.dataset.path), '_blank');
    };
}

async function vdDelete(path) {
    if (!path) return;
    try {
        await vdJSON('/api/video/delete', { path });
        vdLoadRecent();
    } catch (e) {
        vdShowError(e.code || 'unknown', e.message, '');
    }
}

function vdWhen(seconds) {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    const sameDay = date.toDateString() === new Date().toDateString();
    const pad = n => String(n).padStart(2, '0');
    return sameDay
        ? pad(date.getHours()) + ':' + pad(date.getMinutes())
        : (date.getMonth() + 1) + '/' + date.getDate();
}

function vdEsc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// File actions
// ---------------------------------------------------------------------

function vdOpenFolder() {
    if (!vdLastPath) return;
    fetch('/api/file/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: vdLastPath }),
    }).catch(() => {});
}

function vdCopyTitle() {
    const title = (vdInfo && vdInfo.title) || vdEl('vd-file-name').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(title).catch(() => {});
    }
}

// ---------------------------------------------------------------------
// Account import: QR for Bilibili, a browser window for the other two
// ---------------------------------------------------------------------

function vdLoginStart(platform) {
    vdLoginPlatform = platform || 'bilibili';
    const card = vdEl('vd-login');
    const qrWrap = vdEl('vd-login-qr-wrap');
    const state = vdEl('vd-login-state');
    card.classList.remove('hidden');
    qrWrap.classList.add('hidden');
    state.className = 'vd-login-state';
    state.textContent = t('tw_video_login_working');
    vdEl('vd-login-sub').textContent = vdLoginPlatform === 'bilibili'
        ? t('tw_video_login_qr_hint')
        : t('tw_video_login_browser_hint');
    vdEl('vd-login-retry').style.display = vdLoginPlatform === 'bilibili' ? '' : 'none';

    vdJSON('/api/video/login/start', { platform: vdLoginPlatform }).then(data => {
        if (data.qr) {
            vdEl('vd-login-qr').src = data.qr;
            qrWrap.classList.remove('hidden');
            vdLoginKey = data.key || '';
            state.textContent = t('tw_video_login_scan');
            vdPollLogin();
        } else {
            state.textContent = t('tw_video_login_window_open');
            vdPollLogin();
        }
    }).catch(e => {
        state.className = 'vd-login-state is-warn';
        state.textContent = e.message || t('tw_video_login_failed');
    });
}

function vdPollLogin() {
    if (vdLoginTimer) clearTimeout(vdLoginTimer);
    vdLoginTimer = setTimeout(async () => {
        if (!vdLoginPlatform) return;
        try {
            const data = await vdJSON('/api/video/login/poll?platform=' +
                encodeURIComponent(vdLoginPlatform) + '&key=' + encodeURIComponent(vdLoginKey));
            const state = vdEl('vd-login-state');
            if (data.state === 'ok') {
                state.className = 'vd-login-state is-ok';
                state.textContent = t('tw_video_login_ok');
                vdLoadStatus();
                setTimeout(vdLoginClose, 900);
                return;
            }
            if (data.state === 'scanned') {
                state.textContent = t('tw_video_login_scanned');
            } else if (data.state === 'expired') {
                state.className = 'vd-login-state is-warn';
                state.textContent = t('tw_video_login_expired');
                return;
            } else {
                state.textContent = t('tw_video_login_waiting');
            }
            vdPollLogin();
        } catch (e) {
            const state = vdEl('vd-login-state');
            state.className = 'vd-login-state is-warn';
            state.textContent = e.message || t('tw_video_login_failed');
        }
    }, vdLoginPlatform === 'bilibili' ? 1500 : 2500);
}

function vdLoginClose() {
    if (vdLoginTimer) { clearTimeout(vdLoginTimer); vdLoginTimer = null; }
    const platform = vdLoginPlatform;
    vdLoginPlatform = '';
    vdLoginKey = '';
    const card = vdEl('vd-login');
    if (card) card.classList.add('hidden');
    if (platform && platform !== 'bilibili') {
        fetch('/api/video/login/close', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform }),
        }).catch(() => {});
    }
}

async function vdLogout(platform) {
    try {
        const data = await vdJSON('/api/video/logout', { platform });
        vdStatus = { ...(vdStatus || {}), ...data };
        vdRenderAccounts();
    } catch (_) { /* nothing to show: the list simply stays as it was */ }
}
