/* Sidebar menu: drawn from the layout the user arranged (GET /api/menu), or
   from the built-in one until they save one. The desktop client reads the same
   document, so a page only one client has is skipped by the other rather than
   dropped. The artifacts and links in it open in the custom view, /m/<id>.

   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. Uses nav.js
   (navigateTo, syncSidebarTips) at call time, and workspace.js
   (wsRenderPreview, WS_KIND_ICONS) once the page has loaded. */

// The pages of this console that a menu can lead to.
const MENU_BUILTINS = {
    home:      { icon: 'fa-house',            label: 'menu_home' },
    board:     { icon: 'fa-table-columns',    label: 'menu_board' },
    teaching:  { icon: 'fa-pen-ruler',        label: 'menu_teaching' },
    classes:   { icon: 'fa-users',            label: 'menu_classes' },
    timetable: { icon: 'fa-calendar-days',    label: 'menu_timetable' },
    progress:  { icon: 'fa-bars-progress',    label: 'menu_progress' },
    homework:  { icon: 'fa-clipboard-check',  label: 'menu_homework' },
    scores:    { icon: 'fa-chart-simple',     label: 'menu_scores' },
    chat:      { icon: 'fa-message',          label: 'menu_chat' },
    artifacts: { icon: 'fa-layer-group',      label: 'menu_artifacts' },
    agents:    { icon: 'fa-people-group',     label: 'menu_agents' },
    config:    { icon: 'fa-sliders',          label: 'menu_config' },
    skills:    { icon: 'fa-bolt',             label: 'menu_skills' },
    memory:    { icon: 'fa-brain',            label: 'menu_memory' },
    knowledge: { icon: 'fa-book',             label: 'menu_knowledge' },
    channels:  { icon: 'fa-tower-broadcast',  label: 'menu_channels' },
    tasks:     { icon: 'fa-clock',            label: 'menu_tasks' },
    logs:      { icon: 'fa-terminal',         label: 'menu_logs' },
};

// The built-in menu, as sidebar.html draws it before any script runs.
// Groups are drawn in this order and never fold; the order runs from the
// daily work outwards, which is what docs/plans/teacher-workbench.md §4 fixes:
// the teacher's own page first, the chat it feeds second.
//
// A page can be registered in MENU_BUILTINS and still be left out of the
// default: agents and tasks stay reachable from the menu editor's "add a
// built-in page" list, which reads MENU_BUILTINS, without cluttering a menu
// most teachers never use those for.
const MENU_DEFAULT = [
    { id: 'daily', views: ['home'] },
    { id: 'chat',    views: ['chat', 'artifacts'] },
    { id: 'teach',   views: ['classes', 'timetable', 'progress', 'homework', 'scores',
                             'teaching', 'board', 'knowledge'] },
    { id: 'manage',  views: ['config', 'skills', 'memory', 'channels'] },
    { id: 'monitor', views: ['logs'] },
];

// What a tab of a page looks like. The teaching tools are five tabs of one
// view, so the menu draws one entry with a submenu of them; the labels are the
// names the teaching view itself shows, so there is one wording per tool.
const MENU_TAB_META = {
    teaching: {
        plan:       { icon: 'fa-file-pen',      label: 'tw_tool_plan' },
        courseware: { icon: 'fa-chalkboard',    label: 'tw_tool_courseware' },
        card:       { icon: 'fa-clone',         label: 'tw_tool_card' },
        advice:     { icon: 'fa-lightbulb',     label: 'tw_tool_advice' },
        schedule:   { icon: 'fa-calendar-days', label: 'tw_tool_schedule' },
    },
};
// The tabs a page opens with in the built-in menu, in the order the page shows
// them. A menu saved before a page had tabs gets them on the next load.
const MENU_DEFAULT_CHILDREN = {
    teaching: ['plan', 'courseware', 'card', 'advice', 'schedule'],
};
const MENU_GROUP_LABELS = {
    daily: 'nav_daily', teach: 'nav_teach', chat: 'nav_chat',
    manage: 'nav_manage', monitor: 'nav_monitor',
};
// Pages a menu must always lead to; mirrors REQUIRED_VIEWS in api/menu.py.
const MENU_REQUIRED = ['chat', 'config'];
// Artifacts that can be a page of the menu; mirrors MENU_KINDS in api/menu.py.
const MENU_KINDS = ['html', 'markdown'];

