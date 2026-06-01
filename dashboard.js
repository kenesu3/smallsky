/* SmallSky dashboard — live data orchestrator.
 * Imports the API + derive + storage layers and renders the page.
 *
 * Loading strategy:
 *   1. Render cached data immediately (fast first paint)
 *   2. Kick off live fetches in background
 *   3. Re-render with fresh data when each chunk lands
 *   4. Show inline error toast if not logged in
 */

import * as api from './lib/api.js';
import * as store from './lib/store.js';
import * as derive from './lib/derive.js';
import { ICONS } from './lib/icons.js';
import { makeLimiter } from './lib/queue.js';
import { checkForUpdate, getUpdateStatus, getDismissedVersion, dismissUpdate } from './lib/updater.js';
import { DAY_MS, CSB_ROOT_OU, escapeHtml, sanitizeAnnouncementHtml } from './lib/util.js';
import { initDrawer, openTaskDrawer } from './lib/ui/drawer.js';
import { initSchedule, renderSchedule } from './lib/ui/schedule.js';
import { initAnnouncementModal, openAnnouncementModal } from './lib/ui/announce-modal.js';
import { initUpdateModal, renderUpdateBanner, openUpdateModal } from './lib/ui/update-modal.js';
import { showToast, showError } from './lib/ui/toast.js';
import { positionAnchored, bindDismissable } from './lib/ui/popover.js';
import { initPhoto, triggerPhotoUpload } from './lib/ui/photo.js';
import { initAvatar, triggerAvatarUpload, removeAvatar } from './lib/ui/avatar.js';
import { initClassSchedule, openScheduleEditor, liveBadgeHtml } from './lib/ui/class-schedule.js';
import { initSearch } from './lib/ui/search.js';

const TTL = store.TTL;
const fetchLimit = makeLimiter(6);  // max 6 concurrent fetches to BigSky

/* Theme palettes — declared at module top so they're initialized before
 * init() runs (which calls initTheme() that references VALID_PALETTES).
 * Each palette has matching CSS blocks in dashboard.css under [data-theme="<id>"].
 * The bg/accent hex values here are LIGHT-mode previews used only by the
 * settings swatch picker; the actual theme is applied via CSS variables. */
const VALID_PALETTES = ['default', 'ocean', 'lavender', 'rose', 'mocha', 'benilde', 'slate', 'plain'];

/* Per-version changelog shown in Settings → About → "What's new in vX".
 * Each entry is a list of <li>-ready HTML strings (light formatting allowed,
 * author-controlled so no sanitization needed). Add a new entry whenever
 * you bump the version — see CONTRIBUTING.md release checklist. */
const CHANGELOG = {
  '1.1.1': [
    'Fixed the "What\'s new" panel in Settings showing the old v1.0.0 changelog instead of the version you\'re actually on. It\'s now dynamic — future releases just need a new entry in the changelog map, no separate HTML edit.',
  ],
  '1.1.0': [
    '<strong>Online class schedule</strong> — set meeting days, time, and link per course in the "···" menu. A green LIVE pill appears on the tile during class, with a 15-min countdown before.',
    '<strong>Eight color themes</strong> — Default, Cipher, Castorice, Hyacine, Cerydra, Hysilens, Mydei, Anaxa. Each has its own light/dark variant; switching plays a satisfying wave transition.',
    '<strong>Custom profile avatar</strong> — upload any photo in the profile menu, cropped to a circle, stored locally.',
    '<strong>Smooth slide-open for What\'s New</strong> — announcements expand inline with the My Classes column riding the same height change.',
    '<strong>Bell ring animation</strong> paired with the settings cog spin — friendly click acknowledgments.',
    '<strong>Old course data cleanup</strong> — Settings → Data has a new Scan button to remove schedules and photos from courses no longer in your list.',
    'No more white flash on dark-mode reloads — the theme now applies before first paint.',
    'Plenty of polish — fixed the course peek occasionally flying to the corner, removed a stuck-hover glow on Up Next cards, friendlier urgency indicators, and a long list of smaller fixes.',
    'Major internal refactor — split the main dashboard into modular UI files. Invisible to you, but future updates ship faster and cleaner.',
  ],
  '1.0.0': [
    'Live BigSky data — courses, assignments, quizzes, grades, announcements pull straight from D2L\'s API with proper auth-session reuse.',
    '<strong>Up Next</strong> — the four most urgent unsubmitted assignments and quizzes, sorted by due date, with real submission detection.',
    '<strong>What\'s New</strong> — recent announcements with inline expand (no leaving the dashboard to read).',
    '<strong>Month Schedule</strong> — calendar view of every dated event across all your courses, with day-by-day agenda.',
    '<strong>Course tiles</strong> — color-coded pastels (stable per course code), real BigSky course photos, "next due" + "latest announcement" highlights, click-to-peek with weeks navigation.',
    '<strong>Pin / hide / reorder</strong> — make the grid yours; admin courses move to a collapsed "Other" section.',
    '<strong>Custom course photos</strong> — upload anything, auto-cropped to the BigSky banner aspect.',
    '<strong>Local notes</strong> — pencil icon on every Up Next card, scratchpad per assignment, saved on this device only.',
    '<strong>Cross-course search</strong> — press <kbd>/</kbd> to fuzzy-search announcements, modules, assignments, quizzes — all instant.',
    '<strong>Light / dark theme</strong> — click the moon/sun for a smooth circle-reveal transition between themes.',
    '<strong>Background sync + Chrome badge</strong> — service worker pings every 5 minutes, toolbar icon shows count of items due within 48 hours.',
    '<strong>Auto-open SmallSky</strong> — optional redirect from BigSky\'s homepage to SmallSky, so you land here first thing.',
    '<strong>Smart caching</strong> — tiered TTLs per resource (1 min for submission status, 24 h for whoami), stale-while-revalidate so first paint is always instant.',
    '<strong>Daily update check</strong> — SmallSky pings GitHub once a day; a soft banner appears when a new version is out.',
    'Lots of soft touches — animated cog spin, cute logo shake, hover effects, friendly empty states.',
  ],
};
// Display names are decorative — the `id` is the canonical key in CSS,
// localStorage, and the data-theme attribute. Renaming `name` is safe;
// don't touch `id` without migrating storage.
const PALETTES = [
  { id: 'default',  name: 'Default',   bg: '#FAF2E2', accent: '#5B4FB8' },
  { id: 'mocha',    name: 'Cipher',    bg: '#ECDBC2', accent: '#8B5A3C' },
  { id: 'lavender', name: 'Castorice', bg: '#EFE4F4', accent: '#8B5CF6' },
  { id: 'rose',     name: 'Hyacine',   bg: '#F5DCE0', accent: '#C75B7A' },
  { id: 'ocean',    name: 'Cerydra',   bg: '#E3EEF7', accent: '#4A7FC9' },
  { id: 'slate',    name: 'Hysilens',  bg: '#DBE3EC', accent: '#455A75' },
  { id: 'plain',    name: 'Mydei',     bg: '#FFFFFF', accent: '#FF4500' },
  { id: 'benilde',  name: 'Anaxa',     bg: '#DCEDE1', accent: '#006937' },
];

/* Per-resource cached fetcher with concurrency cap. */
function cachedFetch(key, fn, ttl, opts = {}) {
  return store.cached(key, () => fetchLimit(fn), ttl, opts);
}

/* Load (or background-refresh) one course's full bundle.
 *
 * Each piece has its own TTL so we don't refetch slow-changing data when only
 * fast-changing data has expired. swr=true means stale data renders instantly
 * while the network refresh runs in parallel. */
async function loadCourseBundle(ouId, { swr = true, onPartial = null } = {}) {
  const ks = (n) => `${n}:${ouId}`;
  // Map cache key name → bundle property name (some differ).
  const BUNDLE_KEY = {
    news: 'news', dropbox: 'dropbox', quizzes: 'quizzes', grades: 'grades',
    submitted: 'submittedFolderIds', quizAttempts: 'quizAttempts'
  };
  const fire = (cacheName) => (v) => {
    if (onPartial) onPartial(ouId, BUNDLE_KEY[cacheName], v);
  };

  const [news, dropbox, quizzes, grades, submitted] = await Promise.all([
    cachedFetch(ks('news'),      () => api.courseNews(ouId),     TTL.news,      { swr, onRefresh: fire('news') }),
    cachedFetch(ks('dropbox'),   () => api.courseDropbox(ouId),  TTL.dropbox,   { swr, onRefresh: fire('dropbox') }),
    cachedFetch(ks('quizzes'),   () => api.courseQuizzes(ouId),  TTL.quizzes,   { swr, onRefresh: fire('quizzes') }),
    cachedFetch(ks('grades'),    () => api.courseGrades(ouId),   TTL.grades,    { swr, onRefresh: fire('grades') }),
    cachedFetch(ks('submitted'), () => api.dropboxSubmittedIds(ouId), TTL.submitted, { swr, onRefresh: fire('submitted') }),
  ]);

  // Quiz attempts — one fetch per quiz, aggregated into a map keyed by quizId.
  // Has to come AFTER we know which quizzes exist for this course.
  const quizList = (quizzes.value && quizzes.value.Objects) || [];
  const quizAttemptsResult = await cachedFetch(
    ks('quizAttempts'),
    async () => {
      const out = {};
      await Promise.all(quizList.map(q => fetchLimit(async () => {
        try {
          const data = await api.quizAttempts(ouId, q.QuizId);
          out[q.QuizId] = summarizeQuizAttempts(data);
        } catch (e) {
          // 403 / 404 on individual quizzes is fine — quiz might not be open yet,
          // user might lack access, etc. Just leave that quiz unsummarized.
        }
      })));
      return out;
    },
    TTL.quizAttempts,
    { swr, onRefresh: fire('quizAttempts') }
  );

  return {
    news: news.value,
    dropbox: dropbox.value,
    quizzes: quizzes.value,
    grades: grades.value,
    submittedFolderIds: submitted.value,
    quizAttempts: quizAttemptsResult.value,
  };
}

