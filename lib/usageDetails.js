/**
 * Parse usage data and build status bar tooltips.
 */

/** Plan pool limits in cents (Cursor Ultra: API $500, Auto $1000). */
const PLAN_POOL_LIMITS = {
  ultra: { apiLimitCents: 50_000, autoLimitCents: 100_000 },
};

function centsToDollars(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  return cents / 100;
}

function formatDollars(cents) {
  const d = centsToDollars(cents);
  if (d === null) return '—';
  return `$${d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDollarsFromPercent(percent, limitCents) {
  if (percent == null || limitCents == null) return '—';
  const used = (percent / 100) * limitCents;
  return `${formatDollars(used)} / ${formatDollars(limitCents)}`;
}

const TOOLTIP_LABEL_WIDTH = 6;

/** Fine-tune separator alignment for Latin labels vs CJK rows. */
const LABEL_PAD_ADJUST = {
  API: 1,
  Auto: -1,
};

/** Display width for mixed CJK / Latin (CJK counts as 2). */
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (
      code > 0xff
      || (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function tooltipRow(label, value) {
  const adjust = LABEL_PAD_ADJUST[label] || 0;
  const pad = Math.max(1, TOOLTIP_LABEL_WIDTH - displayWidth(label) + adjust);
  return `${label}${' '.repeat(pad)}│ ${value}`;
}

function applyPoolLimits(summary, membershipType) {
  const key = (membershipType || '').toLowerCase();
  const pools = PLAN_POOL_LIMITS[key];
  if (!pools || !summary) return summary;

  if (summary.apiUsedPercent != null) {
    summary.apiLimitCents = pools.apiLimitCents;
    summary.apiUsedCents = (summary.apiUsedPercent / 100) * pools.apiLimitCents;
    summary.apiRemainingCents = pools.apiLimitCents - summary.apiUsedCents;
  }

  if (summary.autoPercentUsed != null) {
    summary.autoLimitCents = pools.autoLimitCents;
    summary.autoUsedCents = (summary.autoPercentUsed / 100) * pools.autoLimitCents;
    summary.autoRemainingCents = pools.autoLimitCents - summary.autoUsedCents;
  }

  return summary;
}

function parseUsageSummaryRich(summary) {
  if (!summary || typeof summary !== 'object') return null;

  const plan = summary.individualUsage?.plan || summary.teamUsage?.plan || null;
  const onDemand = summary.individualUsage?.onDemand || summary.teamUsage?.onDemand || null;

  let apiUsedPercent = plan?.apiPercentUsed ?? null;
  if (apiUsedPercent === null && plan?.limit > 0 && typeof plan.used === 'number') {
    apiUsedPercent = (plan.used / plan.limit) * 100;
  }

  const billingCycleEnd = summary.billingCycleEnd || null;
  const resetDate = billingCycleEnd
    ? (typeof billingCycleEnd === 'string' && /^\d+$/.test(billingCycleEnd)
      ? new Date(Number(billingCycleEnd)).toISOString().split('T')[0]
      : String(billingCycleEnd).split('T')[0])
    : null;

  const membershipType = summary.membershipType || null;

  const base = {
    apiUsedPercent,
    autoPercentUsed: plan?.autoPercentUsed ?? null,
    totalPercentUsed: plan?.totalPercentUsed ?? null,
    resetDate,
    billingCycleStart: summary.billingCycleStart || null,
    billingCycleEnd,
    membershipType,
    onDemandEnabled: onDemand?.enabled ?? false,
    onDemandUsedCents: onDemand?.used ?? null,
    autoMessage: summary.autoModelSelectedDisplayMessage || '',
    apiMessage: summary.namedModelSelectedDisplayMessage || '',
    isUnlimited: summary.isUnlimited ?? false,
  };

  return applyPoolLimits(base, membershipType);
}

/** Fallback when Connect RPC auto bucket list is unavailable. */
const DEFAULT_AUTO_BUCKET_MODELS = [
  'default',
  'composer-1',
  'composer-1-alpha',
  'composer-1.5',
  'composer-1.5-auto',
  'composer-2',
  'composer-2-fast',
  'composer-2.5',
  'composer-2.5-fast',
];

function isAutoModel(model, autoBucketModels = DEFAULT_AUTO_BUCKET_MODELS) {
  if (!model) return false;
  if (autoBucketModels.includes(model)) return true;
  return model.startsWith('composer-');
}

function eventCostCents(event) {
  const token = event.tokenUsage || {};
  return event.chargedCents ?? token.totalCents ?? 0;
}

/** Sum API-pool spend for events in [windowStart, windowEnd). */
function computeTodayApiUsage(events, autoBucketModels, apiLimitCents) {
  let usedCents = 0;
  let apiEvents = 0;

  for (const event of events) {
    if (isAutoModel(event.model, autoBucketModels)) continue;
    usedCents += eventCostCents(event);
    apiEvents += 1;
  }

  const percentOfPool = apiLimitCents > 0
    ? (usedCents / apiLimitCents) * 100
    : null;

  return {
    usedCents: Math.round(usedCents * 100) / 100,
    apiEvents,
    percentOfPool: percentOfPool != null ? Math.round(percentOfPool * 100) / 100 : null,
  };
}

function formatTodayUsageStatusBar(todayApiUsage) {
  if (!todayApiUsage || todayApiUsage.percentOfPool == null) return '今日 —';
  return `今日 ${fmtPct(todayApiUsage.percentOfPool)}`;
}

function buildTooltipLines(data) {
  const lines = [];
  const s = data.summary;

  lines.push(tooltipRow('Plan', data.membershipType));

  if (s?.apiLimitCents != null) {
    lines.push(tooltipRow('API', formatDollarsFromPercent(data.apiPercent, s.apiLimitCents)));
  } else {
    lines.push(tooltipRow('API', fmtPct(data.apiPercent)));
  }

  if (s?.autoLimitCents != null) {
    lines.push(tooltipRow('Auto', formatDollarsFromPercent(s.autoPercentUsed, s.autoLimitCents)));
  }

  if (s?.billingCycleStart && s?.billingCycleEnd) {
    lines.push(tooltipRow('周期', `${formatDateTime(s.billingCycleStart)} → ${formatDateTime(s.billingCycleEnd)}`));
  } else {
    lines.push(tooltipRow('重置', data.resetDate || '—'));
  }

  lines.push(tooltipRow('用量', `API ${fmtPct(data.apiPercent)} · Auto ${fmtPct(s?.autoPercentUsed)} · 总 ${fmtPct(s?.totalPercentUsed)}`));

  if (data.todayApiUsage) {
    const t = data.todayApiUsage;
    const pct = t.percentOfPool != null ? fmtPct(t.percentOfPool) : '—';
    lines.push(tooltipRow('今日', `${formatDollars(t.usedCents)} · ${pct}（9:00→9:00）`));
  }

  const workday = formatWorkdayFooter(data.workdayTimeInfo);
  lines.push(tooltipRow('刷新', `${data.refreshInterval}s · ${workday}`));

  if (data.fetchError) {
    lines.push('');
    lines.push(`⚠ ${data.fetchError}`);
  }

  return lines.join('\n');
}

function formatWorkdayFooter(info) {
  if (!info?.label) return '—';
  const m = info.label.match(/^(\d{2}:\d{2}:\d{2})（(.+)）$/);
  if (m) return `${m[1]}（${m[2]}）`;
  return info.label;
}

function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

module.exports = {
  parseUsageSummaryRich,
  applyPoolLimits,
  computeTodayApiUsage,
  isAutoModel,
  buildTooltipLines,
  formatDollars,
  formatTodayUsageStatusBar,
  fmtPct,
  DEFAULT_AUTO_BUCKET_MODELS,
  PLAN_POOL_LIMITS,
};