// Icons a user can give an entry. The desktop client maps the same names to
// its own icon set, so only the names travel in the document.
const MENU_ICONS = {
    globe: 'fa-globe', link: 'fa-link', chart: 'fa-chart-line', gauge: 'fa-gauge',
    table: 'fa-table', file: 'fa-file-lines', book: 'fa-book', image: 'fa-image',
    video: 'fa-film', music: 'fa-music', code: 'fa-code', calendar: 'fa-calendar',
    star: 'fa-star', bookmark: 'fa-bookmark', folder: 'fa-folder', box: 'fa-box',
    rocket: 'fa-rocket', flag: 'fa-flag', heart: 'fa-heart', bolt: 'fa-bolt',
    brain: 'fa-brain', clock: 'fa-clock', terminal: 'fa-terminal', home: 'fa-house',
    cart: 'fa-cart-shopping', mail: 'fa-envelope', layers: 'fa-layer-group',
    robot: 'fa-robot', pen: 'fa-pen', search: 'fa-magnifying-glass',
};

const MENU_CACHE_KEY = 'cow_menu_cache';
// Which entries' submenus the user folded, by item id. Absent means open.
const MENU_SUBMENUS_KEY = 'cow_menu_submenus';

let menuSaved = null;
let menuDoc = menuMerge(null);
let menuLoaded = false;
let menuCustomId = '';
let menuPageKey = '';
let _menuReadyResolve;
const menuReady = new Promise(resolve => { _menuReadyResolve = resolve; });

function _menuDefaultChildren(view) {
    const tabs = MENU_DEFAULT_CHILDREN[view];
    return tabs ? tabs.map(tab => ({ view: view, tab: tab, title: '' })) : null;
}

function menuBuiltinItem(view) {
    const item = { id: view, type: 'builtin', view: view, title: '', icon: '', hidden: false };
    const children = _menuDefaultChildren(view);
    if (children) item.children = children;
    return item;
}

function _menuDefaultItem(view) {
    return menuBuiltinItem(view);
}

/** The menu to draw: the saved one, plus any page this version added since. */
function menuMerge(saved) {
    if (!saved || !Array.isArray(saved.groups) || !saved.groups.length) {
        return { groups: MENU_DEFAULT.map(g => ({ id: g.id, title: '', items: g.views.map(_menuDefaultItem) })) };
    }
    const doc = {
        groups: saved.groups.map(g => ({
            id: g.id, title: g.title || '',
            items: (g.items || []).map(i => {
                const item = Object.assign({}, i);
                if (Array.isArray(i.children)) item.children = i.children.map(c => Object.assign({}, c));
                return item;
            }),
        })),
    };
    // A menu saved before a page grew tabs keeps its flat entry: give it the
    // submenu this version draws, as a missing page is added below.
    doc.groups.forEach(g => g.items.forEach(i => {
        if (i.type === 'builtin' && !Array.isArray(i.children) && MENU_DEFAULT_CHILDREN[i.view]) {
            i.children = _menuDefaultChildren(i.view);
        }
    }));
    const present = new Set();
    doc.groups.forEach(g => g.items.forEach(i => { if (i.type === 'builtin') present.add(i.view); }));
    MENU_DEFAULT.forEach(def => def.views.forEach(view => {
        if (present.has(view)) return;
        const home = doc.groups.find(g => g.id === def.id) || doc.groups[doc.groups.length - 1];
        home.items.push(_menuDefaultItem(view));
    }));
    return doc;
}

function menuFind(id) {
    for (const group of menuDoc.groups) {
        const item = group.items.find(i => i.id === id);
        if (item) return { group: group, item: item };
    }
    return null;
}

function menuGroupLabel(group) {
    return group.title || (MENU_GROUP_LABELS[group.id] ? t(MENU_GROUP_LABELS[group.id]) : t('menu_group_untitled'));
}

function menuItemLabel(item) {
    if (item.title) return item.title;
    const builtin = item.type === 'builtin' && MENU_BUILTINS[item.view];
    return builtin ? t(builtin.label) : (item.view || '');
}