/* Compact summary of an attempts API response, suitable for storage + UI. */
function summarizeQuizAttempts(response) {
  const objs = (response && response.Objects) || [];
  const completed = objs.filter(a => a.AttemptCompleted);
  const inProgress = objs.filter(a => a.AttemptInProgress);
  // Latest completed attempt's score (D2L returns Score as a number or null)
  let latestScore = null;
  if (completed.length) {
    const last = completed.sort((a, b) =>
      new Date(b.AttemptCompleted) - new Date(a.AttemptCompleted)
    )[0];
    if (typeof last.AttemptScore === 'number') latestScore = last.AttemptScore;
  }
  return {
    count: objs.length,
    completedCount: completed.length,
    inProgressCount: inProgress.length,
    hasCompleted: completed.length > 0,
    hasInProgress: inProgress.length > 0,
    latestScore,
  };
}

/* ---- DOM helpers ---- */
const $ = (sel) => document.querySelector(sel);

/* ---- top-level state ---- */
const _today = new Date();
const state = {
  me: null,
  courses: [],          // raw mycourses
  bundles: {},          // ouId -> { news, dropbox, quizzes, grades, ... }
  prefs: { pinned: [], hidden: [], colorOverride: {} },
  photos: {},           // ouId -> dataURL of custom course photo
  notes: {},            // taskId -> note text
  hiddenExpanded: false,
  avatar: null,         // user-uploaded avatar dataURL (cosmetic)
  classSchedules: {},   // ouId -> { link, blocks: [{ days, time, duration }] }
  scheduleYear: _today.getFullYear(),
  scheduleMonth: _today.getMonth(),
  scheduleSelected: derive.dayKey(_today),
  err: null,
};

/* ---- bootstrap ---- */

init().catch(e => {
  console.error('SmallSky boot failed:', e);
  showError(e.message || 'Unexpected error.');
});

async function init() {
  initTheme();
  renderTopbar();
  renderGreeting('…');
  wireGlobalEvents();

  // Prefs (pin/hide) + custom photos + notes + read-state + avatar + class schedules
  // load immediately so first render reflects them.
  [state.prefs, state.photos, state.notes, state._read, state.avatar, state.classSchedules] = await Promise.all([
    store.getPrefs(), store.getCoursePhotos(), store.getNotes(),
    store.getRead(), store.getAvatar(), store.getClassSchedules(),
  ]);
  applyCafeMode();

  // Re-render once per minute so the Live badge countdown stays accurate
  // and "soon" → "live" transitions happen automatically.
  setInterval(() => { if (state.courses.length) render(); }, 60_000);

  // Update banner: render any cached status immediately, then kick off a
  // fresh check in the background (don't block first paint).
  state.updateStatus = await getUpdateStatus();
  state.updateDismissed = await getDismissedVersion();
  renderUpdateBanner();
  checkForUpdate().then(async () => {
    state.updateStatus = await getUpdateStatus();
    renderUpdateBanner();
  }).catch(() => {});

  try {
    // swr=true: every layer serves stale cache instantly and refreshes in
    // the background. First paint never blocks on the network.
    await refreshAll({ swr: true });
  } catch (e) {
    state.err = e;
    if (e.code === 'AUTH') {
      // Only lock the user out if we have nothing to show. With any cached
      // whoami/courses we can still render the dashboard with a "lapsed
      // session" banner — much friendlier than a hard redirect.
      const hasCache = !!(await store.cacheGet('whoami'));
      if (!hasCache) {
        showLoggedOutScreen();
        return;
      }
      showError('BigSky session may have lapsed — showing cached data. Click refresh to retry.');
    } else if (e.code === 'NON_JSON') {
      showError(`BigSky returned an unexpected response. Click refresh to retry.`);
    } else {
      showError(`Couldn't reach BigSky: ${e.message}`);
    }
  }
  render();
}

async function refreshAll({ swr = true } = {}) {
  // Top-level resources, each with its own TTL.
  const [meR, mcR, enrollR] = await Promise.all([
    cachedFetch('whoami', () => api.whoami(),         TTL.whoami,     { swr, onRefresh: v => { state.me = v; render(); } }),
    cachedFetch('mycourses', () => api.myCourses(),   TTL.courseList, { swr, onRefresh: () => scheduleReRender() }),
    cachedFetch('enrollments', () => api.myEnrollments(), TTL.courseList, { swr, onRefresh: () => scheduleReRender() }),
  ]);
  state.me = meR.value;

  // Build last-accessed map from enrollments (still useful for sort order).
  const accessMap = {};
  for (const it of (enrollR.value.Items || [])) {
    if (it.OrgUnit && it.Access && it.Access.LastAccessed) {
      accessMap[String(it.OrgUnit.Id)] = it.Access.LastAccessed;
    }
  }

  // Filter to active accessible courses, merge LastAccessed.
  const courses = (mcR.value.Courses || [])
    .filter(c => c.CanAccessCourse && c.IsActive)
    .map(c => ({ ...c, LastAccessed: accessMap[String(c.OrgUnitId)] || null }));
  state.courses = courses;

  // Render tiles immediately (no per-course data yet — preview will say "loading…"-ish).
  render();

  // Per-course bundles — fan out with concurrency cap, render as each lands.
  const bundles = { ...state.bundles };
  await Promise.all(courses.map(async (c) => {
    try {
      const b = await loadCourseBundle(c.OrgUnitId, {
        swr,
        // When a background SWR refresh lands fresh data, splice it into
        // state.bundles and re-render — otherwise the UI keeps showing stale
        // values forever after the first paint.
        onPartial: (id, key, value) => {
          if (!state.bundles[id]) state.bundles[id] = {};
          state.bundles[id][key] = value;
          scheduleReRender();
        },
      });
      bundles[c.OrgUnitId] = { ...(bundles[c.OrgUnitId] || {}), ...b };
      state.bundles = bundles;
      render();
    } catch (e) {
      console.warn('bundle failed for', c.OrgUnitId, e);
    }
  }));

  // Warm TOCs in the background so cross-course search can include module names.
  // Idle-style: low priority, no rendering changes.
  warmAllTOCs(courses);
}

async function warmAllTOCs(courses) {
  for (const c of courses) {
    const ouId = c.OrgUnitId;
    if (state.bundles[ouId]?.toc) continue;
    try {
      const r = await store.cached(`toc:${ouId}`, () => fetchLimit(() => api.courseTOC(ouId)), TTL.toc, { swr: true });
      state.bundles[ouId] = { ...(state.bundles[ouId] || {}), toc: r.value };
    } catch { /* tolerate */ }
  }
}

/* Coalesces several SWR refresh signals into one render per animation frame. */
let _rafScheduled = false;
function scheduleReRender() {
  if (_rafScheduled) return;
  _rafScheduled = true;
  requestAnimationFrame(() => { _rafScheduled = false; render(); });
}

/* ---- rendering ---- */

function renderTopbar() {
  $('[data-action="settings"]').innerHTML = ICONS.settings;
  $('[data-action="bell"]').insertAdjacentHTML('afterbegin', ICONS.bell);
  $('#search-icon-slot').innerHTML = ICONS.search;
  refreshThemeIcon();
}

function refreshThemeIcon() {
  const isDark = document.documentElement.dataset.mode === 'dark';
  $('[data-action="theme"]').innerHTML = isDark ? ICONS.sun : ICONS.moon;
}

function renderGreeting(name) {
  const period = derive.greeting();
  const first = name && name !== '…' ? name.split(' ')[0] : '…';
  const cap = first === '…' ? '…' : first.charAt(0) + first.slice(1).toLowerCase();
  $('#greeting-headline').textContent = `Good ${period}, ${cap}.`;
  // Sub-line: tasks due soon + new announcements, with "due today" emphasis
  const items = state._upNext || [];
  const upcoming = items.length;
  const dueToday = items.filter(t => {
    if (!t.due) return false;
    const d = new Date(t.due);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }).length;
  const newAnnounce = state._feed ? state._feed.filter(f => f.kind === 'announcement').length : 0;
  const sub = $('#greeting-sub');
  if (state.courses.length === 0) {
    sub.textContent = 'Welcome to SmallSky.';
  } else if (dueToday > 0) {
    // Bold accent-colored "due today" emphasis
    const todayLabel = dueToday === 1 ? '1 thing due today' : `${dueToday} things due today`;
    const otherCount = upcoming - dueToday;
    const parts = [`<span class="greeting-due-today">${escapeHtml(todayLabel)}</span>`];
    if (otherCount > 0) parts.push(`${otherCount} more due soon`);
    if (newAnnounce > 0) parts.push(newAnnounce === 1 ? '1 announcement' : `${newAnnounce} announcements`);
    sub.innerHTML = `You have ${parts.join(' and ')}.`;
  } else {
    const parts = [];
    parts.push(upcoming === 1 ? '1 thing due soon' : `${upcoming} things due soon`);
    if (newAnnounce > 0) parts.push(newAnnounce === 1 ? '1 announcement' : `${newAnnounce} announcements`);
    sub.textContent = `You have ${parts.join(' and ')}.`;
  }
}

function render() {
  const firstName = state.me ? state.me.FirstName : '…';
  renderGreeting(firstName);

  // Avatar — show custom photo if uploaded, else initials.
  // D2L can return null/empty name fields on incomplete profiles, so guard both.
  if (state.me || state.avatar) {
    const fn = (state.me && state.me.FirstName) || '';
    const ln = (state.me && state.me.LastName) || '';
    const initials = (fn[0] || '') + (ln[0] || '');
    const avatar = $('.avatar');
    if (state.avatar) {
      avatar.innerHTML = `<img class="avatar-img" src="${escapeHtml(state.avatar)}" alt="">`;
    } else {
      avatar.textContent = initials.toUpperCase() || '·';
    }
    avatar.setAttribute('aria-label', `${fn} ${ln}`.trim() || 'Profile');
  }


  // Compose view models
  const arranged = derive.arrangeCourses(state.courses.map(stringIds), state.prefs);
  const visibleCourses = [...arranged.pins, ...arranged.main];
  // Up Next = active todos only. Submitted items disappear from this list
  // (you've done them — they're no longer "up next").
  state._upNext = derive.buildUpNext(visibleCourses, state.bundles, { withinDays: 21, includeSubmitted: false }).slice(0, 4);
  state._feed   = derive.buildFeed(visibleCourses, state.bundles, { limit: 10 });

  renderUpNext(state._upNext);
  renderCourses(arranged);
  renderFeed(state._feed);
  renderGradeSummary(visibleCourses);
  renderSchedule();
  updateBellBadge();
}


/* Ensure OrgUnitId is a string everywhere (D2L mixes types). */
function stringIds(c) { return { ...c, OrgUnitId: String(c.OrgUnitId) }; }

