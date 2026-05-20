const vscode = require('vscode');
const { readTokenFromDb, fetchUsageData } = require('./lib/cursorApi');
const { buildTooltipLines, fmtPct, formatTodayUsageStatusBar } = require('./lib/usageDetails');
const {
  calculateDailyBudget,
  reloadHolidayData,
  getWorkdayTimeInfo,
} = require('./lib/workdays');

let statusBarDaily;
let statusBarUsed;
let statusBarDays;
let statusBarToday;
let refreshTimer;
let cachedData = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('cursorBudget');
  return {
    refreshInterval: cfg.get('refreshIntervalSeconds', 60),
    showInStatusBar: cfg.get('showInStatusBar', true),
    warningThreshold: cfg.get('warningThresholdPercent', 80),
    criticalThreshold: cfg.get('criticalThresholdPercent', 95),
  };
}

async function updateConfig(key, value) {
  const cfg = vscode.workspace.getConfiguration('cursorBudget');
  await cfg.update(key, value, vscode.ConfigurationTarget.Global);
}

async function fetchAndCompute() {
  const config = getConfig();
  let membershipType = 'unknown';
  let fetchError = null;
  let usageSource = null;
  let apiPercent = null;
  let resetDate = null;
  let summary = null;
  let todayApiUsage = null;

  try {
    const tokenResult = readTokenFromDb();
    if (tokenResult.error) {
      fetchError = tokenResult.error;
    } else {
      const usage = await fetchUsageData(
        tokenResult.sessionToken,
        tokenResult.userId,
        tokenResult.accessToken,
      );
      membershipType = usage.membershipType;
      usageSource = usage.usageSource;
      apiPercent = usage.apiUsedPercent;
      resetDate = usage.resetDate;
      summary = usage.summary;
      todayApiUsage = usage.todayApiUsage;

      if (usage.fetchErrors?.length && apiPercent === null) {
        fetchError = usage.fetchErrors.join('; ');
      } else if (usage.fetchErrors?.length) {
        fetchError = usage.fetchErrors.join('; ');
      }
    }
  } catch (err) {
    fetchError = err.message || String(err);
  }

  if (!resetDate || apiPercent === null) {
    return {
      error: resetDate
        ? '无法获取 API 用量，请确认已登录 Cursor 并重试'
        : '无法获取计费周期/重置日，请确认已登录 Cursor 并重试',
      membershipType,
      fetchError,
      usageSource,
      refreshInterval: config.refreshInterval,
    };
  }

  const apiBudget = calculateDailyBudget(apiPercent, resetDate);
  const workdayTimeInfo = getWorkdayTimeInfo(new Date());

  return {
    resetDate,
    membershipType,
    apiPercent,
    apiBudget,
    summary,
    todayApiUsage,
    fetchError,
    usageSource,
    workdayTimeInfo,
    refreshInterval: config.refreshInterval,
    warningThreshold: config.warningThreshold,
    criticalThreshold: config.criticalThreshold,
  };
}

function usageIcon(percent, warning, critical) {
  if (percent >= critical) return '$(flame)';
  if (percent >= warning) return '$(warning)';
  return '$(pulse)';
}

function updateStatusBar(data) {
  const items = [statusBarDays, statusBarUsed, statusBarToday, statusBarDaily];
  if (items.some((item) => !item)) return;

  const config = getConfig();
  if (!config.showInStatusBar) {
    items.forEach((item) => item.hide());
    return;
  }

  const tooltip = buildTooltipLines(data);

  if (data.error) {
    const short = data.error.slice(0, 28);
    statusBarDays.text = `$(warning) ${short}`;
    statusBarUsed.hide();
    statusBarToday.hide();
    statusBarDaily.hide();
    statusBarDays.tooltip = [data.error, data.fetchError || ''].filter(Boolean).join('\n');
    statusBarDays.command = undefined;
    statusBarDays.show();
    return;
  }

  const { dailyBudget, remainingDays } = data.apiBudget;
  const icon = usageIcon(data.apiPercent, data.warningThreshold, data.criticalThreshold);

  statusBarDays.text = `$(calendar) ${remainingDays.toFixed(2)} day`;
  statusBarUsed.text = `${icon} API ${fmtPct(data.apiPercent)}`;
  statusBarToday.text = `$(history) ${formatTodayUsageStatusBar(data.todayApiUsage)}`;
  statusBarDaily.text = `$(graph) 日估 ${dailyBudget.toFixed(2)}%/d`;

  for (const item of items) {
    item.tooltip = tooltip;
    item.command = undefined;
    item.show();
  }
}

