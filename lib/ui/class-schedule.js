/* Per-course online class schedule editor.
 *
 * Opens from the course overflow menu's "Class schedule" item. Lets the user
 * pick recurring meeting days, a start time, a duration, and a link to the
 * online class (Zoom / Meet / etc). Saved per-course in chrome.storage.sync.
 *
 * The Live badge on the course tile reads from the same store + derive.liveStatus()
 * to decide whether to show "LIVE" or a countdown.
 *
 * UX:
 *   - One time block per course (covers the most-common case where a class
 *     meets at the same time on multiple days).
 *   - Day chips are toggleable, no submit-on-change — Save is explicit.
 *   - Remove button clears the schedule entirely. */

import * as store from '../store.js';
import * as derive from '../derive.js';
import { ICONS } from '../icons.js';
import { escapeHtml } from '../util.js';
import { positionAnchored, bindDismissable } from './popover.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;
let _render = null;
const editorState = { openOuId: null, draft: null };

/* Default duration when first opening the editor for a course that has no
 * schedule yet. 90 minutes matches a typical 1.5-hour college block. */
const DEFAULT_DURATION = 90;
const DEFAULT_TIME = '09:00';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function initClassSchedule({ state, render }) {
  _state = state;
  _render = render;
  bindDismissable({
    isOpen: () => !!editorState.openOuId,
    close: closeEditor,
    ignoreSelectors: ['#class-schedule-editor', '[data-overflow]', '[data-menu-action="schedule"]'],
  });
}

export function openScheduleEditor(ouId, anchor, courseLabel) {
  // Seed the draft from saved schedule or sensible defaults.
  const saved = _state.classSchedules[String(ouId)];
  editorState.openOuId = String(ouId);
  editorState.draft = saved
    ? structuredClone(saved)
    : { link: '', blocks: [{ days: [], time: DEFAULT_TIME, duration: DEFAULT_DURATION }] };

  const pop = $('#class-schedule-editor');
  pop.innerHTML = renderEditor(courseLabel);
  pop.hidden = false;
  positionAnchored(pop, anchor, { width: 320, gap: 8, align: 'right', margin: 12 });
  requestAnimationFrame(() => pop.classList.add('visible'));

  wireEditor(pop, ouId);
}

function renderEditor(courseLabel) {
  const block = editorState.draft.blocks[0];
  const dayChips = DAY_LABELS.map((label, i) => {
    const active = block.days.includes(i);
    return `<button type="button" class="cs-day-chip${active ? ' is-active' : ''}" data-day="${i}">${label}</button>`;
  }).join('');

  const hasSaved = !!_state.classSchedules[editorState.openOuId];
  return `
    <div class="cs-head">
      <div class="cs-head-title">Class schedule</div>
      <div class="cs-head-sub">${escapeHtml(courseLabel || '')}</div>
      <button class="cs-close" type="button" aria-label="Close" data-cs-close>${ICONS.close}</button>
    </div>
    <div class="cs-section">
      <div class="cs-section-label">Meeting days</div>
      <div class="cs-day-chips">${dayChips}</div>
    </div>
    <div class="cs-row">
      <label class="cs-field">
        <span class="cs-field-label">Time</span>
        <input class="cs-input" type="time" data-cs-time value="${escapeHtml(block.time)}">
      </label>
      <label class="cs-field">
        <span class="cs-field-label">Duration (min)</span>
        <input class="cs-input" type="number" min="5" max="480" step="5" data-cs-duration value="${block.duration}">
      </label>
    </div>
    <div class="cs-section">
      <div class="cs-section-label">Online class link</div>
      <input class="cs-input cs-input--wide" type="url" placeholder="https://zoom.us/j/..."
             data-cs-link value="${escapeHtml(editorState.draft.link || '')}">
    </div>
    <div class="cs-foot">
      ${hasSaved ? `<button type="button" class="cs-btn cs-btn--ghost" data-cs-remove>Remove</button>` : '<span></span>'}
      <div class="cs-foot-actions">
        <button type="button" class="cs-btn cs-btn--ghost" data-cs-close>Cancel</button>
        <button type="button" class="cs-btn cs-btn--primary" data-cs-save>Save</button>
      </div>
    </div>
  `;
}

function wireEditor(pop, ouId) {
  // Day chip toggles
  pop.querySelectorAll('[data-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.day);
      const block = editorState.draft.blocks[0];
      const idx = block.days.indexOf(day);
      if (idx >= 0) block.days.splice(idx, 1);
      else block.days.push(day);
      btn.classList.toggle('is-active');
    });
  });
  // Time / duration
  pop.querySelector('[data-cs-time]').addEventListener('input', (e) => {
    editorState.draft.blocks[0].time = e.target.value;
  });
  pop.querySelector('[data-cs-duration]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (v > 0) editorState.draft.blocks[0].duration = v;
  });
  pop.querySelector('[data-cs-link]').addEventListener('input', (e) => {
    editorState.draft.link = e.target.value.trim();
  });

  // Buttons
  pop.querySelectorAll('[data-cs-close]').forEach(b =>
    b.addEventListener('click', closeEditor)
  );
  pop.querySelector('[data-cs-save]').addEventListener('click', () => save(ouId));
  const removeBtn = pop.querySelector('[data-cs-remove]');
  if (removeBtn) removeBtn.addEventListener('click', () => remove(ouId));
}

async function save(ouId) {
  const draft = editorState.draft;
  const block = draft.blocks[0];
  if (!block.days.length) {
    showToast('Pick at least one day.');
    return;
  }
  _state.classSchedules = await store.setClassSchedule(ouId, draft);
  closeEditor();
  _render();
  showToast('Class schedule saved.');
}

async function remove(ouId) {
  _state.classSchedules = await store.setClassSchedule(ouId, null);
  closeEditor();
  _render();
  showToast('Class schedule removed.');
}

function closeEditor() {
  const pop = $('#class-schedule-editor');
  pop.classList.remove('visible');
  setTimeout(() => { if (!editorState.openOuId) return; pop.hidden = true; }, 160);
  editorState.openOuId = null;
  editorState.draft = null;
}

/* Render the Live badge for a course tile, returns HTML string.
 * Called from courseTile() in dashboard.js. Returns empty string for idle. */
export function liveBadgeHtml(ouId, classSchedules) {
  const schedule = classSchedules[String(ouId)];
  const status = derive.liveStatus(schedule);
  if (status.status === 'idle') return '';
  const label = status.status === 'live' ? 'LIVE' : `${status.minutesUntil}m`;
  const cls = status.status === 'live' ? 'cs-live cs-live--now' : 'cs-live cs-live--soon';
  return `<span class="${cls}" data-live-link="${escapeHtml(status.link || '')}" data-live-ou="${escapeHtml(String(ouId))}">${label}</span>`;
}