const STATUS = {
  todo:   { label: 'Not yet started', cls: '',           icon: null },
  draft:  { label: 'In progress',     cls: '',           icon: null },
  done:   { label: 'Submitted',       cls: 'pill--done', icon: 'check' },
  graded: { label: 'Graded',          cls: 'pill--done', icon: 'check' },
};

function renderUpNext(items) {
  const grid = $('#up-next-grid');
  if (!items.length) {
    grid.innerHTML = `<div class="empty-card">Nothing due in the next 3 weeks. Breathe.</div>`;
    return;
  }
  grid.innerHTML = items.map((t, i) => {
    const ci = derive.colorIndex(t.courseCode);
    const urgent = i === 0 && daysUntil(t.due) <= 3 && t.status !== 'done';
    const st = STATUS[t.status] || STATUS.todo;
    const hasNote = !!(state.notes[t.id] && state.notes[t.id].trim());
    return `
      <a class="task-card${urgent ? ' task-card--urgent' : ''}${hasNote ? ' has-note' : ''}"
         href="${t.href}" target="_blank" rel="noopener"
         data-task-id="${escapeHtml(t.id)}"
         data-task-title="${escapeHtml(t.title)}">
        <button class="task-notes-btn" type="button" aria-label="Note" data-notes-toggle>
          ${ICONS.edit}
        </button>
        <div class="task-head">
          <span class="chip chip-c${ci}">${escapeHtml(t.courseCode)}</span>
          <span class="task-due">${escapeHtml(derive.dueLabel(t.due))}</span>
        </div>
        <div class="task-title-row">
          <span class="task-icon">${ICONS[t.icon] || ICONS.file}</span>
          <div>
            <div class="task-title">${escapeHtml(t.title)}</div>
            <div class="task-type">${escapeHtml(t.type)}</div>
          </div>
        </div>
        <div class="task-foot">
          <span class="pill ${st.cls}">${st.icon ? ICONS[st.icon] : ''}${st.label}</span>
        </div>
      </a>
    `;
  }).join('');

  // Wire notes buttons
  grid.querySelectorAll('[data-notes-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.task-card');
      openNotesPopover(card);
    });
  });

  // Intercept Up Next card clicks → open the inline detail drawer.
  // Ctrl/Cmd/Shift/middle-click still go straight to BigSky (escape hatch).
  grid.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      if (e.target.closest('[data-notes-toggle]')) return; // notes button has its own handler
      e.preventDefault();
      const taskId = card.dataset.taskId;
      const task = (state._upNext || []).find(t => t.id === taskId);
      if (task) openTaskDrawer(task);
    });
  });
}

function renderCourses(arranged) {
  const grid = $('#course-grid');
  const items = [...arranged.pins, ...arranged.main];
  if (!items.length && !arranged.hidden.length) {
    grid.innerHTML = `<div class="empty-card">No active courses found. Are you logged into BigSky?</div>`;
    return;
  }

  let html = items.map(c => courseTile(c, arranged.pins.includes(c))).join('');

  if (arranged.hidden.length) {
    const expanded = state.hiddenExpanded;
    html += `
      <div class="hidden-section" data-expanded="${expanded}">
        <button class="hidden-section-toggle" type="button" data-toggle-hidden>
          <span>Other courses (${arranged.hidden.length})</span>
          <span class="hidden-section-chevron">${expanded ? '−' : '+'}</span>
        </button>
        <div class="hidden-section-body"${expanded ? '' : ' hidden'}>
          ${arranged.hidden.map(c => courseTile(c, false, { dimmed: true })).join('')}
        </div>
      </div>
    `;
  }

  grid.innerHTML = html;
  grid.querySelectorAll('.course-tile-photo').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
  });
  // Hidden toggle
  const toggle = grid.querySelector('[data-toggle-hidden]');
  if (toggle) toggle.addEventListener('click', () => {
    state.hiddenExpanded = !state.hiddenExpanded;
    render();
  });
  // Overflow buttons → open menu
  grid.querySelectorAll('[data-overflow]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCourseMenu(btn.dataset.overflow, btn);
    });
  });
  // Live badge clicks → open the saved link, or the schedule editor if no link
  grid.querySelectorAll('[data-live-link]').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const link = badge.dataset.liveLink;
      const ouId = badge.dataset.liveOu;
      if (link) {
        window.open(link, '_blank', 'noopener');
      } else {
        // LIVE but no link set yet — let user paste one in.
        const tile = badge.closest('.course-tile');
        const code = tile && tile.dataset.courseCode;
        openScheduleEditor(ouId, badge, code);
      }
    });
  });
  // Clickable announcement highlights → open inline modal
  grid.querySelectorAll('[data-news-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAnnouncementModal(btn.dataset.newsCourse, btn.dataset.newsId);
    });
  });
  wireCoursePeek();
}

function courseTile(c, isPinned, opts = {}) {
  const code = derive.shortCode(c);
  const name = derive.displayName(c) || c.Name;
  const ci = derive.colorIndex(code);
  const customPhoto = state.photos[String(c.OrgUnitId)];
  const imgUrl = customPhoto || api.courseImageUrl(c.OrgUnitId);
  const preview = tilePreview(c);
  const highlights = tileHighlights(c);
  const cls = [
    'course-tile',
    isPinned ? 'course-tile--pinned' : '',
    opts.dimmed ? 'course-tile--dimmed' : '',
    // Preserve the peek-anchor highlight across re-renders triggered by
    // background bundle refreshes that happen while a peek is open.
    peekState.openId === String(c.OrgUnitId) ? 'course-tile--peeking' : '',
  ].filter(Boolean).join(' ');
  return `
    <a class="${cls}"
       href="${api.BASE}/d2l/home/${c.OrgUnitId}"
       data-course-id="${c.OrgUnitId}"
       data-course-code="${escapeHtml(code)}"
       style="--course-bg: var(--c${ci}-bg); --course-fg: var(--c${ci}-fg);">
      <img class="course-tile-photo" src="${imgUrl}" alt="" loading="lazy">
      ${liveBadgeHtml(c.OrgUnitId, state.classSchedules)}
      ${isPinned ? `<span class="course-tile-pin-badge" aria-label="Pinned">${ICONS.pin}</span>` : ''}
      <button class="course-tile-overflow" aria-label="Course options" data-overflow="${c.OrgUnitId}">${ICONS.more}</button>
      <div class="course-tile-body">
        <div class="course-tile-code">${escapeHtml(code)}</div>
        <div class="course-tile-name">${escapeHtml(name)}</div>
        <div class="course-tile-meta tone-${preview.tone}">${preview.label}</div>
        ${highlights.length ? `
          <div class="course-tile-highlights">
            ${highlights.map(h => {
              const clickable = h.kind === 'announcement' && h.newsId;
              const Tag = clickable ? 'button' : 'div';
              const attrs = clickable
                ? `type="button" data-news-id="${escapeHtml(String(h.newsId))}" data-news-course="${escapeHtml(String(h.courseId))}"`
                : '';
              return `
                <${Tag} class="course-tile-highlight${clickable ? ' course-tile-highlight--clickable' : ''}" ${attrs}>
                  <span class="course-tile-highlight-icon">${ICONS[h.icon]}</span>
                  <span class="course-tile-highlight-title">${escapeHtml(h.title)}</span>
                  <span class="course-tile-highlight-when">${escapeHtml(h.when)}</span>
                </${Tag}>
              `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    </a>
  `;
}

/* Compose up to 2 highlight rows for a course tile.
 * 1. Next unsubmitted assignment due soon (next 21 days)
 * 2. Latest announcement posted in past 14 days (clickable → inline modal)
 *
 * Each highlight may carry an action token: { kind: 'announcement', newsId }
 * which renderCourses wires up as a click → openAnnouncementModal. */
function tileHighlights(c) {
  const b = state.bundles[c.OrgUnitId] || {};
  const submitted = new Set((b.submittedFolderIds || []).map(String));
  const out = [];
  const now = Date.now();

  /* Next due unsubmitted assignment within 21 days. Skip closed-window. */
  const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
  const upcoming = folders
    .filter(f => f.DueDate && !submitted.has(String(f.Id)))
    .filter(f => {
      const endDate = f.Availability && f.Availability.EndDate;
      if (endDate && new Date(endDate).getTime() < now) return false;
      const t = new Date(f.DueDate).getTime();
      return t >= now - DAY_MS && t <= now + 21 * DAY_MS;
    })
    .sort((a, b) => new Date(a.DueDate) - new Date(b.DueDate));
  if (upcoming[0]) {
    out.push({
      icon: 'calendar',
      title: upcoming[0].Name,
      when: shortDue(upcoming[0].DueDate),
      kind: 'due',
    });
  }

  /* Latest announcement in past 14 days — clickable. */
  const news = (b.news && !b.news.__error) ? b.news : [];
  const sorted = [...news].sort((a, b) =>
    new Date(b.LastModifiedDate || b.CreatedDate) - new Date(a.LastModifiedDate || a.CreatedDate)
  );
  const latest = sorted[0];
  if (latest) {
    const t = new Date(latest.LastModifiedDate || latest.CreatedDate).getTime();
    if (t > now - 14 * DAY_MS) {
      out.push({
        icon: 'megaphone',
        title: latest.Title,
        when: derive.relativeTime(latest.LastModifiedDate || latest.CreatedDate),
        kind: 'announcement',
        newsId: latest.Id,
        courseId: c.OrgUnitId,
      });
    }
  }
  return out;
}

/* Compact due label for tiles (less verbose than dueLabel used in Up Next). */
function shortDue(iso) {
  const t = new Date(iso).getTime();
  const days = Math.round((t - Date.now()) / DAY_MS);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* Compute the small "preview" line under the course name.
 * "2 due · 1 new" — actionable signal. "All caught up" when 0/0. */
function tilePreview(c) {
  const b = state.bundles[c.OrgUnitId] || {};
  const submitted = new Set((b.submittedFolderIds || []).map(String));

  // Unsubmitted assignments due in next 7 days, submission window still open
  const now = Date.now();
  const horizon = now + 7 * DAY_MS;
  const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
  let dueCount = 0;
  for (const f of folders) {
    if (!f.DueDate) continue;
    if (submitted.has(String(f.Id))) continue;
    const endDate = f.Availability && f.Availability.EndDate;
    if (endDate && new Date(endDate).getTime() < now) continue; // window closed
    const t = new Date(f.DueDate).getTime();
    if (t >= now && t <= horizon) dueCount++;
  }

  // Announcements posted in past 7 days
  const week = now - 7 * DAY_MS;
  const news = (b.news && !b.news.__error) ? b.news : [];
  let newCount = 0;
  for (const n of news) {
    const t = new Date(n.LastModifiedDate || n.CreatedDate).getTime();
    if (t >= week) newCount++;
  }

  if (dueCount === 0 && newCount === 0) {
    return { label: 'All caught up', tone: 'calm' };
  }
  const parts = [];
  if (dueCount > 0) parts.push(`${dueCount} due`);
  if (newCount > 0) parts.push(`${newCount} new`);
  return { label: parts.join(' · '), tone: dueCount > 0 ? 'attention' : 'info' };
}

function renderFeed(items) {
  const list = $('#feed');
  if (!items.length) {
    list.innerHTML = `<li class="feed-empty">No new activity. You're caught up.</li>`;
    return;
  }
  list.innerHTML = items.map(it => {
    const ci = derive.colorIndex(it.courseCode);
    let body = '';
    if (it.kind === 'announcement') body = `New announcement in <strong>${escapeHtml(it.courseCode)}</strong> — ${escapeHtml(it.title)}`;
    else if (it.kind === 'grade')   body = `Grade posted: <strong>${escapeHtml(it.title)}</strong>`;
    else body = escapeHtml(it.title);
    const expandable = it.kind === 'announcement' && (it.bodyHtml || it.bodyText);
    return `
      <li class="feed-item${expandable ? ' is-expandable' : ''}" data-feed-id="${it.id}" data-kind="${it.kind}" data-course-id="${it.courseId}">
        <button class="feed-row" type="button">
          <span class="feed-dot chip-c${ci}">${ICONS[it.icon] || ICONS.bell}</span>
          <div class="feed-body">${body}</div>
          <span class="feed-time">${escapeHtml(derive.relativeTime(it.when))}</span>
        </button>
        ${expandable ? `<div class="feed-expanded-wrap">${renderFeedExpanded(it)}</div>` : ''}
      </li>
    `;
  }).join('');

  // Wire expand toggles
  list.querySelectorAll('.feed-item.is-expandable .feed-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const li = btn.closest('.feed-item');
      li.classList.toggle('is-expanded');
      const id = li.dataset.feedId;
      if (li.classList.contains('is-expanded')) store.markRead(id);
    });
  });
}

