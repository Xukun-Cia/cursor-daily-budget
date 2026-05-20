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
 * Fractional workdays from now until resetDate (exclusive).
 * Today counts only the remaining 9:00–20:00 window; future workdays count as 1.0.
 */
function countFractionalWorkdays(fromDate, resetDateStr) {
  const resetDate = new Date(resetDateStr + 'T00:00:00');
  const todayStart = new Date(fromDate);
  todayStart.setHours(0, 0, 0, 0);

  if (resetDate <= todayStart) return 0;

  let total = 0;
  if (isWorkday(fromDate)) {
    total += getTodayRemainingWorkdayFraction(fromDate);
  }

  const current = new Date(todayStart);
  current.setDate(current.getDate() + 1);
  while (current < resetDate) {
    if (isWorkday(current)) total += 1;
    current.setDate(current.getDate() + 1);
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
 */
function calculateDailyBudget(usedPercent, resetDateStr, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const resetDate = new Date(resetDateStr + 'T00:00:00');

  if (resetDate <= today) {
    return {
      error: 'Reset date is in the past',
      remainingDays: 0,
      dailyBudget: 0,
      remainingPercent: 0,
      todayFraction: 0,
    };
  }

  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remainingDays = countFractionalWorkdays(now, resetDateStr);
  const todayFraction = isWorkday(now) ? getTodayRemainingWorkdayFraction(now) : 0;

  if (remainingDays === 0) {
    return { remainingDays: 0, dailyBudget: remainingPercent, remainingPercent, todayFraction };
  }

  const dailyBudget = remainingPercent / remainingDays;

  return {
    remainingDays,
    dailyBudget: Math.round(dailyBudget * 100) / 100,
    remainingPercent: Math.round(remainingPercent * 100) / 100,
    todayFraction,
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
  reloadHolidayData,
  formatDate,
  WORK_START_HOUR,
  WORK_END_HOUR,
};