function buildQuickPickItems() {
  const config = getConfig();
  return [
    {
      label: '$(globe) 打开 Cursor 用量 Dashboard',
      description: 'cursor.com/dashboard/usage',
      id: 'dashboard',
    },
    {
      label: '$(watch) 设置刷新间隔（秒）',
      description: `当前: ${config.refreshInterval} 秒`,
      id: 'refreshInterval',
    },
    {
      label: '$(sync) 立即刷新',
      description: cachedData?.usageSource || '',
      id: 'refresh',
    },
  ];
}

async function promptRefreshInterval(currentValue) {
  const input = await vscode.window.showInputBox({
    title: '设置刷新间隔',
    prompt: '状态栏自动刷新间隔（秒），最小 10',
    value: String(currentValue),
    validateInput: (v) => {
      const n = Number(v);
      if (isNaN(n) || n < 10) return '请输入不小于 10 的整数';
      if (!Number.isInteger(n)) return '请输入整数秒数';
      return null;
    },
  });
  if (input === undefined) return undefined;
  return Number(input);
}

async function showQuickMenu() {
  const picked = await vscode.window.showQuickPick(buildQuickPickItems(), {
    title: 'Cursor Daily Budget',
    placeHolder: '选择操作',
  });
  if (!picked) return;

  const config = getConfig();

  switch (picked.id) {
    case 'dashboard':
      vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard/usage'));
      break;
    case 'refreshInterval': {
      const val = await promptRefreshInterval(config.refreshInterval);
      if (val === undefined) return;
      await updateConfig('refreshIntervalSeconds', val);
      break;
    }
    case 'refresh': {
      reloadHolidayData();
      await refresh();
      vscode.window.showInformationMessage('Cursor Budget: 已刷新');
      break;
    }
  }
}

async function refresh() {
  try {
    cachedData = await fetchAndCompute();
    updateStatusBar(cachedData);
  } catch (err) {
    if (statusBarDays) {
      statusBarDays.text = '$(error) Budget Error';
      statusBarDays.tooltip = String(err);
      statusBarDays.command = undefined;
      statusBarDays.show();
    }
    if (statusBarUsed) statusBarUsed.hide();
    if (statusBarToday) statusBarToday.hide();
    if (statusBarDaily) statusBarDaily.hide();
  }
}

function startTimer() {
  stopTimer();
  const interval = getConfig().refreshInterval * 1000;
  refreshTimer = setInterval(() => refresh(), interval);
}

function stopTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function createStatusBarItem(context, priority) {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority,
  );
  context.subscriptions.push(item);
  return item;
}

function activate(context) {
  // VS Code: higher priority = further left
  statusBarDays = createStatusBarItem(context, -97);
  statusBarUsed = createStatusBarItem(context, -98);
  statusBarToday = createStatusBarItem(context, -99);
  statusBarDaily = createStatusBarItem(context, -100);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorBudget.refresh', async () => {
      reloadHolidayData();
      await refresh();
      vscode.window.showInformationMessage('Cursor Budget: 已刷新');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorBudget.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://cursor.com/dashboard/usage'));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorBudget.quickMenu', showQuickMenu),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorBudget')) {
        startTimer();
        refresh();
      }
    }),
  );

  refresh();
  startTimer();
}

function deactivate() {
  stopTimer();
  for (const item of [statusBarDaily, statusBarUsed, statusBarDays, statusBarToday]) {
    if (item) item.dispose();
  }
  statusBarDaily = null;
  statusBarUsed = null;
  statusBarDays = null;
  statusBarToday = null;
}

module.exports = { activate, deactivate };