function renderFeedExpanded(it) {
  // Inline announcement body. Cookies are attached for any <img> in the HTML
  // because we're on the extension's origin with host_permissions.
  const safeBody = sanitizeAnnouncementHtml(it.bodyHtml || `<p>${escapeHtml(it.bodyText || '')}</p>`);
  const attach = (it.attachments && it.attachments.length)
    ? `<div class="feed-attachments">${it.attachments.map(a => `
        <a class="feed-attach" href="${escapeHtml(a.Href || '#')}" target="_blank" rel="noopener">
          <span class="feed-attach-icon">${ICONS.paperclip}</span>
          <span>${escapeHtml(a.FileName || a.Name || 'attachment')}</span>
        </a>`).join('')}</div>`
    : '';
  const openHref = `${api.BASE}/d2l/lms/news/main.d2l?ou=${it.courseId}`;
  return `
    <div class="feed-expanded">
      <h3 class="feed-expanded-title">${escapeHtml(it.title)}</h3>
      <div class="feed-expanded-body">${safeBody}</div>
      ${attach}
      <div class="feed-expanded-foot">
        <a class="feed-expanded-link" href="${openHref}" target="_blank" rel="noopener">
          ${ICONS.externalLink} Open in BigSky
        </a>
      </div>
    </div>
  `;
}

/* ---- grade summary widget ---- */

/* Course code prefixes to exclude from the grade summary.
 * These are typically non-academic / admin courses where grade data
 * isn't meaningful for a student's academic overview. */
const GRADE_EXCLUDE_PREFIXES = ['BOS', 'AI', 'RD'];

let _gradesExpanded = false;

function renderGradeSummary(courses) {
  const section = $('#grade-summary');
  const body = $('#grade-summary-body');
  if (!section || !body) return;

  const summary = derive.buildGradeSummary(courses, state.bundles);
  // Filter out non-academic courses by code prefix.
  summary.courses = summary.courses.filter(c =>
    !GRADE_EXCLUDE_PREFIXES.some(p => c.code.startsWith(p))
  );
  // Recalculate overall from filtered courses only.
  if (summary.courses.length) {
    const scored = summary.courses.reduce((s, c) => s + c.scored, 0);
    const total = summary.courses.reduce((s, c) => s + c.total, 0);
    const items = summary.courses.reduce((s, c) => s + c.items, 0);
    summary.overall = total > 0 ? {
      scored: Math.round(scored * 100) / 100,
      total: Math.round(total * 100) / 100,
      pct: Math.round((scored / total) * 1000) / 10,
    } : null;
    summary.totalItems = items;
  }
  if (!summary.courses.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  if (!_gradesExpanded) {
    body.innerHTML = `
      <div class="grade-summary-placeholder">
        <button class="grade-summary-show-btn" id="grade-summary-show-btn">Show my grades</button>
        <div class="grade-summary-hint">Press <kbd>G</kbd> to toggle</div>
      </div>
    `;
    $('#grade-summary-show-btn').addEventListener('click', () => {
      _gradesExpanded = true;
      renderGradeSummary(courses);
    });
    return;
  }

  // Color a percentage: green ≥80, accent ≥60, urgent <60
  const pctCls = (p) => p >= 80 ? 'grade-pct--good' : p >= 60 ? 'grade-pct--ok' : 'grade-pct--low';

  // Overall card
  const overallHtml = summary.overall ? `
    <div class="grade-overall">
      <div class="grade-overall-ring ${pctCls(summary.overall.pct)}">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--border)" stroke-width="8"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-width="8"
                  stroke-dasharray="${(summary.overall.pct / 100) * 326.7} 326.7"
                  stroke-linecap="round" transform="rotate(-90 60 60)"/>
        </svg>
        <span class="grade-overall-pct">${summary.overall.pct}%</span>
      </div>
      <div class="grade-overall-info">
        <div class="grade-overall-label">Overall average</div>
        <div class="grade-overall-detail">${summary.overall.scored} / ${summary.overall.total} pts across ${summary.totalItems} items</div>
      </div>
    </div>
  ` : '';

  // Per-course bars
  const barsHtml = summary.courses.map(c => {
    const ci = derive.colorIndex(c.code);
    return `
      <div class="grade-course">
        <div class="grade-course-head">
          <span class="chip chip-c${ci}">${escapeHtml(c.code)}</span>
          <span class="grade-course-pct ${pctCls(c.pct)}">${c.pct}%</span>
        </div>
        <div class="grade-bar">
          <div class="grade-bar-fill ${pctCls(c.pct)}" style="width: ${Math.min(c.pct, 100)}%"></div>
        </div>
        <div class="grade-course-detail">${c.scored} / ${c.total} pts · ${c.items} item${c.items === 1 ? '' : 's'}</div>
      </div>
    `;
  }).join('');

  body.innerHTML = `
    ${overallHtml}
    <div class="grade-courses">${barsHtml}</div>
    <button class="grade-summary-hide-btn" id="grade-summary-hide-btn" aria-label="Hide grades" title="Hide grades">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  `;
  $('#grade-summary-hide-btn').addEventListener('click', () => {
    _gradesExpanded = false;
    renderGradeSummary(courses);
  });
}

/* ---- helpers ---- */

function daysUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / DAY_MS);
}

/* ---- theme + palette ----
 * data-theme on <html> = palette name (default | ocean | lavender | rose |
 *                                       mocha | benilde | slate | plain)
 * data-mode  on <html> = "light" | "dark"
 *
 * Both attributes are set first by theme-init.js (synchronously, before any
 * paint) and re-applied here as a safety net. initTheme() is now a no-op
 * for the page paint — its only job is to keep the cog icon in sync. */