function menuItemIcon(item) {
    if (item.icon && MENU_ICONS[item.icon]) return MENU_ICONS[item.icon];
    if (item.type === 'builtin') return (MENU_BUILTINS[item.view] || {}).icon || 'fa-circle';
    if (item.type === 'url') return 'fa-globe';
    const kind = (item.file && item.file.kind) || 'file';
    return (typeof WS_KIND_ICONS !== 'undefined' && WS_KIND_ICONS[kind]) || 'fa-file';
}

/** Whether this console draws the entry: hidden pages and other clients' pages are skipped. */
function menuShows(item) {
    if (item.type !== 'builtin') return true;
    return !!MENU_BUILTINS[item.view] && !item.hidden;
}

function menuShowsChild(child) {
    return !!(child && MENU_BUILTINS[child.view]);
}

function menuChildMeta(child) {
    return (MENU_TAB_META[child.view] || {})[child.tab] || {};
}

function menuChildLabel(child) {
    if (child.title) return child.title;
    const meta = menuChildMeta(child);
    return meta.label ? t(meta.label) : (child.tab || '');
}

function menuChildIcon(child) {
    return menuChildMeta(child).icon || 'fa-circle';
}

/** Whether the entry's submenu is open. Open until the user folds it. */
function menuSubmenuOpen(id) {
    try {
        const saved = JSON.parse(localStorage.getItem(MENU_SUBMENUS_KEY) || '{}');
        return !saved || saved[id] !== false;
    } catch (_) { return true; }
}

function _menuSetSubmenuChrome(id, open) {
    const btn = document.querySelector(`#sidebar [data-submenu-toggle="${CSS.escape(id)}"]`);
    if (!btn) return;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', t(open ? 'menu_submenu_collapse' : 'menu_submenu_expand'));
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fas fa-chevron-' + (open ? 'down' : 'right');
}

/** Fold or unfold an entry's submenu; the choice outlives the page. */
function menuToggleSubmenu(id) {
    const open = !menuSubmenuOpen(id);
    const box = document.querySelector(`#sidebar [data-subitems="${CSS.escape(id)}"]`);
    if (box) box.classList.toggle('hidden', !open);
    _menuSetSubmenuChrome(id, open);
    try {
        const saved = JSON.parse(localStorage.getItem(MENU_SUBMENUS_KEY) || '{}') || {};
        saved[id] = open;
        localStorage.setItem(MENU_SUBMENUS_KEY, JSON.stringify(saved));
    } catch (_) { /* private mode */ }
}

/** The rail is 64px wide with no room for a chevron; hide the toggles there. */
function _menuSyncSubmenuChrome() {
    const collapsed = typeof isSidebarCollapsed === 'function'
        && isSidebarCollapsed() && window.innerWidth >= 1024;
    document.querySelectorAll('#sidebar .menu-sub-toggle').forEach(btn => {
        btn.style.display = collapsed ? 'none' : '';
    });
}

window.addEventListener('resize', _menuSyncSubmenuChrome);
// The rail toggle writes a class on <html> rather than firing an event.
new MutationObserver(_menuSyncSubmenuChrome)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

function _menuChildHTML(child) {
    const meta = menuChildMeta(child);
    const label = child.title
        ? `<span class="sidebar-label">${escapeHtml(child.title)}</span>`
        : `<span${meta.label ? ` data-i18n="${escapeHtml(meta.label)}"` : ''}>${escapeHtml(menuChildLabel(child))}</span>`;
    return `<a class="sidebar-item menu-subitem flex items-center gap-3 pl-7 pr-3 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-white/5 hover:text-neutral-200 text-[13px]"
               data-view="${escapeHtml(child.view)}" data-tab="${escapeHtml(child.tab)}">
            <i class="fas ${escapeHtml(menuChildIcon(child))} item-icon text-[10px] w-4 text-center"></i>${label}
        </a>`;
}

