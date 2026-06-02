import * as derive from '../derive.js';
import { escapeHtml } from '../util.js';
import { openScheduleEditor } from './class-schedule.js';
import { positionAnchored, bindDismissable } from './popover.js';

const $ = (sel) => document.querySelector(sel);

let _state = null;

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Maps 0-5 index here to 1-6 index in BigSky/JS dates (0=Sun, 1=Mon... 6=Sat)
const DAY_INDEX = [1, 2, 3, 4, 5, 6];

// The timetable grid goes from 07:00 to 21:00 (14 hours)
const START_HOUR = 7;
const END_HOUR = 21;

const pickerState = { anchor: null, day: null, time: null };

export function initWeeklySchedule({ state }) {
  _state = state;
  bindDismissable({
    isOpen: () => !!pickerState.anchor,
    close: closeCoursePicker,
    ignoreSelectors: ['#course-picker-popover', '.ws-empty-slot'],
  });
}

function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h + m / 60;
}

function formatTimeRange(timeStr, durationMin) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0);
  const start = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  d.setMinutes(d.getMinutes() + durationMin);
  const end = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${start} - ${end}`;
}

export function renderWeeklySchedule() {
  const container = $('#weekly-schedule');
  const grid = $('#weekly-schedule-grid');
  if (!container || !grid) return;

  // We show it if we have courses
  if (!_state.courses || !_state.courses.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  // Build the grid background and time labels
  let html = `<div class="ws-time-col">
    <div class="ws-day-head"></div>
    <div class="ws-time-body">`;
  for (let i = START_HOUR; i < END_HOUR; i++) {
    const label = i === 12 ? '12 PM' : (i > 12 ? `${i - 12} PM` : `${i} AM`);
    html += `<div class="ws-time-label"><span>${label}</span></div>`;
  }
  html += `</div></div>`; // .ws-time-body, .ws-time-col

  // Build each day column
  DAY_INDEX.forEach((dayIdx, i) => {
    html += `<div class="ws-day-col">
      <div class="ws-day-head">${DAY_LABELS[i]}</div>
      <div class="ws-day-body" data-day="${dayIdx}">`;
    
    // Add empty click targets for each hour block (from START_HOUR to END_HOUR - 1)
    for (let h = START_HOUR; h < END_HOUR; h++) {
      html += `<div class="ws-empty-slot" data-hour="${h}"></div>`;
    }

    // Plot blocks for this day
    const blocksHtml = [];
    Object.entries(_state.classSchedules).forEach(([ouId, schedule]) => {
      if (!schedule || !schedule.blocks) return;
      const course = _state.courses.find(c => String(c.OrgUnitId) === String(ouId));
      if (!course) return; // Course might be hidden/dropped
      const ci = derive.colorIndex(derive.shortCode(course));
      const code = derive.shortCode(course);
      
      schedule.blocks.forEach(block => {
        if (!block.days.includes(dayIdx)) return;
        
        const t = parseTime(block.time);
        if (t >= END_HOUR || t + block.duration / 60 <= START_HOUR) return;
        
        // Calculate position
        const top = Math.max(0, (t - START_HOUR) / (END_HOUR - START_HOUR) * 100);
        const height = (block.duration / 60) / (END_HOUR - START_HOUR) * 100;
        
        const timeRange = formatTimeRange(block.time, block.duration);

        blocksHtml.push(`
          <button type="button" class="ws-block chip-c${ci}" 
               style="top: ${top}%; height: ${height}%;"
               data-ouid="${escapeHtml(ouId)}"
               data-code="${escapeHtml(code)}">
            <div class="ws-block-code">${escapeHtml(code)}</div>
            <div class="ws-block-time">${escapeHtml(timeRange)}</div>
          </button>
        `);
      });
    });

    html += blocksHtml.join('');
    html += `</div></div>`; // ws-day-body, ws-day-col
  });

  grid.innerHTML = html;

  // Wire up existing blocks (click to edit)
  grid.querySelectorAll('.ws-block').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const ouId = b.dataset.ouid;
      const code = b.dataset.code;
      openScheduleEditor(ouId, b, code);
    });
  });

  // Wire up empty slots (click to add)
  grid.querySelectorAll('.ws-empty-slot').forEach(slot => {
    slot.addEventListener('click', (e) => {
      e.stopPropagation();
      const day = Number(slot.closest('.ws-day-body').dataset.day);
      const hour = Number(slot.dataset.hour);
      const timeStr = `${hour.toString().padStart(2, '0')}:00`;
      openCoursePicker(slot, day, timeStr);
    });
  });
}

function openCoursePicker(anchor, day, time) {
  pickerState.anchor = anchor;
  pickerState.day = day;
  pickerState.time = time;

  const pop = $('#course-picker-popover');
  
  // Render course list
  const courses = _state.courses.slice(0, 20); // show top 20 or all
  const listHtml = courses.map(c => {
    const code = derive.shortCode(c);
    const name = derive.displayName(c) || c.Name;
    const ci = derive.colorIndex(code);
    return `
      <button class="cp-course-btn" type="button" data-ouid="${c.OrgUnitId}" data-code="${escapeHtml(code)}">
        <span class="cp-course-dot chip-c${ci}"></span>
        <span class="cp-course-code">${escapeHtml(code)}</span>
        <span class="cp-course-name">${escapeHtml(name)}</span>
      </button>
    `;
  }).join('');

  pop.innerHTML = `
    <div class="cp-head">Select a course to schedule</div>
    <div class="cp-list">${listHtml}</div>
  `;
  
  pop.hidden = false;
  positionAnchored(pop, anchor, { width: 280, gap: 4, align: 'center', margin: 12 });
  requestAnimationFrame(() => pop.classList.add('visible'));

  // Wire course clicks
  pop.querySelectorAll('.cp-course-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ouId = btn.dataset.ouid;
      const code = btn.dataset.code;
      const { day: d, time: t } = pickerState;
      closeCoursePicker();
      openScheduleEditor(ouId, anchor, code, { day: d, time: t });
    });
  });
}

function closeCoursePicker() {
  const pop = $('#course-picker-popover');
  pop.classList.remove('visible');
  setTimeout(() => { if (!pickerState.anchor) return; pop.hidden = true; }, 160);
  pickerState.anchor = null;
}