function initTheme() {
  // theme-init.js has already applied attributes; this is a defensive backstop
  // in case the script failed to run (e.g. blocked by CSP in a future tweak).
  const root = document.documentElement;
  if (!root.dataset.mode) {
    const saved = localStorage.getItem('smallsky-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const valid = saved === 'light' || saved === 'dark';
    root.dataset.mode = valid ? saved : (prefersDark ? 'dark' : 'light');
  }
  if (!root.dataset.theme || VALID_PALETTES.indexOf(root.dataset.theme) < 0) {
    const savedPalette = localStorage.getItem('smallsky-theme');
    root.dataset.theme = VALID_PALETTES.indexOf(savedPalette) >= 0 ? savedPalette : 'default';
  }
}

/* Apply a palette change with a liquid-wave wipe animation.
 *
 * Two distinct page-level transitions in this app:
 *   - Light/dark toggle = identity shift → circle-reveal from the sun/moon button
 *   - Palette swap = hue change → liquid wave sweeping diagonally
 *
 * The wave is built from a polygon with many points along the leading edge.
 * Each keyframe shifts both the wave's POSITION (left → right across the
 * screen) AND its PHASE (so the wave shape itself morphs as it travels —
 * the difference between a static curve sliding sideways and a living
 * wave undulating across the page). Three intermediate phase shifts during
 * a 1200ms travel produce a gentle, organic "water washing over paper" feel.
 *
 * Easing is sine-symmetric (ease-in-out-sine) to match the sinusoidal shape
 * — the curve and its motion share a single mathematical identity. */
const PALETTE_WAVE = {
  slantWidth: 90,    // diagonal slant amount (% of viewport width)
  amplitude: 2.8,    // wave bulge amount (%)
  wavelength: 1.4,   // number of wave cycles along the edge
  segments: 18,      // polygon points along the leading edge (smoother = more)
};

/* The polygon's x-range needs to extend FAR enough on both ends so that at
 * progress=0 the entire leading edge is off-screen-left, and at progress=1
 * the entire trailing edge is off-screen-right — including allowance for the
 * wave's bulge (amplitude) and a small safety margin. Without this, the
 * bottom-right corner stays uncovered at progress=1 and snaps to the new
 * theme when the View Transition ends, producing the visible ~80% snap. */
const PALETTE_WAVE_MARGIN = PALETTE_WAVE.amplitude + 5;
const PALETTE_WAVE_START_X = -PALETTE_WAVE.slantWidth - PALETTE_WAVE_MARGIN;
const PALETTE_WAVE_END_X   = 100 + PALETTE_WAVE.slantWidth + PALETTE_WAVE_MARGIN;

function wavePolygon(progress, phase) {
  const x = PALETTE_WAVE_START_X + progress * (PALETTE_WAVE_END_X - PALETTE_WAVE_START_X);
  const points = ['0% 0%', `${x.toFixed(2)}% 0%`];
  for (let i = 1; i < PALETTE_WAVE.segments; i++) {
    const t = i / PALETTE_WAVE.segments;
    const baseX = x - PALETTE_WAVE.slantWidth * t;
    const wave = Math.sin((t * PALETTE_WAVE.wavelength + phase) * Math.PI * 2) * PALETTE_WAVE.amplitude;
    points.push(`${(baseX + wave).toFixed(2)}% ${(t * 100).toFixed(2)}%`);
  }
  points.push(`${(x - PALETTE_WAVE.slantWidth).toFixed(2)}% 100%`, '0% 100%');
  return `polygon(${points.join(', ')})`;
}

/* Inject the palette-wave keyframes once.
 *
 * Why CSS keyframes (vs programmatic element.animate)? The View Transitions
 * API only reliably waits for CSS animations on the pseudo-elements — JS
 * animations can be cut short when the browser decides the transition is
 * "done," producing a ~70%-through snap-to-end.
 *
 * Why bake the easing into keyframe POSITIONS? With CSS `animation-timing-
 * function`, the easing curve restarts between every consecutive keyframe.
 * With 4 keyframes that means triple-restart stutter (slow-fast-slow-fast-
 * slow-fast-slow). Instead, we generate ~36 keyframes whose progress values
 * follow a sine-based ease curve, then set `animation-timing-function:
 * linear` — the linear interpolation between closely-spaced eased samples
 * produces buttery-smooth motion with no acceleration glitches. */
const PALETTE_WAVE_SAMPLES = 36;
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
function lerp(a, b, t)    { return a + (b - a) * t; }

let _paletteKeyframesInstalled = false;
function installPaletteKeyframes() {
  if (_paletteKeyframesInstalled) return;
  _paletteKeyframesInstalled = true;

  const lines = [];
  for (let i = 0; i <= PALETTE_WAVE_SAMPLES; i++) {
    const timePct = (i / PALETTE_WAVE_SAMPLES * 100).toFixed(3);
    const eased = easeInOutSine(i / PALETTE_WAVE_SAMPLES);
    // Wave phase shifts gently with progress — gives the wave its undulation.
    const phase = eased * 1.8;
    const clip = wavePolygon(eased, phase);
    // Soft trailing shadow on the clipped edge. Kept modest (max 12px blur)
    // because drop-shadow on a fullscreen pseudo is expensive — 22px blur
    // produced visible frame drops on mid-range hardware.
    const sx = lerp(-8, -1, eased).toFixed(1);
    const sb = lerp(12, 3, eased).toFixed(1);
    const sa = lerp(0.16, 0.02, eased).toFixed(3);
    const filter = `drop-shadow(${sx}px 0 ${sb}px rgba(0, 0, 0, ${sa}))`;
    lines.push(`  ${timePct}% { clip-path: ${clip}; filter: ${filter}; }`);
  }

  const style = document.createElement('style');
  style.id = 'smallsky-palette-wave-keyframes';
  style.textContent = `
@keyframes smallsky-palette-wave {
${lines.join('\n')}
}
.palette-swapping::view-transition-new(root) {
  animation: smallsky-palette-wave 1200ms linear forwards;
}
  `;
  document.head.appendChild(style);
}

function setPalette(name) {
  if (VALID_PALETTES.indexOf(name) < 0) return;

  const apply = () => {
    document.documentElement.dataset.theme = name;
    localStorage.setItem('smallsky-theme', name);
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduceMotion) { apply(); return; }

  installPaletteKeyframes();
  const root = document.documentElement;
  root.classList.add('palette-swapping');
  const transition = document.startViewTransition(apply);
  transition.finished.finally(() => root.classList.remove('palette-swapping'));
}

async function toggleTheme(event) {
  const next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.mode = next;
    localStorage.setItem('smallsky-mode', next);
    refreshThemeIcon();
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduceMotion) { apply(); return; }

  const btn = $('[data-action="theme"]');
  const rect = btn.getBoundingClientRect();
  const x = (event && event.clientX) || (rect.left + rect.width / 2);
  const y = (event && event.clientY) || (rect.top + rect.height / 2);
  const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  const transition = document.startViewTransition(apply);
  await transition.ready;
  document.documentElement.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
    { duration: 650, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
  );
}

/* ---- settings popover ---- */

let settingsOpen = false;

async function toggleSettings(anchor) {
  if (settingsOpen) { closeSettings(); return; }
  closeProfileMenu();
  // Spin animation on the cog
  const cog = $('[data-action="settings"]');
  cog.classList.remove('cog-spinning');
  void cog.offsetWidth; // restart the animation
  cog.classList.add('cog-spinning');

  const auto = !!(state.prefs && state.prefs.autoReplaceHome);
  const lastSync = await store.cacheGet('lastSync');
  const lastSyncLabel = lastSync && lastSync.at
    ? `Synced ${derive.relativeTime(new Date(lastSync.at).toISOString())}`
    : 'Not synced yet';

  const pop = $('#settings-popover');
  pop.innerHTML = `
    <div class="settings-head">
      <h2 class="settings-title">Settings</h2>
      <button class="settings-close" aria-label="Close" data-settings-close>${ICONS.close}</button>
    </div>

    <section class="settings-section">
      <h3 class="settings-section-label">Privacy</h3>
      <label class="settings-toggle">
        <input type="checkbox" data-pref="cafeMode" ${!!(state.prefs && state.prefs.cafeMode) ? 'checked' : ''}>
        <span>
          <span class="settings-toggle-title">Cafe Mode</span>
          <span class="settings-toggle-sub">Blur grades and student ID. Press <kbd>C</kbd> to toggle instantly.</span>
        </span>
      </label>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">Behavior</h3>
      <label class="settings-toggle">
        <input type="checkbox" data-pref="autoReplaceHome" ${auto ? 'checked' : ''}>
        <span>
          <span class="settings-toggle-title">Auto-open SmallSky</span>
          <span class="settings-toggle-sub">Visiting BigSky home? Land here instead.</span>
        </span>
      </label>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">Data</h3>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">${escapeHtml(lastSyncLabel)}</div>
          <div class="settings-row-sub">Background sync runs every 5 minutes.</div>
        </div>
        <button class="settings-action" data-settings-action="refresh">Refresh now</button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">Clear cache</div>
          <div class="settings-row-sub">Force fresh fetch of everything on next load.</div>
        </div>
        <button class="settings-action settings-action--danger" data-settings-action="clear">Clear</button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">Old course data</div>
          <div class="settings-row-sub">Schedules and photos from courses no longer in your list.</div>
        </div>
        <button class="settings-action" data-settings-action="cleanup-orphans">Scan</button>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-title">Updates</div>
          <div class="settings-row-sub">SmallSky checks daily. Pull right now if you want.</div>
        </div>
        <button class="settings-action" data-settings-action="check-update">Check now</button>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">Theme</h3>
      <div class="theme-swatches" role="radiogroup" aria-label="Color theme">
        ${PALETTES.map(p => {
          const active = document.documentElement.dataset.theme === p.id;
          return `
            <button class="theme-swatch${active ? ' is-active' : ''}"
                    type="button" role="radio" aria-checked="${active}"
                    data-palette="${p.id}" title="${escapeHtml(p.name)}">
              <span class="theme-swatch-dot" style="--swatch-bg:${p.bg};--swatch-accent:${p.accent};"></span>
              <span class="theme-swatch-label">${escapeHtml(p.name)}</span>
            </button>
          `;
        }).join('')}
      </div>
    </section>

    <section class="settings-section">
      <h3 class="settings-section-label">About</h3>
      <div class="settings-about">
        <div class="settings-about-head">
          <img class="settings-about-icon" src="assets/icon-128.png" alt="">
          <div>
            <div class="settings-about-version">SmallSky v${escapeHtml(chrome.runtime.getManifest().version)}</div>
            ${(state.updateStatus && state.updateStatus.available && state.updateStatus.latest !== state.updateDismissed)
              ? `<button class="settings-about-update" data-update-action="show">v${escapeHtml(state.updateStatus.latest)} available →</button>`
              : ''}
          </div>
        </div>
        <div class="settings-about-tag">Made by Joaquin Bryan G. Ross</div>
        <div class="settings-about-subtag">Information Systems · ID 125</div>
        <div class="settings-about-links">
          <a class="settings-about-link settings-about-link--discord" href="https://discord.gg/DTvRR5qxxh" target="_blank" rel="noopener">
            ${ICONS.discord}
            <span>Join the support Discord</span>
          </a>
          <a class="settings-about-link settings-about-link--github" href="https://github.com/Nyrrine/smallsky" target="_blank" rel="noopener">
            ${ICONS.github}
            <span>See the code</span>
          </a>
        </div>
      </div>
      ${(() => {
        const v = chrome.runtime.getManifest().version;
        const entries = CHANGELOG[v];
        if (!entries || !entries.length) return '';
        return `
          <details class="settings-changelog">
            <summary>What's new in v${escapeHtml(v)}</summary>
            <div class="settings-changelog-body">
              <ul>${entries.map(li => `<li>${li}</li>`).join('')}</ul>
            </div>
          </details>
        `;
      })()}
    </section>
  `;
  pop.hidden = false;
  positionAnchored(pop, anchor, { width: 360, gap: 8, margin: 12 });
  requestAnimationFrame(() => pop.classList.add('visible'));
  settingsOpen = true;
}

