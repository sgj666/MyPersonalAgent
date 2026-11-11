/* Address-bar routing: mirrors the current view and tab into the URL path, so
   a reload lands where the user left off and Back/Forward move between views.
   These are classic scripts sharing one global scope; see
   channel/web/README.md before changing the load order. */

// =====================================================================
// Routing
// =====================================================================
// A route names a view and, for the views that have tabs, one of its tabs:
// /settings, /settings/models. Only a tab that is not the view's default gets
// a segment, so the path carries what distinguishes it and nothing else.
// Deeper state -- which session is open, which file the editor holds --
// deliberately stays out. It is already restored from localStorage, and
// putting it in the URL would rewrite the address bar on every click in the
// session list.
//
// The view a route names is not always the view's internal id. /settings is
// the config view, because /config is the backend's config API, which this
// console and the desktop client both call. /scheduler is the tasks view: it
// is what the backend calls this feature already (/api/scheduler/...), and it
// leaves /tasks free for the separate notion of a task. web_channel.py serves
// these paths from the same shell; the table there has to stay in step.
const ROUTE_PATHS = {
    chat:      '',
    home:      'home',
    board:     'board',
    teaching:  'teaching',
    classes:   'classes',
    timetable: 'timetable',
    progress:  'progress',
    homework:  'homework',
    scores:    'scores',
    artifacts: 'artifacts',
    agents:    'agents',
    config:    'settings',
    skills:    'skills',
    memory:    'memory',
    knowledge: 'knowledge',
    channels:  'channels',
    tasks:     'scheduler',
    logs:      'logs',
};

// The view the console opens on. A fresh start arrives at the bare root, which
// names no view, so it lands here and the address bar is rewritten to /home
// rather than left claiming the view '/' means (chat). Pages someone asks for
// by path are deep links and are never redirected.
const ROUTE_HOME = 'home';

// An artifact or link the user put in the menu is at /m/<item id>, served by
// its own pattern in web_channel.py. The id travels as the view's "tab".
const ROUTE_MENU_SEGMENT = 'm';

const ROUTE_VIEWS = {};
for (const view in ROUTE_PATHS) ROUTE_VIEWS[ROUTE_PATHS[view]] = view;

const ROUTE_TABS = {
    config:    ['basic', 'models', 'integrations'],
    memory:    ['files', 'dreams'],
    tasks:     ['tasks', 'records'],
    knowledge: ['docs', 'graph'],
    teaching:  ['plan', 'courseware', 'card', 'advice', 'schedule'],
};

// The tab a view opens on when the route does not name one. It is left out of
// the path: /tasks, not /tasks/tasks. A path segment is there to say which of
// several tabs is showing, so the one you get by default has nothing to say.
const ROUTE_DEFAULT_TABS = {
    config:    'basic',
    memory:    'files',
    tasks:     'tasks',
    knowledge: 'docs',
    teaching:  'plan',
};

// URL segment for a tab whose element id reads as an internal name. The path
// should say what the UI says, and the "dreams" tab is labelled Self-Evolution
// everywhere the user can see it. Only the segment differs -- the element id,
// the switcher argument and ROUTE_TABS above all stay as they are.
const ROUTE_TAB_PATHS = {
    memory: { dreams: 'evolution' },
};

function _tabPath(view, tab) {
    return (ROUTE_TAB_PATHS[view] || {})[tab] || tab;
}

function _tabId(view, segment) {
    const aliases = ROUTE_TAB_PATHS[view] || {};
    for (const tab in aliases) if (aliases[tab] === segment) return tab;
    // Unaliased segments are the tab id itself. An alias's own id also lands
    // here, so a hand-written /memory/dreams still opens the tab and is
    // rewritten to /memory/evolution by the settle at the end of routeApply.
    return segment;
}

// The tab showing in the current view, '' for a view that has none. Tracked so
// a navigation the unsaved-edit guard refuses can put the address bar back
// exactly where it was.
let routeTab = '';

// Set while a route is being applied to the page. The handlers that normally
// write the address bar then leave it alone: it already says what is being
// applied, and writing would stack a duplicate entry onto the history.
let _routeApplying = false;

// Whether the address bar has been read once already. Only the first read of a
// page load can be the console starting rather than the user going somewhere.
let _routeStarted = false;

function _routePath(view, tab) {
    if (view === 'custom') return '/' + ROUTE_MENU_SEGMENT + '/' + encodeURIComponent(tab || '');
    const path = ROUTE_PATHS[view] || '';
    if (!path || !tab || tab === ROUTE_DEFAULT_TABS[view]) return '/' + path;
    return '/' + path + '/' + _tabPath(view, tab);
}

