/* Compose dashboard-ready view models from raw D2L responses. */

import { BASE } from './api.js';
import { DAY_MS } from './util.js';

/* Stable hash → course pastel index (1..8). Course code = same color forever. */
export function colorIndex(code) {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) >>> 0;
  return (h % 8) + 1;
}

/* Pull a short, human-friendly code out of a course Name like
 * "PATHF3M FTLGE1 (20253)" → "PATHF3M". Falls back to Code or first word. */
export function shortCode(course) {
  const m = (course.Name || '').match(/^([A-Z][A-Z0-9_]{2,})\b/);
  if (m) return m[1].slice(0, 12);
  if (course.Code) {
    const firstWord = course.Code.split(/[\s_-]/)[0];
    if (firstWord && firstWord.length >= 2 && firstWord.length <= 12) return firstWord;
  }
  return ((course.Name || '?').split(/\s+/)[0] || '?').slice(0, 12);
}

/* Friendly display name. Strips only the trailing "(20253)" term tag.
 * "PATHF3M FTLGE1 (20253)" → "PATHF3M FTLGE1"
 * "AI for Students: Best Practices..." → unchanged */
export function displayName(course) {
  return (course.Name || course.Code || 'Untitled')
    .replace(/\s*\([0-9]+\)\s*$/, '')
    .trim();
}