function closeSettings() {
  const pop = $('#settings-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!settingsOpen) pop.hidden = true; }, 160);
  settingsOpen = false;
}

function wireGlobalSettingsHandlers() {
  bindDismissable({
    isOpen: () => settingsOpen,
    close: closeSettings,
    ignoreSelectors: ['#settings-popover', '[data-action="settings"]'],
  });
  $('#settings-popover').addEventListener('click', async (e) => {
    if (e.target.closest('[data-settings-close]')) { closeSettings(); return; }
    if (e.target.closest('[data-update-action="show"]')) {
      closeSettings();
      openUpdateModal();
      return;
    }
    const swatch = e.target.closest('[data-palette]');
    if (swatch) {
      setPalette(swatch.dataset.palette);
      // Update the active state without rerendering the whole popover —
      // CSS variables already swapped, this just shifts the ring.
      const group = swatch.parentElement;
      group.querySelectorAll('.theme-swatch').forEach(s => {
        const isActive = s === swatch;
        s.classList.toggle('is-active', isActive);
        s.setAttribute('aria-checked', String(isActive));
      });
      return;
    }
    const action = e.target.closest('[data-settings-action]')?.dataset.settingsAction;
    if (action === 'refresh') {
      const btn = e.target.closest('button');
      btn.textContent = 'Refreshing…';
      btn.disabled = true;
      try { await store.cacheClear(); await refreshAll({ swr: false }); showToast('Refreshed.'); }
      catch (err) { showToast(`Refresh failed: ${err.message}`); }
      finally { closeSettings(); render(); }
    } else if (action === 'clear') {
      await store.cacheClear();
      showToast('Cache cleared. Reloading…');
      setTimeout(() => location.reload(), 600);
    } else if (action === 'cleanup-orphans') {
      const orphans = derive.findOrphanedCourseData(state.courses, state.classSchedules, state.photos);
      const total = orphans.schedules.length + orphans.photos.length;
      if (total === 0) {
        showToast('Nothing to clean up — all your data is for active courses.');
        return;
      }
      const parts = [];
      if (orphans.schedules.length) parts.push(`${orphans.schedules.length} class schedule${orphans.schedules.length === 1 ? '' : 's'}`);
      if (orphans.photos.length)    parts.push(`${orphans.photos.length} custom photo${orphans.photos.length === 1 ? '' : 's'}`);
      const summary = parts.join(' and ');
      if (!confirm(`Remove ${summary} from courses no longer in your list? This can't be undone.`)) return;

      for (const ouId of orphans.schedules) {
        state.classSchedules = await store.setClassSchedule(ouId, null);
      }
      for (const ouId of orphans.photos) {
        state.photos = await store.setCoursePhoto(ouId, null);
      }
      showToast(`Cleaned up ${summary}.`);
      closeSettings();
      render();
    } else if (action === 'check-update') {
      const btn = e.target.closest('button');
      btn.textContent = 'Checking…';
      btn.disabled = true;
      const result = await checkForUpdate();
      btn.textContent = 'Check now';
      btn.disabled = false;
      state.updateStatus = await getUpdateStatus();
      renderUpdateBanner();
      if (!result) {
        showToast('Couldn\'t reach GitHub. Try again later.');
      } else if (result.available) {
        closeSettings();
        showToast(`v${result.latest} is out — opening details…`);
        setTimeout(openUpdateModal, 300);
      } else {
        showToast(`You're on the latest version (v${result.current}).`);
      }
    }
  });
  $('#settings-popover').addEventListener('change', async (e) => {
    const pref = e.target.dataset.pref;
    if (pref === 'autoReplaceHome') {
      state.prefs = await store.setPrefs({ autoReplaceHome: e.target.checked });
      showToast(e.target.checked ? 'BigSky home will redirect to SmallSky now.' : 'Auto-redirect off.');
    } else if (pref === 'cafeMode') {
      state.prefs = await store.setPrefs({ cafeMode: e.target.checked });
      applyCafeMode();
      showToast(e.target.checked ? 'Cafe mode ON' : 'Cafe mode OFF');
    }
  });
}

function applyCafeMode() {
  document.body.classList.toggle('cafe-mode', !!(state.prefs && state.prefs.cafeMode));
}

async function toggleCafeMode() {
  const current = !!(state.prefs && state.prefs.cafeMode);
  state.prefs = await store.setPrefs({ cafeMode: !current });
  applyCafeMode();
  showToast(!current ? 'Cafe mode ON' : 'Cafe mode OFF');
  
  // Also update settings checkbox if the popover is open
  const checkbox = document.querySelector('input[data-pref="cafeMode"]');
  if (checkbox) checkbox.checked = !current;
}

/* ---- bell popover (recent announcements) ---- */

let bellOpen = false;

function updateBellBadge() {
  const badge = $('#bell-badge');
  if (!badge) return;
  const items = recentAnnouncements();
  const unread = items.filter(i => !i._read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function recentAnnouncements() {
  const cutoff = Date.now() - 14 * DAY_MS;
  const out = [];
  for (const c of state.courses) {
    const b = state.bundles[c.OrgUnitId] || {};
    const news = (b.news && !b.news.__error) ? b.news : [];
    for (const n of news) {
      const t = new Date(n.LastModifiedDate || n.CreatedDate).getTime();
      if (t < cutoff) continue;
      out.push({
        id: `news:${c.OrgUnitId}:${n.Id}`,
        courseCode: derive.shortCode(c),
        courseId: c.OrgUnitId,
        title: n.Title,
        when: n.LastModifiedDate || n.CreatedDate,
        _read: !!(state._read && state._read[`news:${c.OrgUnitId}:${n.Id}`]),
      });
    }
  }
  out.sort((a, b) => new Date(b.when) - new Date(a.when));
  return out;
}

function toggleBell(anchor) {
  if (bellOpen) { closeBell(); return; }
  closeProfileMenu();
  closeSettings();
  // Ring animation on the bell (mirrors the cog spin on settings).
  const bell = $('[data-action="bell"]');
  bell.classList.remove('bell-ringing');
  void bell.offsetWidth; // force reflow so animation restarts on rapid re-clicks
  bell.classList.add('bell-ringing');
  const items = recentAnnouncements();
  const pop = $('#bell-popover');
  pop.innerHTML = `
    <div class="bell-head">
      <span class="bell-head-title">Notifications</span>
      ${items.length ? '<button class="bell-mark-all" data-bell-mark-all>Mark all read</button>' : ''}
    </div>
    <div class="bell-body">
      ${items.length === 0
        ? '<div class="bell-empty">No new notifications.</div>'
        : items.slice(0, 12).map(it => {
            const ci = derive.colorIndex(it.courseCode);
            return `
              <a class="bell-item${it._read ? ' is-read' : ''}" href="${api.BASE}/d2l/lms/news/main.d2l?ou=${it.courseId}" target="_blank" rel="noopener">
                <span class="bell-item-icon chip-c${ci}">${ICONS.megaphone}</span>
                <div class="bell-item-body">
                  <div class="bell-item-title">${escapeHtml(it.title)}</div>
                  <div class="bell-item-meta">
                    <span class="chip chip-c${ci}">${escapeHtml(it.courseCode)}</span>
                    <span class="bell-item-when">${escapeHtml(derive.relativeTime(it.when))}</span>
                  </div>
                </div>
              </a>
            `;
          }).join('')}
    </div>
  `;
  pop.hidden = false;
  positionAnchored(pop, anchor, { width: 360, gap: 6, margin: 12 });
  requestAnimationFrame(() => pop.classList.add('visible'));
  bellOpen = true;
}

function closeBell() {
  const pop = $('#bell-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!bellOpen) pop.hidden = true; }, 160);
  bellOpen = false;
}

async function markAllAnnouncementsRead() {
  const items = recentAnnouncements();
  state._read = state._read || {};
  for (const it of items) {
    state._read[it.id] = Date.now();
    await store.markRead(it.id);
  }
  updateBellBadge();
  closeBell();
}

function wireGlobalBellHandlers() {
  bindDismissable({
    isOpen: () => bellOpen,
    close: closeBell,
    ignoreSelectors: ['#bell-popover', '[data-action="bell"]'],
  });
  $('#bell-popover').addEventListener('click', (e) => {
    if (e.target.closest('[data-bell-mark-all]')) {
      e.preventDefault();
      markAllAnnouncementsRead();
    }
  });
}

/* ---- profile dropdown menu ---- */

let profileMenuOpen = false;

function toggleProfileMenu(anchor) {
  if (profileMenuOpen) { closeProfileMenu(); return; }
  closeBell();
  const me = state.me || {};
  const fullName = [me.FirstName, me.LastName].filter(Boolean).join(' ') || 'You';
  const id = me.UniqueName || '';
  const initials = ((me.FirstName||'')[0] || '') + ((me.LastName||'')[0] || '');

  const menu = $('#profile-menu');
  const hasAvatar = !!state.avatar;
  const avatarInner = hasAvatar
    ? `<img class="profile-menu-avatar-img" src="${escapeHtml(state.avatar)}" alt="">`
    : escapeHtml(initials.toUpperCase() || '·');
  menu.innerHTML = `
    <div class="profile-menu-head">
      <div class="profile-menu-avatar">${avatarInner}</div>
      <div class="profile-menu-id-block">
        <div class="profile-menu-name">${escapeHtml(fullName)}</div>
        ${id ? `<div class="profile-menu-id">${escapeHtml(id)}</div>` : ''}
      </div>
    </div>
    <div class="profile-menu-divider"></div>
    <button type="button" class="profile-menu-link" data-profile-action="upload-avatar">
      ${hasAvatar ? 'Change photo' : 'Upload photo'}
    </button>
    ${hasAvatar ? `
      <button type="button" class="profile-menu-link" data-profile-action="remove-avatar">
        Remove photo
      </button>
    ` : ''}
    <div class="profile-menu-divider"></div>
    <a class="profile-menu-link" href="${api.BASE}/d2l/lp/profile/profile_edit.d2l?ou=${CSB_ROOT_OU}" target="_blank" rel="noopener">BigSky profile</a>
    <div class="profile-menu-divider"></div>
    <a class="profile-menu-link profile-menu-link--danger" href="${api.BASE}/d2l/logout">Log out of BigSky</a>
  `;

  // Wire the avatar actions.
  menu.querySelector('[data-profile-action="upload-avatar"]')
    .addEventListener('click', () => { closeProfileMenu(); triggerAvatarUpload(); });
  const removeBtn = menu.querySelector('[data-profile-action="remove-avatar"]');
  if (removeBtn) removeBtn.addEventListener('click', () => { closeProfileMenu(); removeAvatar(); });
  menu.hidden = false;
  positionAnchored(menu, anchor, { width: 280, gap: 6, margin: 12 });
  requestAnimationFrame(() => menu.classList.add('visible'));
  profileMenuOpen = true;
}

function closeProfileMenu() {
  const menu = $('#profile-menu');
  menu.classList.remove('visible');
  setTimeout(() => { if (!profileMenuOpen) menu.hidden = true; }, 160);
  profileMenuOpen = false;
}

/* ---- session heartbeat on wake ----
 * After hibernate / sleep / long idle, the BigSky session cookie may have
 * expired server-side while the SmallSky tab stayed open with stale cached
 * data.  This listener fires a lightweight auth probe (`whoami`) whenever the
 * tab regains visibility.  If the probe fails with AUTH, the logged-out screen
 * is shown immediately — no more stale dashboard that looks alive but can't
 * actually fetch anything. */

let _lastWakeCheck = 0;
const WAKE_CHECK_COOLDOWN = 60_000; // don't re-check more than once per minute

async function checkSessionOnWake() {
  const now = Date.now();
  if (now - _lastWakeCheck < WAKE_CHECK_COOLDOWN) return;
  _lastWakeCheck = now;

  try {
    // Bypass the cache — hit BigSky directly to see if the session is alive.
    const me = await api.whoami();
    // Session is still good — update state and kick a soft refresh.
    state.me = me;
    await store.cacheSet('whoami', me, store.TTL.whoami);
    refreshAll({ swr: true }).catch(() => {});
  } catch (e) {
    if (e.code === 'AUTH') {
      // Session died during hibernate — show the login screen.
      showLoggedOutScreen();
    }
    // Other errors (network hiccup, etc.) — don't lock out, just ignore.
  }
}

/* ---- logged-out auth screen ---- */

let _loggedOutShown = false;

function showLoggedOutScreen() {
  if (_loggedOutShown) return;   // idempotent — safe to call from multiple paths
  _loggedOutShown = true;

  $('.page').style.display = 'none';
  $('#logged-out').hidden = false;

  /* Manual escape hatch — if SmallSky misjudged, click through to the dashboard
   * with whatever cached data we have. No auto-redirect — the user goes to
   * BigSky login only when they explicitly click the button. */
  $('#logged-out-override').addEventListener('click', async () => {
    _loggedOutShown = false;   // allow re-triggering if session lapses again
    $('#logged-out').hidden = true;
    $('.page').style.display = '';
    showToast('OK — showing cached data. Click refresh to retry the live fetch.');
    render();
  }, { once: true });
}

/* ---- assignment notes popover ---- */

const notesState = { openTaskId: null, anchor: null, debounceTimer: null };

function openNotesPopover(card) {
  hidePeek();
  closeCourseMenu();
  const taskId = card.dataset.taskId;
  const title = card.dataset.taskTitle;
  if (notesState.openTaskId === taskId) { closeNotesPopover(); return; }

  const pop = $('#notes-popover');
  const current = state.notes[taskId] || '';
  pop.innerHTML = `
    <div class="notes-head">
      <span class="notes-head-title">${escapeHtml(title)}</span>
      <button class="notes-close" aria-label="Close" data-notes-close>${ICONS.close}</button>
    </div>
    <textarea class="notes-textarea" placeholder="A quick note for yourself…">${escapeHtml(current)}</textarea>
    <div class="notes-foot muted">${current ? 'Saved automatically · just for you' : 'Saved automatically · just for you · local to this device'}</div>
  `;
  pop.dataset.taskId = taskId;
  pop.hidden = false;
  positionAnchored(pop, card, { minWidth: 280, gap: 6, align: 'left', margin: 12 });
  requestAnimationFrame(() => {
    pop.classList.add('visible');
    pop.querySelector('textarea').focus();
  });
  notesState.openTaskId = taskId;
  notesState.anchor = card;

  // Wire input → debounced save
  const ta = pop.querySelector('textarea');
  ta.addEventListener('input', () => {
    clearTimeout(notesState.debounceTimer);
    notesState.debounceTimer = setTimeout(async () => {
      state.notes = await store.setNote(taskId, ta.value);
      // Update the card's has-note class so the dot indicator flips on/off
      const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(taskId)}"]`);
      if (card) card.classList.toggle('has-note', !!ta.value.trim());
    }, 300);
  });
}

function closeNotesPopover() {
  const pop = $('#notes-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!notesState.openTaskId) pop.hidden = true; }, 160);
  notesState.openTaskId = null;
  notesState.anchor = null;
}

function wireGlobalNotesHandlers() {
  bindDismissable({
    isOpen: () => !!notesState.openTaskId,
    close: closeNotesPopover,
    ignoreSelectors: ['#notes-popover', '[data-notes-toggle]'],
  });
  $('#notes-popover').addEventListener('click', (e) => {
    if (e.target.closest('[data-notes-close]')) { e.preventDefault(); closeNotesPopover(); }
  });
}

/* ---- course overflow menu (pin / hide / change photo) ---- */

const menuState = { openOuId: null };

function openCourseMenu(ouId, anchor) {
  hidePeek();
  if (menuState.openOuId === ouId) { closeCourseMenu(); return; }
  const isPinned = state.prefs.pinned.includes(ouId);
  const isHidden = state.prefs.hidden.includes(ouId);
  const hasCustom = !!state.photos[ouId];
  const menu = $('#course-menu');
  const hasSchedule = !!state.classSchedules[ouId];
  menu.innerHTML = `
    <button data-menu-action="pin">${ICONS.pin}<span>${isPinned ? 'Unpin' : 'Pin to top'}</span></button>
    <button data-menu-action="hide">${ICONS.hide}<span>${isHidden ? 'Show again' : 'Hide course'}</span></button>
    <div class="course-menu-divider"></div>
    <button data-menu-action="schedule">${ICONS.calendar}<span>${hasSchedule ? 'Edit class schedule' : 'Add class schedule'}</span></button>
    <button data-menu-action="photo">${ICONS.file}<span>${hasCustom ? 'Change photo…' : 'Set custom photo…'}</span></button>
    ${hasCustom ? `<button data-menu-action="resetPhoto">${ICONS.close}<span>Reset photo</span></button>` : ''}
  `;
  menu.dataset.ouId = ouId;
  menu.hidden = false;
  positionAnchored(menu, anchor, { width: 200, gap: 6, margin: 8 });
  requestAnimationFrame(() => menu.classList.add('visible'));
  menuState.openOuId = ouId;
}

function closeCourseMenu() {
  const menu = $('#course-menu');
  menu.classList.remove('visible');
  setTimeout(() => { if (!menuState.openOuId) menu.hidden = true; }, 160);
  menuState.openOuId = null;
}

function wireGlobalMenuHandlers() {
  bindDismissable({
    isOpen: () => !!menuState.openOuId,
    close: closeCourseMenu,
    ignoreSelectors: ['#course-menu', '[data-overflow]'],
  });
  $('#course-menu').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-menu-action]')?.dataset.menuAction;
    if (!action) return;
    const ouId = $('#course-menu').dataset.ouId;
    closeCourseMenu();
    if (action === 'pin')          { state.prefs = await store.togglePin(ouId); render(); }
    else if (action === 'hide')    { state.prefs = await store.toggleHidden(ouId); render(); }
    else if (action === 'schedule') {
      // Re-find tile after menu close so the editor anchors to the live element.
      const tile = document.querySelector(`.course-tile[data-course-id="${CSS.escape(ouId)}"]`);
      const code = tile && tile.dataset.courseCode;
      openScheduleEditor(ouId, tile, code);
    }
    else if (action === 'photo')   { triggerPhotoUpload(ouId); }
    else if (action === 'resetPhoto') {
      state.photos = await store.setCoursePhoto(ouId, null);
      render();
      showToast('Photo reset to the BigSky default.');
    }
  });
}

/* ---- course quick-peek popover (click-triggered) ---- */

const peekState = { openId: null };
const PEEK_OPTS = { width: 320, gap: 8, align: 'left', margin: 12, flip: true };

/* Look up the live tile element by courseId. Required because background
 * bundle refreshes call render() which rebuilds the grid via innerHTML —
 * the original tile reference passed into showPeek becomes detached, and a
 * detached element's getBoundingClientRect() returns all zeroes (which made
 * the peek fly to top-left). Re-finding the tile each time anchors correctly. */
function findCourseTile(courseId) {
  return document.querySelector(`.course-tile[data-course-id="${CSS.escape(String(courseId))}"]`);
}
function repositionPeek() {
  if (!peekState.openId) return;
  const tile = findCourseTile(peekState.openId);
  if (tile) positionAnchored($('#course-peek'), tile, PEEK_OPTS);
}

function wireCoursePeek() {
  document.querySelectorAll('.course-tile').forEach(tile => {
    tile.addEventListener('click', (e) => {
      // Ctrl/Cmd/Shift click and middle-click → let the link open BigSky directly.
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      // Overflow button has its own handler — don't conflict.
      if (e.target.closest('[data-overflow]')) return;
      e.preventDefault();
      // Blur after handling so the :focus-visible accent ring doesn't linger
      // (Chrome can leave focus-visible on after click+preventDefault on <a>).
      tile.blur();
      const courseId = tile.dataset.courseId;
      if (peekState.openId === courseId) hidePeek();
      else showPeek(tile);
    });
  });
}

/* Wire global close handlers ONCE on boot, not per-render. */
function wireGlobalPeekHandlers() {
  bindDismissable({
    isOpen: () => !!peekState.openId,
    close: hidePeek,
    ignoreSelectors: ['#course-peek', '.course-tile'], // tile clicks handled by tile itself
  });
  // Close button + announcement clicks (delegated since the peek innerHTML re-renders).
  $('#course-peek').addEventListener('click', (e) => {
    if (e.target.closest('[data-peek-close]')) {
      e.preventDefault();
      hidePeek();
      return;
    }
    const newsBtn = e.target.closest('[data-peek-news]');
    if (newsBtn) {
      e.preventDefault();
      const courseId = newsBtn.dataset.newsCourse;
      const newsId = newsBtn.dataset.newsId;
      hidePeek();
      // Wait for peek's close animation to start before opening the modal —
      // simultaneous animations feel jumbled.
      setTimeout(() => openAnnouncementModal(courseId, newsId), 140);
    }
  });
  // Only reposition on resize. Don't reposition on scroll — the peek is
  // position:absolute so it scrolls with the page naturally; recomputing on
  // every scroll event was clamping it to the top of the viewport when the
  // anchor tile scrolled out of view.
  window.addEventListener('resize', repositionPeek);
}

async function showPeek(tile) {
  closeCourseMenu();
  const courseId = tile.dataset.courseId;
  const code = tile.dataset.courseCode;
  if (!courseId) return;
  const peek = $('#course-peek');

  // The peeking class on the tile is applied via the courseTile() template
  // off peekState.openId, so it survives render() rebuilds. Just set state.
  peekState.openId = courseId;
  // Re-render any visible tiles so the current one picks up the class.
  document.querySelectorAll('.course-tile--peeking').forEach(t => t.classList.remove('course-tile--peeking'));
  tile.classList.add('course-tile--peeking');

  peek.hidden = false;
  peek.innerHTML = peekShell(code, courseId, 'loading');
  positionAnchored(peek, tile, PEEK_OPTS);
  peek.classList.add('visible');

  // Fire-and-forget: silently refresh this course's bundle in the background.
  // Keeps "due / new" counts on the tile + What's New current.
  loadCourseBundle(courseId, { swr: true })
    .then(b => { state.bundles[courseId] = b; render(); })
    .catch(() => {});

  // Fetch TOC + recent announcements (with cache). Re-position via the helper
  // so we look up the *current* tile element (the original may have been
  // detached by a render() between now and the await resolving).
  try {
    const toc = await getTOCCached(courseId);
    if (peekState.openId !== courseId) return; // user moved on
    const news = state.bundles[courseId]?.news || [];
    peek.innerHTML = peekShell(code, courseId, 'ready', { toc, news });
    repositionPeek();
  } catch (e) {
    if (peekState.openId !== courseId) return;
    peek.innerHTML = peekShell(code, courseId, 'error');
    repositionPeek();
  }
}

function hidePeek() {
  const peek = $('#course-peek');
  peek.classList.remove('visible');
  setTimeout(() => { if (!peek.classList.contains('visible')) { peek.hidden = true; } }, 180);
  document.querySelectorAll('.course-tile--peeking').forEach(t => t.classList.remove('course-tile--peeking'));
  peekState.openId = null;
}

function peekShell(code, courseId, status, data) {
  let body = '';
  if (status === 'loading') {
    body = `<div class="peek-loading">Loading…</div>`;
  } else if (status === 'error') {
    body = `<div class="peek-error">Couldn’t load course details.</div>`;
  } else {
    body = `${peekTOC(data.toc, courseId)}${peekNews(data.news, courseId)}`;
  }
  return `
    <div class="peek-head">
      <span class="peek-code">${escapeHtml(code)}</span>
      <button class="peek-close" aria-label="Close" data-peek-close>${ICONS.close}</button>
    </div>
    <div class="peek-body">${body}</div>
    <div class="peek-foot">
      <a class="peek-link" href="${api.BASE}/d2l/le/content/${courseId}/Home" target="_blank" rel="noopener">
        Open content ${ICONS.externalLink}
      </a>
    </div>
  `;
}

function peekTOC(toc, courseId) {
  const modules = (toc && toc.Modules) || [];
  if (!modules.length) {
    return `<div class="peek-section"><div class="peek-section-label">Modules</div><div class="peek-empty">No modules yet.</div></div>`;
  }
  const rows = modules.slice(0, 14).map(m => {
    const itemCount = (m.Modules?.length || 0) + (m.Topics?.length || 0);
    const href = `${api.BASE}/d2l/le/content/${courseId}/Home?moduleId=${m.ModuleId || m.Id}`;
    return `
      <a class="peek-module" href="${href}" target="_blank" rel="noopener">
        <span class="peek-module-icon">${ICONS.module}</span>
        <span class="peek-module-title">${escapeHtml(m.Title)}</span>
        ${itemCount ? `<span class="peek-module-count">${itemCount}</span>` : ''}
      </a>
    `;
  }).join('');
  return `
    <div class="peek-section">
      <div class="peek-section-label">Weeks / Modules</div>
      <div class="peek-modules">${rows}</div>
    </div>
  `;
}

function peekNews(news, courseId) {
  const items = (news || []).slice(0, 3);
  if (!items.length) return '';
  return `
    <div class="peek-section">
      <div class="peek-section-label">Recent announcements</div>
      <div class="peek-news">
        ${items.map(n => `
          <button type="button" class="peek-news-item"
                  data-peek-news
                  data-news-id="${escapeHtml(String(n.Id))}"
                  data-news-course="${escapeHtml(String(courseId))}">
            <span class="peek-news-title">${escapeHtml(n.Title)}</span>
            <span class="peek-news-time">${escapeHtml(derive.relativeTime(n.LastModifiedDate || n.CreatedDate))}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

async function getTOCCached(courseId) {
  const key = `toc:${courseId}`;
  const cached = await store.cacheGet(key);
  if (cached) return cached;
  const toc = await api.courseTOC(courseId);
  await store.cacheSet(key, toc, 30 * 60 * 1000); // 30 min
  return toc;
}




/* ---- events ---- */

function wireGlobalEvents() {
  wireGlobalPeekHandlers();
  wireGlobalMenuHandlers();
  wireGlobalNotesHandlers();
  wireGlobalBellHandlers();
  wireGlobalProfileHandlers();
  wireGlobalSettingsHandlers();
  initDrawer({ state, store });
  initSchedule({ state, onOpenAnnouncement: openAnnouncementModal });
  initAnnouncementModal({ state });
  initUpdateModal({ state });
  initPhoto({ state, render });
  initAvatar({ state, render });
  initClassSchedule({ state, render });
  initSearch({ state });
  $('[data-action="theme"]').addEventListener('click', toggleTheme);
  $('[data-action="bell"]').addEventListener('click', (e) => { e.preventDefault(); toggleBell(e.currentTarget); });
  $('[data-action="settings"]').addEventListener('click', (e) => { e.preventDefault(); toggleSettings(e.currentTarget); });
  $('[data-action="profile"]').addEventListener('click', (e) => { e.preventDefault(); toggleProfileMenu(e.currentTarget); });

  // Re-check auth when the tab regains visibility after sleep / hibernate.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkSessionOnWake();
    }
  });

  // Global keyboard shortcuts
  wireKeyboardShortcuts();

  // Brand logo shake — cute touch on click
  const brand = document.querySelector('.brand-logo');
  if (brand) {
    brand.addEventListener('click', () => {
      brand.classList.remove('shaking');
      void brand.offsetWidth;
      brand.classList.add('shaking');
    });
  }
}