function _routeParse(pathname) {
    const parts = String(pathname || '/').replace(/^\/+|\/+$/g, '').split('/');
    if (parts[0] === ROUTE_MENU_SEGMENT && parts[1]) {
        let id = parts[1];
        try { id = decodeURIComponent(id); } catch (_) { /* keep it as typed */ }
        return { view: 'custom', tab: id };
    }
    const view = ROUTE_VIEWS[parts[0] || ''];
    // An unknown path -- a stale bookmark, a hand-edited URL -- falls back to
    // chat rather than leaving the console on whatever happens to be on screen.
    if (!view || !VIEW_META[view]) return { view: 'chat', tab: '' };
    const allowed = ROUTE_TABS[view] || [];
    const tab = _tabId(view, parts[1]);
    // An unknown tab is dropped, not passed on: the tab switchers index into
    // the DOM by name and would throw on one that does not exist.
    return { view: view, tab: allowed.indexOf(tab) === -1 ? '' : tab };
}

function _routeWrite(view, tab, replace) {
    const path = _routePath(view, tab);
    if (location.pathname === path) return;
    // pushState/replaceState do not fire popstate, so writing the address bar
    // cannot loop back in as a navigation.
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
}

function _routeApplyTab(view, tab) {
    if (view === 'config') switchConfigTab(tab);
    else if (view === 'memory') switchMemoryTab(tab);
    else if (view === 'tasks') switchTasksTab(tab);
    else if (view === 'knowledge') switchKnowledgeTab(tab);
    else if (view === 'teaching') twTeachSelectTool(tab);
    else if (view === 'custom') navigateTo('custom', tab);
}

// Called by navigateTo() once it has committed to a view: the history gains an
// entry, so Back returns to where the user came from.
function routeEnterView(view, tab) {
    if (!VIEW_META[view]) return;
    // The custom view is one view for every entry the user added, so which
    // one it shows is part of the destination, not a refinement of it.
    routeTab = view === 'custom' ? (tab || '') : '';
    if (_routeApplying) return;
    // Re-entering the view already on screen -- clicking its sidebar item
    // again -- is not a new destination. Refine the entry instead of stacking
    // another, or Back would have to undo a run of no-op navigations before it
    // appeared to do anything.
    const here = _routeParse(location.pathname);
    const reentry = here.view === view && (view !== 'custom' || here.tab === routeTab);
    _routeWrite(view, routeTab, reentry);
}

// Called by the tab switchers. A tab is a refinement of the view already on
// screen rather than a new destination, so it replaces the entry navigateTo
// just pushed instead of stacking another one -- Back then leaves the view,
// instead of stepping back through every tab visited inside it.
function routeNoteTab(view, tab) {
    if (view !== currentView) return;
    routeTab = tab;
    if (_routeApplying) return;
    _routeWrite(view, tab, true);
}

// Whether this apply is the console starting: the first read of a fresh page
// load whose address bar names nothing. A bare root is the address the console
// is opened at, not a view, so it means home. A reload or a Back/Forward is the
// user returning to what the bar says -- and a path that names a view is a deep
// link -- so both are applied as they are.
function _routeStartIsHome() {
    if (_routeStarted) return false;
    _routeStarted = true;
    if (String(location.pathname || '/').replace(/^\/+|\/+$/g, '') || location.hash) return false;
    const entry = typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('navigation')[0] : null;
    return !entry || entry.type === 'navigate';
}

// Apply what the address bar says: on Back/Forward, and once at startup.
function routeApply() {
    if (_routeStartIsHome()) {
        _routeApplying = true;
        try { navigateTo(ROUTE_HOME); }
        finally { _routeApplying = false; }
        // replaceState rather than pushState: the empty root was never a place
        // the user chose, so Back has no reason to return to it.
        _routeWrite(ROUTE_HOME, '', true);
        return;
    }

    const parsed = _routeParse(location.pathname);

    if (parsed.view === currentView) {
        // No tab segment names the view's default tab, rather than meaning
        // "leave the tab alone". Back out of /tasks/records lands on /tasks,
        // which has to put the tasks tab up again -- otherwise the page would
        // keep showing records and the settle below would undo the Back.
        const wanted = parsed.tab || ROUTE_DEFAULT_TABS[parsed.view] || '';
        if (wanted && wanted !== routeTab) {
            _routeApplying = true;
            try { _routeApplyTab(parsed.view, wanted); }
            finally { _routeApplying = false; }
        }
    } else {
        _routeApplying = true;
        try { navigateTo(parsed.view, parsed.tab); }
        finally { _routeApplying = false; }
    }

    // Settle the address bar on whatever ended up on screen. Usually it
    // already says that and this writes nothing. It earns its keep in the two
    // cases where the path and the page disagree: a path the router does not
    // write itself (/settings/bogus lands on the default tab, /memory/dreams
    // normalises to /memory/evolution) is rewritten to its canonical form; and
    // a navigation the unsaved-edit guard refused leaves the page where it
    // was, so the address bar -- which Back has already moved -- goes back too.
    _routeWrite(currentView, routeTab, true);
}

window.addEventListener('popstate', routeApply);