function _menuItemHTML(item) {
    const builtin = item.type === 'builtin';
    const tabAttr = builtin && item.tab ? ` data-tab="${escapeHtml(item.tab)}"` : '';
    const label = builtin && !item.title
        ? `<span data-i18n="${escapeHtml(MENU_BUILTINS[item.view].label)}">${escapeHtml(menuItemLabel(item))}</span>`
        : `<span class="sidebar-label">${escapeHtml(menuItemLabel(item))}</span>`;
    const external = item.type === 'url' && item.open === 'tab'
        ? '<i class="fas fa-arrow-up-right-from-square sidebar-ext"></i>' : '';
    const children = builtin ? (item.children || []).filter(menuShowsChild) : [];
    const rowClass = 'sidebar-item flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 hover:bg-white/5 hover:text-neutral-200 text-[14px]'
        + (children.length ? ' pr-8' : '');
    const anchor = `<a class="${rowClass}"
               data-view="${builtin ? escapeHtml(item.view) : 'custom'}"${tabAttr}${builtin ? '' : ` data-menu-id="${escapeHtml(item.id)}"`}>
            <i class="fas ${escapeHtml(menuItemIcon(item))} item-icon text-xs w-5 text-center"></i>${label}${external}
        </a>`;
    if (!children.length) return anchor;
    const open = menuSubmenuOpen(item.id);
    return `<div class="menu-subwrap relative">
            ${anchor}
            <button type="button" class="menu-sub-toggle absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 cursor-pointer"
                    data-submenu-toggle="${escapeHtml(item.id)}" aria-expanded="${open ? 'true' : 'false'}"
                    aria-label="${escapeHtml(t(open ? 'menu_submenu_collapse' : 'menu_submenu_expand'))}"
                    onclick="menuToggleSubmenu('${escapeHtml(item.id)}')"><i class="fas fa-chevron-${open ? 'down' : 'right'}"></i></button>
        </div>
        <div class="menu-subitems mt-0.5 space-y-0.5${open ? '' : ' hidden'}" data-subitems="${escapeHtml(item.id)}">${children.map(_menuChildHTML).join('')}</div>`;
}

function menuRenderSidebar() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;
    nav.innerHTML = menuDoc.groups.map(group => {
        const items = group.items.filter(menuShows);
        if (!items.length) return '';
        const title = !group.title && MENU_GROUP_LABELS[group.id]
            ? `<span data-i18n="${MENU_GROUP_LABELS[group.id]}">${escapeHtml(menuGroupLabel(group))}</span>`
            : `<span>${escapeHtml(menuGroupLabel(group))}</span>`;
        return `<div class="menu-group open" data-group="${escapeHtml(group.id)}">
            <div class="menu-group-head w-full flex items-center gap-2 pl-3 pr-8 py-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                ${title}
            </div>
            <button class="menu-group-edit" onclick="menuEditorOpen()" data-tip-key="menu_edit" data-tooltip="${escapeHtml(t('menu_edit'))}"
                    data-tip-float data-tooltip-pos="right" aria-label="${escapeHtml(t('menu_edit'))}"><i class="fas fa-pen"></i></button>
            <div class="menu-group-items pl-2">${items.map(_menuItemHTML).join('')}</div>
        </div>`;
    }).join('');
    document.documentElement.classList.remove('menu-pending');
    syncSidebarTips();
    _menuSyncSubmenuChrome();
    menuSyncActive();
}

/** Light the entry for what is on screen. */
function menuSyncActive() {
    const meta = VIEW_META[currentView] || {};
    const own = document.querySelector(`#sidebar .sidebar-item[data-view="${currentView}"]:not([data-menu-id])`);
    const navId = own ? currentView : (meta.nav || currentView);
    // A view entered on one of its tabs (a teaching tool) lights only that
    // tab's entry: the menu holds one entry per tab, all naming the same view.
    // routeTab is assigned by router.js, which loads after this file; the view
    // comparison keeps it untouched while the initial menu is drawn.
    const tab = currentView === 'teaching' && typeof routeTab === 'string' ? routeTab : '';
    document.querySelectorAll('#sidebar .sidebar-item').forEach(el => {
        const active = el.dataset.menuId
            ? currentView === 'custom' && el.dataset.menuId === menuCustomId
            : el.dataset.view === navId && (el.dataset.tab || '') === tab;
        el.classList.toggle('active', active);
    });
    const found = currentView === 'custom' ? menuFind(menuCustomId) : null;
    document.getElementById('breadcrumb-external')?.classList.toggle('hidden', !_menuPageTarget(found && found.item));
}

/** Take a menu document as the one in force: draw it and remember it for the next load. */
function menuApply(saved) {
    menuSaved = saved || null;
    menuDoc = menuMerge(menuSaved);
    try {
        if (menuSaved) localStorage.setItem(MENU_CACHE_KEY, JSON.stringify(menuSaved));
        else localStorage.removeItem(MENU_CACHE_KEY);
    } catch (_) { /* private mode */ }
    menuRenderSidebar();
    if (currentView === 'custom') _menuRenderPage();
}