/* ---- keyboard shortcuts ---- */

const SHORTCUTS = [
  { key: '/', label: 'Focus search' },
  { key: 'R', label: 'Refresh data' },
  { key: 'T', label: 'Toggle light / dark' },
  { key: 'B', label: 'Open notifications' },
  { key: 'G', label: 'Toggle grade summary' },
  { key: 'C', label: 'Toggle Cafe Mode' },
  { key: '1–9', label: 'Open course by position' },
  { key: 'Esc', label: 'Close any open panel' },
  { key: '?', label: 'Show this help' },
];

let _shortcutsOverlayOpen = false;

function wireKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in an input, textarea, or contenteditable.
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
      // Exception: Esc always works (to blur the field).
      if (e.key === 'Escape') {
        e.target.blur();
        return;
      }
      return;
    }
    // Ignore when modifier keys (Ctrl/Cmd/Alt) are held — those are browser shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case '/':
        e.preventDefault();
        $('#search-input').focus();
        break;

      case 'r':
      case 'R':
        e.preventDefault();
        showToast('Refreshing…');
        store.cacheClear().then(() => refreshAll({ swr: false })).then(() => {
          showToast('Refreshed.');
          render();
        }).catch(err => showToast(`Refresh failed: ${err.message}`));
        break;

      case 't':
      case 'T':
        e.preventDefault();
        toggleTheme(e);
        break;

      case 'b':
      case 'B':
        e.preventDefault();
        toggleBell($('[data-action="bell"]'));
        break;

      case 'g':
      case 'G': {
        e.preventDefault();
        _gradesExpanded = !_gradesExpanded;
        // Rerender dashboard to pick up grades view change. 
        // This recalculates upNext/feed but is completely synchronous and fast.
        render(); 
        break;
      }

      case 'c':
      case 'C':
        e.preventDefault();
        toggleCafeMode();
        break;

      case 'Escape':
        e.preventDefault();
        if (_shortcutsOverlayOpen) { closeShortcutsOverlay(); break; }
        closeBell();
        closeSettings();
        closeProfileMenu();
        hidePeek();
        closeCourseMenu();
        closeNotesPopover();
        break;

      case '?':
        e.preventDefault();
        toggleShortcutsOverlay();
        break;

      default: {
        // Number keys 1-9 → open the Nth visible course in BigSky
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          e.preventDefault();
          const arranged = derive.arrangeCourses(state.courses.map(stringIds), state.prefs);
          const all = [...arranged.pins, ...arranged.main];
          const course = all[num - 1];
          if (course) {
            window.open(`${api.BASE}/d2l/home/${course.OrgUnitId}`, '_blank', 'noopener');
          } else {
            showToast(`No course at position ${num}.`);
          }
        }
      }
    }
  });
}

