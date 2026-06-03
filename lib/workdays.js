const path = require('path');
const fs = require('fs');

let holidayData = null;

function loadHolidayData() {
  if (holidayData) return holidayData;
  const jsonPath = path.join(__dirname, 'holidays.json');
  holidayData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  return holidayData;
}

function reloadHolidayData() {
  holidayData = null;
  return loadHolidayData();
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Determine if a given date is a working day under Chinese holiday rules.
 * Priority: statutory holiday > 调休 workday > normal weekday/weekend
 */
function isWorkday(date) {
  const data = loadHolidayData();
  const dateStr = formatDate(date);
  const yearStr = String(date.getFullYear());

  const yearData = data[yearStr];
  if (yearData) {
    if (yearData.holidays && yearData.holidays.includes(dateStr)) {
      return false;
    }
    if (yearData.workdays && yearData.workdays.includes(dateStr)) {
      return true;
    }
  }

  return !isWeekend(date);
}

/**
 * Count working days in [startDate, endDate) — start inclusive, end exclusive.
 * If includeToday is true, startDate itself is counted (if it's a workday).
 * If includeToday is false, counting starts from startDate + 1.
 */
function countWorkdays(startDate, endDate, includeToday = false) {
  let count = 0;
  const current = new Date(startDate);
  if (!includeToday) {
    current.setDate(current.getDate() + 1);
  }

  const end = new Date(endDate);
  while (current < end) {
    if (isWorkday(current)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 20;
const WORK_SECONDS_TOTAL = (WORK_END_HOUR - WORK_START_HOUR) * 3600;

/**
 * Remaining fraction of today's work window (9:00–20:00, continuous by second).
 * Before 9:00 → 1.0; at/after 20:00 → 0; non-workday → 0.
 */
function getTodayRemainingWorkdayFraction(now = new Date()) {
  if (!isWorkday(now)) return 0;

  const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const workStart = WORK_START_HOUR * 3600;
  const workEnd = WORK_END_HOUR * 3600;

  if (nowSeconds < workStart) return 1;
  if (nowSeconds >= workEnd) return 0;

  const elapsed = nowSeconds - workStart;
  return (WORK_SECONDS_TOTAL - elapsed) / WORK_SECONDS_TOTAL;
}

/**
 * Parse billing cycle end: epoch ms string, ISO datetime, or YYYY-MM-DD (legacy).
 */
function parseResetInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null) return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const d = new Date(Number(value));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(`${value}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Fraction of 9:00–20:00 on dayMidnight covered by [rangeStart, rangeEnd).
 */
function getWorkdayWindowFractionOnDay(dayMidnight, rangeStart, rangeEnd) {
  if (!isWorkday(dayMidnight)) return 0;

  const workStart = new Date(dayMidnight);
  workStart.setHours(WORK_START_HOUR, 0, 0, 0);
  const workEnd = new Date(dayMidnight);
  workEnd.setHours(WORK_END_HOUR, 0, 0, 0);

  const segStart = new Date(Math.max(rangeStart.getTime(), workStart.getTime()));
  const segEnd = new Date(Math.min(rangeEnd.getTime(), workEnd.getTime()));

  if (segStart >= segEnd) return 0;
  return (segEnd.getTime() - segStart.getTime()) / 1000 / WORK_SECONDS_TOTAL;
}

/**
 * Fractional workdays from now until billing cycle end (exclusive).
 * Uses exact reset instant; each day only counts 9:00–20:00 overlap with [now, reset).
 */
function countFractionalWorkdays(fromDate, resetInstant) {
  const reset = parseResetInstant(resetInstant);
  if (!reset || fromDate >= reset) return 0;

  let total = 0;
  let dayCursor = new Date(fromDate);
  dayCursor.setHours(0, 0, 0, 0);
  let segmentStart = new Date(fromDate);

  while (dayCursor < reset) {
    const dayEnd = new Date(dayCursor);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const segmentEnd = reset < dayEnd ? reset : dayEnd;

    if (segmentStart < segmentEnd) {
      total += getWorkdayWindowFractionOnDay(dayCursor, segmentStart, segmentEnd);
    }

    dayCursor = dayEnd;
    segmentStart = dayCursor;
  }

  return Math.round(total * 1000) / 1000;
}

/** Work-window status for tooltips. */
function getWorkdayTimeInfo(now = new Date()) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const timeStr = `${hh}:${mm}:${ss}`;

  if (!isWorkday(now)) {
    return { label: `${timeStr}（非工作日）`, todayFraction: 0 };
  }

  const frac = getTodayRemainingWorkdayFraction(now);
  if (frac >= 1) {
    return { label: `${timeStr}（${WORK_START_HOUR}:00 前，今日计 1.00 day）`, todayFraction: 1 };
  }
  if (frac <= 0) {
    return { label: `${timeStr}（${WORK_END_HOUR}:00 后，今日计 0 day）`, todayFraction: 0 };
  }

  return {
    label: `${timeStr}（今日剩余 ${(frac * 100).toFixed(2)}% 工作日）`,
    todayFraction: frac,
  };
}

/**
 * Calculate daily budget: remaining% / fractional remaining workdays.
 * Capped at remaining% so 日估 + 已用 never exceeds 100%.
 * On the last stretch (≤1 fractional workday left), budget is whatever remains.
 */
function calculateDailyBudget(usedPercent, resetInstant, now = new Date()) {
  const reset = parseResetInstant(resetInstant);

  if (!reset || now >= reset) {
    return {
      error: reset ? 'Reset date is in the past' : 'Invalid reset time',
      remainingDays: 0,
      dailyBudget: 0,
      remainingPercent: 0,
      todayFraction: 0,
      resetAt: reset ? reset.toISOString() : null,
    };
  }

  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remainingDays = countFractionalWorkdays(now, reset);
  const todayFraction = isWorkday(now) ? getTodayRemainingWorkdayFraction(now) : 0;

  if (remainingDays === 0) {
    return {
      remainingDays: 0,
      dailyBudget: remainingPercent,
      remainingPercent: Math.round(remainingPercent * 100) / 100,
      todayFraction,
      resetAt: reset.toISOString(),
      isLastStretch: true,
    };
  }

  // 日估 + 已用 ≤ 100%：日估不得超过剩余额度（剩余 <1 工作日时即「有多少算多少」）
  const dailyBudget = Math.min(remainingPercent / remainingDays, remainingPercent);

  return {
    remainingDays,
    dailyBudget: Math.round(dailyBudget * 100) / 100,
    remainingPercent: Math.round(remainingPercent * 100) / 100,
    todayFraction,
    resetAt: reset.toISOString(),
    isLastStretch: remainingDays < 1,
  };
}

/**
 * API "day" window: today 9:00 → tomorrow 9:00 (before 9:00 counts as previous day).
 */
function getApiDayWindow(now = new Date()) {
  const start = new Date(now);
  start.setHours(WORK_START_HOUR, 0, 0, 0);
  if (now < start) {
    start.setDate(start.getDate() - 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

module.exports = {
  isWorkday,
  countWorkdays,
  countFractionalWorkdays,
  getTodayRemainingWorkdayFraction,
  getWorkdayTimeInfo,
  getApiDayWindow,
  calculateDailyBudget,
  parseResetInstant,
  reloadHolidayData,
  formatDate,
  WORK_START_HOUR,
  WORK_END_HOUR,
};