function menuLoad() {
    return fetch('/api/menu')
        .then(r => r.json())
        .then(data => { if (data.status === 'success') menuApply(data.menu); })
        .catch(() => {})
        .finally(() => {
            menuLoaded = true;
            _menuReadyResolve();
            if (currentView === 'custom') _menuRenderPage();
        });
}

/** A click on an entry the user added: a link set to open in a tab leaves the console. */
function menuOpenItem(id) {
    const found = menuFind(id);
    if (found && found.item.type === 'url' && found.item.open === 'tab') {
        window.open(found.item.url, '_blank', 'noopener,noreferrer');
        return;
    }
    navigateTo('custom', id);
}

// ---------------------------------------------------------------------
// The custom view
// ---------------------------------------------------------------------

/** Called by navigateTo for /m/<id>. Every visit reloads the page, since the
    file or site behind an unchanged entry may have changed since the last one. */
function menuShowPage(id) {
    menuCustomId = id || '';
    menuSyncActive();
    _menuRenderPage(true);
}

function _menuSetBreadcrumb(found) {
    const group = document.getElementById('breadcrumb-group');
    const page = document.getElementById('breadcrumb-page');
    const groupKey = found && !found.group.title && MENU_GROUP_LABELS[found.group.id];
    group.textContent = found ? menuGroupLabel(found.group) : '';
    if (groupKey) group.dataset.i18n = groupKey;
    else delete group.dataset.i18n;
    page.textContent = found ? menuItemLabel(found.item) : '';
    delete page.dataset.i18n;
}

function _menuPageTarget(item) {
    if (!item || item.type === 'builtin') return '';
    if (item.type === 'url') return item.url;
    return (item.file && (item.file.preview_url || item.file.raw_url)) || '';
}

function _menuRenderPage(force) {
    const found = menuFind(menuCustomId);
    const item = found && found.item.type !== 'builtin' ? found.item : null;
    _menuSetBreadcrumb(item ? found : null);
    const key = item ? JSON.stringify(item) : (menuLoaded ? 'missing' : 'loading');
    if (!force && key === menuPageKey) return;
    menuPageKey = key;

    const body = document.getElementById('menu-page-body');
    menuSyncActive();
    if (!item) {
        body.innerHTML = menuLoaded
            ? `<div class="workspace-empty"><i class="fas fa-link-slash"></i><span>${escapeHtml(t('menu_page_missing'))}</span>
                 <button class="ws-empty-action" onclick="navigateTo('chat')"><span>${escapeHtml(t('menu_back_chat'))}</span></button></div>`
            : '<div class="workspace-empty"><i class="fas fa-spinner fa-spin"></i></div>';
        return;
    }

    body.innerHTML = '';
    if (item.type === 'url') {
        const frame = document.createElement('iframe');
        // The page keeps its own origin; the sandbox only withholds what an
        // embedded site has no business doing to the console around it.
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.src = item.url;
        body.appendChild(frame);
        return;
    }
    const file = item.file || {};
    if (!file.exists) {
        body.innerHTML = `<div class="workspace-empty"><i class="fas fa-file-circle-xmark"></i><span>${escapeHtml(t('menu_file_missing'))}</span></div>`;
        return;
    }
    const stage = document.createElement('div');
    stage.className = 'menu-page-stage';
    body.appendChild(stage);
    wsRenderPreview(Object.assign({ path: item.path }, file), stage);
}

function menuOpenPageExternally() {
    const found = menuFind(menuCustomId);
    const target = found && _menuPageTarget(found.item);
    if (target) window.open(target, '_blank', 'noopener,noreferrer');
}

// Draw what the last visit saved, so a customised menu does not flash the
// built-in one first; GET /api/menu then brings it up to date.
(function () {
    try {
        const cached = JSON.parse(localStorage.getItem(MENU_CACHE_KEY) || 'null');
        if (cached) {
            menuSaved = cached;
            menuDoc = menuMerge(cached);
        }
    } catch (_) { /* unreadable cache: the built-in menu it is */ }
    menuRenderSidebar();
})();