function toggleShortcutsOverlay() {
  if (_shortcutsOverlayOpen) { closeShortcutsOverlay(); return; }
  const overlay = $('#shortcuts-overlay');
  overlay.innerHTML = `
    <div class="shortcuts-card">
      <div class="shortcuts-head">
        <h2 class="shortcuts-title">Keyboard shortcuts</h2>
        <button class="shortcuts-close" aria-label="Close" data-shortcuts-close>${ICONS.close}</button>
      </div>
      <div class="shortcuts-grid">
        ${SHORTCUTS.map(s => `
          <div class="shortcuts-row">
            <kbd class="shortcuts-key">${escapeHtml(s.key)}</kbd>
            <span class="shortcuts-label">${escapeHtml(s.label)}</span>
          </div>
        `).join('')}
      </div>
      <div class="shortcuts-foot muted">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>
    </div>
  `;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('visible'));
  _shortcutsOverlayOpen = true;

  overlay.querySelector('[data-shortcuts-close]').addEventListener('click', closeShortcutsOverlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeShortcutsOverlay();
  });
}

function closeShortcutsOverlay() {
  const overlay = $('#shortcuts-overlay');
  overlay.classList.remove('visible');
  setTimeout(() => { if (!_shortcutsOverlayOpen) overlay.hidden = true; }, 180);
  _shortcutsOverlayOpen = false;
}

function wireGlobalProfileHandlers() {
  bindDismissable({
    isOpen: () => profileMenuOpen,
    close: closeProfileMenu,
    ignoreSelectors: ['#profile-menu', '[data-action="profile"]'],
  });
}