/* ISO date → friendly relative string. "2h ago", "yesterday", "Mon, May 19". */
export function relativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - t;
  if (Math.abs(diff) < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 2 * DAY_MS) return 'yesterday';
  if (diff < 7 * DAY_MS) {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* Friendly due-date string with " · in N days" suffix. */
export function dueLabel(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.round((t - now) / DAY_MS);
  const dateStr = new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (days < 0) return `${dateStr} · ${Math.abs(days)}d overdue`;
  if (days === 0) return `${dateStr} · today`;
  if (days === 1) return `${dateStr} · tomorrow`;
  if (days <= 7) return `${dateStr} · in ${days} days`;
  return dateStr;
}

/* Take raw courses + per-course bundles → list of "Up Next" task items.
 * Submission status comes from bundles[ou].submittedFolderIds (Array of string IDs)
 * which is scraped from the dropbox folders_list.d2l HTML. */
export function buildUpNext(courses, bundles, { withinDays = 21, includeSubmitted = true, pastDays = 3 } = {}) {
  const items = [];
  const now = Date.now();
  const earliest = now - pastDays * DAY_MS;
  const latest = now + withinDays * DAY_MS;

  for (const c of courses) {
    const b = bundles[c.OrgUnitId] || {};
    const code = shortCode(c);
    const submitted = new Set((b.submittedFolderIds || []).map(String));

    /* Dropbox folders. */
    const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
    for (const f of folders) {
      if (!f.DueDate) continue;
      // Skip folders whose submission window has already closed —
      // they're no longer actionable, so they shouldn't squat in Up Next.
      const endDate = f.Availability && f.Availability.EndDate;
      if (endDate && new Date(endDate).getTime() < now) continue;
      const t = new Date(f.DueDate).getTime();
      if (t < earliest || t > latest) continue;
      const isSubmitted = submitted.has(String(f.Id));
      items.push({
        id: `dropbox:${c.OrgUnitId}:${f.Id}`,
        kind: 'dropbox',
        icon: 'file',
        courseCode: code,
        courseId: c.OrgUnitId,
        title: f.Name,
        type: 'Assignment',
        due: f.DueDate,
        href: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${f.Id}&ou=${c.OrgUnitId}`,
        status: isSubmitted ? 'done' : 'todo',
      });
    }

    /* Quizzes — derive status from cached quiz attempts. */
    const quizzes = (b.quizzes && !b.quizzes.__error && b.quizzes.Objects) || [];
    const attemptsMap = (b.quizAttempts && !b.quizAttempts.__error) ? b.quizAttempts : {};
    for (const q of quizzes) {
      const due = q.DueDate || q.EndDate;
      if (!due) continue;
      if (q.EndDate && new Date(q.EndDate).getTime() < now) continue;
      const t = new Date(due).getTime();
      if (t < earliest || t > latest) continue;
      const attempt = attemptsMap[q.QuizId];
      let status = 'todo';
      if (attempt) {
        if (attempt.hasCompleted) status = 'done';
        else if (attempt.hasInProgress) status = 'draft';
      }
      items.push({
        id: `quiz:${c.OrgUnitId}:${q.QuizId}`,
        kind: 'quiz',
        icon: 'quiz',
        courseCode: code,
        courseId: c.OrgUnitId,
        title: q.Name,
        type: 'Quiz',
        due,
        href: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${q.QuizId}&ou=${c.OrgUnitId}`,
        status,
      });
    }
  }

  items.sort((a, b) => new Date(a.due) - new Date(b.due));
  if (!includeSubmitted) return items.filter(x => x.status !== 'done');
  return items;
}

/* "What's new" — flatten announcements + grade postings + assignments, sort by recency. */
export function buildFeed(courses, bundles, { limit = 12 } = {}) {
  const items = [];

  for (const c of courses) {
    const b = bundles[c.OrgUnitId] || {};
    const code = shortCode(c);

    const news = (b.news && !b.news.__error) ? b.news : [];
    for (const n of news) {
      const date = n.LastModifiedDate || n.CreatedDate;
      items.push({
        id: `news:${c.OrgUnitId}:${n.Id}`,
        kind: 'announcement',
        icon: 'megaphone',
        courseCode: code,
        courseId: c.OrgUnitId,
        title: n.Title,
        bodyHtml: n.Body && n.Body.Html,
        bodyText: n.Body && n.Body.Text,
        attachments: n.Attachments || [],
        when: date,
      });
    }

    const grades = (b.grades && !b.grades.__error) ? b.grades : [];
    for (const g of grades) {
      if (g.PointsNumerator == null || !g.GradeObjectName) continue;
      items.push({
        id: `grade:${c.OrgUnitId}:${g.GradeObjectIdentifier}`,
        kind: 'grade',
        icon: 'star',
        courseCode: code,
        courseId: c.OrgUnitId,
        title: `${g.PointsNumerator} / ${g.PointsDenominator} on ${g.GradeObjectName}`,
        when: g.LastModified || g.GradedDate || new Date().toISOString(),
      });
    }
  }

  items.sort((a, b) => new Date(b.when) - new Date(a.when));
  return items.slice(0, limit);
}

/* Filter, sort, and order courses according to user prefs (pin/hide). */
export function arrangeCourses(courses, prefs) {
  const pinned = new Set(prefs.pinned || []);
  const hidden = new Set(prefs.hidden || []);
  const visible = courses.filter(c => !hidden.has(String(c.OrgUnitId)));
  const main = visible.filter(c => !pinned.has(String(c.OrgUnitId)));
  const pins = visible.filter(c =>  pinned.has(String(c.OrgUnitId)));
  const hiddenList = courses.filter(c => hidden.has(String(c.OrgUnitId)));
  return { pins, main, hidden: hiddenList };
}

/* Greeting time-of-day. */
export function greeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'evening';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/* YYYY-MM-DD key for a Date object, in local timezone. */
export function dayKey(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Pretty day-of-month label ("Mon, May 13" or "Today" / "Tomorrow"). */
export function prettyDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  const todayKey = dayKey(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowKey = dayKey(tomorrow);
  if (dateStr === todayKey) return 'Today';
  if (dateStr === tomorrowKey) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/* Build a schedule: collect all dated events across courses, grouped by day.
 *
 * Returns: { [YYYY-MM-DD]: Event[] }
 *
 * Event = {
 *   id, kind: 'assignment' | 'quiz' | 'announcement',
 *   icon, courseCode, courseId,
 *   title, href, date (ISO),
 *   submitted (only for assignments),
 *   closed (only for assignments — submission window has passed)
 * }
 */
export function buildSchedule(courses, bundles) {
  const byDay = {};
  const push = (key, ev) => {
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(ev);
  };

  for (const c of courses) {
    const ouId = String(c.OrgUnitId);
    const code = shortCode(c);
    const b = bundles[ouId] || {};
    const submittedSet = new Set((b.submittedFolderIds || []).map(String));

    /* Assignments — DueDate. Include submitted ones (rendered differently).
     * Mark closed-window items so they can be visually dimmed. */
    const folders = (b.dropbox && !b.dropbox.__error) ? b.dropbox : [];
    for (const f of folders) {
      if (!f.DueDate) continue;
      const date = new Date(f.DueDate);
      const closed = !!(f.Availability && f.Availability.EndDate && new Date(f.Availability.EndDate).getTime() < Date.now());
      push(dayKey(date), {
        id: `dropbox:${ouId}:${f.Id}`,
        kind: 'assignment',
        icon: 'file',
        courseCode: code,
        courseId: ouId,
        title: f.Name,
        href: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${f.Id}&ou=${ouId}`,
        date: f.DueDate,
        submitted: submittedSet.has(String(f.Id)),
        closed,
      });
    }

    /* Quizzes — DueDate or EndDate. Submission state from cached attempts. */
    const quizzes = (b.quizzes && !b.quizzes.__error && b.quizzes.Objects) || [];
    const attemptsMap = (b.quizAttempts && !b.quizAttempts.__error) ? b.quizAttempts : {};
    for (const q of quizzes) {
      const date = q.DueDate || q.EndDate;
      if (!date) continue;
      const attempt = attemptsMap[q.QuizId];
      push(dayKey(new Date(date)), {
        id: `quiz:${ouId}:${q.QuizId}`,
        kind: 'quiz',
        icon: 'quiz',
        courseCode: code,
        courseId: ouId,
        title: q.Name,
        href: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${q.QuizId}&ou=${ouId}`,
        date,
        submitted: !!(attempt && attempt.hasCompleted),
      });
    }

    /* Announcements — CreatedDate / LastModifiedDate. */
    const news = (b.news && !b.news.__error) ? b.news : [];
    for (const n of news) {
      const date = n.LastModifiedDate || n.CreatedDate;
      if (!date) continue;
      push(dayKey(new Date(date)), {
        id: `news:${ouId}:${n.Id}`,
        kind: 'announcement',
        icon: 'megaphone',
        courseCode: code,
        courseId: ouId,
        title: n.Title,
        href: `${BASE}/d2l/lms/news/main.d2l?ou=${ouId}`,
        date,
      });
    }
  }

  // Stable sort within each day: announcements first, then assignments, then quizzes
  const kindOrder = { announcement: 0, assignment: 1, quiz: 2 };
  for (const k of Object.keys(byDay)) {
    byDay[k].sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.title.localeCompare(b.title));
  }
  return byDay;
}

/* Generate the 42-cell month grid (6 weeks) starting from Sunday before the 1st. */
export function monthDays(year, month) {
  const first = new Date(year, month, 1);
  const dayOfWeek = first.getDay(); // 0 = Sun
  const start = new Date(year, month, 1 - dayOfWeek);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

/* Find course-keyed data (schedules, photos) whose ouId is no longer in
 * the user's current course list — i.e. left over from previous semesters.
 *
 * Returns { schedules: [ouId,...], photos: [ouId,...] }. Callers can show
 * counts before asking the user to confirm a manual cleanup. Auto-cleanup
 * is intentionally NOT done at boot because a stale fetch / fresh install
 * could wipe legitimate data — manual confirm is the only safe trigger. */
export function findOrphanedCourseData(courses, classSchedules, photos) {
  const valid = new Set((courses || []).map(c => String(c.OrgUnitId)));
  const scheduleKeys = Object.keys(classSchedules || {});
  const photoKeys = Object.keys(photos || {});
  return {
    schedules: scheduleKeys.filter(k => !valid.has(String(k))),
    photos: photoKeys.filter(k => !valid.has(String(k))),
  };
}

/* Live-class detection for a per-course recurring weekly schedule.
 *
 * Schedule shape:
 *   { link: string, blocks: [{ days: [0..6], time: 'HH:MM', duration: minutes }] }
 *
 * Returns one of:
 *   { status: 'live',  link, minutesIn }      — happening now
 *   { status: 'soon',  link, minutesUntil }   — within `soonMinutes` of start
 *   { status: 'idle' }                        — neither
 *
 * Only checks today's blocks. A weekly recurring schedule with the same
 * day-of-week check is enough — we don't need to look ahead to tomorrow
 * because the badge is for the immediate present. */
export function liveStatus(schedule, now = new Date(), soonMinutes = 15) {
  if (!schedule || !Array.isArray(schedule.blocks) || schedule.blocks.length === 0) {
    return { status: 'idle' };
  }
  const todayDow = now.getDay();
  const nowMs = now.getTime();
  const soonMs = soonMinutes * 60 * 1000;
  let bestSoon = null;

  for (const block of schedule.blocks) {
    if (!Array.isArray(block.days) || !block.days.includes(todayDow)) continue;
    const [h, m] = String(block.time || '').split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    const start = new Date(now);
    start.setHours(h, m, 0, 0);
    const startMs = start.getTime();
    const endMs = startMs + (block.duration || 60) * 60 * 1000;

    if (nowMs >= startMs && nowMs < endMs) {
      return {
        status: 'live',
        link: schedule.link || null,
        minutesIn: Math.floor((nowMs - startMs) / 60000),
      };
    }
    if (nowMs >= startMs - soonMs && nowMs < startMs) {
      const minutesUntil = Math.ceil((startMs - nowMs) / 60000);
      if (!bestSoon || minutesUntil < bestSoon.minutesUntil) {
        bestSoon = { status: 'soon', link: schedule.link || null, minutesUntil };
      }
    }
  }
  return bestSoon || { status: 'idle' };
}

/* Grade summary across all courses.
 *
 * D2L's `grades/values/myGradeValues/` returns an array of grade objects per
 * course, each with PointsNumerator, PointsDenominator, WeightedNumerator,
 * and WeightedDenominator. We aggregate into per-course percentage and an
 * overall weighted average.
 *
 * Returns: {
 *   courses: [{ code, name, courseId, scored, total, pct, items }],
 *   overall: { scored, total, pct } | null,
 *   totalItems: number
 * } */
export function buildGradeSummary(courses, bundles) {
  const out = [];
  let overallScored = 0;
  let overallTotal = 0;
  let totalItems = 0;

  for (const c of courses) {
    const b = bundles[c.OrgUnitId] || {};
    const grades = (b.grades && !b.grades.__error) ? b.grades : [];
    if (!grades.length) continue;

    let scored = 0;
    let total = 0;
    let items = 0;

    for (const g of grades) {
      if (g.PointsNumerator == null || g.PointsDenominator == null) continue;
      if (g.PointsDenominator === 0) continue;
      scored += g.PointsNumerator;
      total += g.PointsDenominator;
      items++;
    }

    if (items === 0) continue;
    const pct = total > 0 ? (scored / total) * 100 : 0;
    out.push({
      code: shortCode(c),
      name: displayName(c),
      courseId: String(c.OrgUnitId),
      scored: Math.round(scored * 100) / 100,
      total: Math.round(total * 100) / 100,
      pct: Math.round(pct * 10) / 10,
      items,
    });
    overallScored += scored;
    overallTotal += total;
    totalItems += items;
  }

  // Sort by percentage ascending — weakest first so student sees what to focus on.
  out.sort((a, b) => a.pct - b.pct);

  const overall = overallTotal > 0
    ? {
        scored: Math.round(overallScored * 100) / 100,
        total: Math.round(overallTotal * 100) / 100,
        pct: Math.round((overallScored / overallTotal) * 1000) / 10,
      }
    : null;

  return { courses: out, overall, totalItems };
}
