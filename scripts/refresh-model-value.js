const { readTokenFromDb, fetchUsageData } = require('../lib/cursorApi');
const https = require('https');

const PRICING = {
  'gpt-5.6-sol-max': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  'gpt-5.6-sol-high': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  'gpt-5.6-sol-medium': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  'gpt-5.5-medium': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  'gpt-5.3-codex': { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  'fable-5-high': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'fable-5-xhigh': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'fable-5-max': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'opus-4.6-max': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.6-high': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-5-high': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'composer-2.5-fast': { input: 0.5, cacheWrite: 0, cacheRead: 0.2, output: 2.5 },
  'grok-4.5': { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  'default': { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6 },
};

function post(path, sessionToken, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'cursor.com', path, method: 'POST',
      headers: {
        Cookie: 'WorkosCursorSessionToken=' + sessionToken,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard/usage',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (x) => {
      let d = '';
      x.on('data', (c) => (d += c));
      x.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(Error('HTTP ' + x.statusCode + ' ' + d.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchAll(sessionToken, startMs, endMs) {
  const all = [];
  let total = Infinity;
  for (let page = 1; page <= 80 && all.length < total; page++) {
    const body = JSON.stringify({
      startDate: String(startMs),
      endDate: String(endMs),
      page,
      pageSize: 100,
    });
    const resp = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'cursor.com',
          path: '/api/dashboard/get-filtered-usage-events',
          method: 'POST',
          headers: {
            Cookie: 'WorkosCursorSessionToken=' + sessionToken,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            Origin: 'https://cursor.com',
            Referer: 'https://cursor.com/dashboard/usage',
            Accept: 'application/json',
          },
        },
        (x) => {
          let d = '';
          x.on('data', (c) => (d += c));
          x.on('end', () =>
            x.statusCode >= 200 && x.statusCode < 300
              ? resolve(JSON.parse(d))
              : reject(Error('HTTP ' + x.statusCode)),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    total = resp.totalUsageEventsCount ?? total;
    all.push(...(resp.usageEventsDisplay || []));
  }
  return { all, total };
}

function alias(model) {
  if (model === 'default') return 'default';
  if (model.startsWith('composer-2.5')) return 'composer-2.5-fast';
  if (model.startsWith('composer-')) return model;
  if (model.includes('grok-4.5') || model.startsWith('cursor-grok')) return 'grok-4.5';
  if (model.startsWith('vega')) return model;
  const map = {
    'claude-fable-5-thinking-xhigh': 'fable-5-xhigh',
    'claude-fable-5-thinking-high': 'fable-5-high',
    'claude-fable-5-thinking-max': 'fable-5-max',
    'claude-4.6-opus-high-thinking': 'opus-4.6-high',
    'claude-4.6-opus-max-thinking': 'opus-4.6-max',
    'claude-opus-5-thinking-high': 'opus-5-high',
  };
  return map[model] || model;
}

function isCursorModel(model, autoBucketSet) {
  if (autoBucketSet.has(model)) return true;
  if (model === 'default' || model.startsWith('composer-') || model.startsWith('vega')) return true;
  if (model.includes('grok-4.5') || model.startsWith('cursor-grok-')) return true;
  return false;
}

function tokensOf(tu) {
  return (
    (tu.inputTokens || 0) +
    (tu.outputTokens || 0) +
    (tu.cacheReadTokens || 0) +
    (tu.cacheWriteTokens || 0)
  );
}

function officialUsd(name, tu) {
  const p = PRICING[name];
  if (!p || !tu) return 0;
  return (
    ((tu.inputTokens || 0) * p.input +
      (tu.outputTokens || 0) * p.output +
      (tu.cacheReadTokens || 0) * p.cacheRead +
      (tu.cacheWriteTokens || 0) * p.cacheWrite) /
    1e6
  );
}

function costParts(name, tu) {
  const p = PRICING[name] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: ((tu.inputTokens || 0) * p.input) / 1e6,
    output: ((tu.outputTokens || 0) * p.output) / 1e6,
    cacheRead: ((tu.cacheReadTokens || 0) * p.cacheRead) / 1e6,
    cacheWrite: ((tu.cacheWriteTokens || 0) * p.cacheWrite) / 1e6,
  };
}

(async () => {
  const t = readTokenFromDb();
  if (t.error) throw Error(t.error);
  const u = await fetchUsageData(t.sessionToken, t.userId, t.accessToken);
  const s = u.summary;
  const startMs = Date.parse(s.billingCycleStart);
  const endMs = Date.parse(s.billingCycleEnd);
  const period = await post('/api/dashboard/get-current-period-usage', t.sessionToken, {});
  const autoBucketSet = new Set(period.autoBucketModels || []);
  const { all, total } = await fetchAll(t.sessionToken, startMs, endMs);

  const spend = { api: 0, cursorModels: 0, userApi: 0, userApiEvents: 0, fallbackEvents: 0 };
  const by = new Map();

  for (const ev of all) {
    const kind = ev.kind || '';
    if (kind === 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED' || kind === 'USAGE_EVENT_KIND_FREE_CREDIT') {
      continue;
    }
    const model = ev.model || 'unknown';
    const tu = ev.tokenUsage || {};
    const name = alias(model);

    if (kind === 'USAGE_EVENT_KIND_USER_API_KEY') {
      spend.userApiEvents++;
      if (tu.totalCents != null) spend.userApi += tu.totalCents / 100;
      else {
        spend.fallbackEvents++;
        spend.userApi += officialUsd(name, tu);
      }
      continue;
    }

    const charged = ev.chargedCents != null ? ev.chargedCents : tu.totalCents ?? 0;
    const cursor = isCursorModel(model, autoBucketSet);
    if (cursor) spend.cursorModels += charged / 100;
    else spend.api += charged / 100;

    if (!by.has(name)) {
      by.set(name, {
        name,
        pool: cursor ? 'auto' : 'api',
        tokens: 0,
        cents: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
      });
    }
    const row = by.get(name);
    row.tokens += tokensOf(tu);
    row.cents += charged;
    const parts = costParts(name, tu);
    const off = officialUsd(name, tu);
    if (off > 0) {
      const scale = charged / 100 / off;
      row.costInput += parts.input * scale;
      row.costOutput += parts.output * scale;
      row.costCacheRead += parts.cacheRead * scale;
      row.costCacheWrite += parts.cacheWrite * scale;
    }
  }

  const autoPct = period.planUsage?.autoPercentUsed ?? s.autoPercentUsed;
  const apiLimitUsd = (s.apiLimitCents || 50000) / 100;
  const cursorLimitUsd = autoPct > 0 ? spend.cursorModels / (autoPct / 100) : 2000;
  const cursorLimitRounded = Math.round(cursorLimitUsd / 100) * 100;

  const models = [...by.values()]
    .map((m) => {
      const limitUsd = m.pool === 'auto' ? cursorLimitRounded : apiLimitUsd;
      const usagePct = ((m.cents / 100) / limitUsd) * 100;
      return {
        name: m.name,
        pool: m.pool,
        tokens: m.tokens,
        usagePct: +usagePct.toFixed(5),
        cents: +m.cents.toFixed(2),
        costInput: +m.costInput.toFixed(4),
        costOutput: +m.costOutput.toFixed(4),
        costCacheRead: +m.costCacheRead.toFixed(4),
        costCacheWrite: +m.costCacheWrite.toFixed(4),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const prev = [
    { name: 'grok-4.5', tokens: 513328276, usagePct: 29.09139 },
    { name: 'opus-5-high', tokens: 135194603, usagePct: 20.88841 },
    { name: 'gpt-5.6-sol-high', tokens: 85675382, usagePct: 14.7445 },
    { name: 'fable-5-xhigh', tokens: 80855260, usagePct: 30.83436 },
    { name: 'composer-2.5-fast', tokens: 61811686, usagePct: 2.56171 },
    { name: 'fable-5-high', tokens: 43121764, usagePct: 20.03478 },
    { name: 'fable-5-max', tokens: 21661443, usagePct: 8.5433 },
    { name: 'gpt-5.5-medium', tokens: 7197685, usagePct: 1.42804 },
    { name: 'opus-4.6-high', tokens: 5326616, usagePct: 1.92712 },
    { name: 'opus-4.6-max', tokens: 3334289, usagePct: 1.15461 },
    { name: 'gpt-5.6-sol-medium', tokens: 2976617, usagePct: 0.6153 },
    { name: 'default', tokens: 2613240, usagePct: 0.06455 },
  ];
  // 上次快照的 User API（不进 MODELS，更新回复仍须单独说明）
  const prevUserApi = { usd: 47.92939221858978, events: 32 };

  const rank = (arr) =>
    arr
      .filter((m) => m.usagePct >= 0.5)
      .map((m) => ({ ...m, v: m.tokens / m.usagePct }))
      .sort((a, b) => b.v - a.v)
      .map((m, i) => ({ rank: i + 1, name: m.name, v: m.v, usagePct: m.usagePct }));

  const prevRank = rank(prev);
  const currRank = rank(models);
  const usageDeltas = models
    .map((m) => {
      const p = prev.find((x) => x.name === m.name);
      if (!p) return { name: m.name, delta: m.usagePct, from: 0, to: m.usagePct, neu: true };
      return {
        name: m.name,
        delta: m.usagePct - p.usagePct,
        from: p.usagePct,
        to: m.usagePct,
        neu: false,
      };
    })
    .filter((x) => Math.abs(x.delta) >= 0.05)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const rankChanges = [];
  for (const x of currRank) {
    const o = prevRank.find((y) => y.name === x.name);
    if (!o) rankChanges.push(`${x.name}: 新进 #${x.rank}`);
    else if (o.rank !== x.rank) rankChanges.push(`${x.name}: #${o.rank} → #${x.rank}`);
  }
  for (const o of prevRank) {
    if (!currRank.find((x) => x.name === o.name)) {
      rankChanges.push(`${o.name}: 离开排名（原 #${o.rank}）`);
    }
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const updatedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const lit = models
    .map(
      (m) =>
        `  { name: "${m.name}", pool: "${m.pool}", tokens: ${m.tokens}, usagePct: ${m.usagePct}, cents: ${m.cents}, costInput: ${m.costInput}, costOutput: ${m.costOutput}, costCacheRead: ${m.costCacheRead}, costCacheWrite: ${m.costCacheWrite} },`,
    )
    .join('\n');

  const summary = {
    updatedAt,
    eventCount: all.length,
    total,
    spend,
    apiLimitUsd,
    cursorLimitRounded,
    autoPctOfficial: autoPct,
    apiPctOfficial: period.planUsage?.apiPercentUsed ?? s.apiUsedPercent,
    usageDeltas,
    userApiDelta: {
      events: spend.userApiEvents - prevUserApi.events,
      usd: spend.userApi - prevUserApi.usd,
      fromEvents: prevUserApi.events,
      toEvents: spend.userApiEvents,
      fromUsd: prevUserApi.usd,
      toUsd: spend.userApi,
    },
    prevRank: prevRank.map((x) => `${x.rank}.${x.name}`),
    currRank: currRank.map((x) => `${x.rank}.${x.name}`),
    rankChanges,
    models,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n// MODELS\n' + lit);

  // 写回 empty-window canvas（脚本此前只打印，不写文件会导致看板不更新）
  const fs = require('fs');
  const canvasPath =
    process.env.MODEL_VALUE_CANVAS ||
    '/home/ai-group/.cursor/projects/empty-window/canvases/cursor-model-value.canvas.tsx';
  if (fs.existsSync(canvasPath)) {
    let src = fs.readFileSync(canvasPath, 'utf8');
    const fmt = (iso) => {
      const d = new Date(iso);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const cycle = `${fmt(s.billingCycleStart)} – ${fmt(s.billingCycleEnd)}`;
    const modelsForCanvas = models.filter((m) => m.tokens > 0 || m.cents > 0);
    const modelsLit = modelsForCanvas
      .map(
        (m) =>
          `  { name: "${m.name}", pool: "${m.pool}", tokens: ${m.tokens}, usagePct: ${m.usagePct}, cents: ${m.cents}, costInput: ${m.costInput}, costOutput: ${m.costOutput}, costCacheRead: ${m.costCacheRead}, costCacheWrite: ${m.costCacheWrite} },`,
      )
      .join('\n');
    src = src.replace(
      /const META = \{[\s\S]*?\n\};/,
      `const META = {\n  cycle: "${cycle}",\n  updatedAt: "${updatedAt}",\n  source: "usage-events · 官方 $/M 定价分摊",\n};`,
    );
    src = src.replace(
      /const USAGE_SPEND_USD = \{[\s\S]*?\n\};/,
      `const USAGE_SPEND_USD = {\n  api: ${spend.api},\n  cursorModels: ${spend.cursorModels},\n  userApi: ${spend.userApi},\n  userApiEvents: ${spend.userApiEvents},\n  fallbackEvents: ${spend.fallbackEvents},\n};`,
    );
    src = src.replace(
      /const POOL_LIMIT_USD = \{[\s\S]*?\} as const;/,
      `const POOL_LIMIT_USD = {\n  api: ${apiLimitUsd},\n  cursorModels: ${cursorLimitRounded},\n  // User API 无池上限，环心只展示金额\n} as const;`,
    );
    src = src.replace(
      /const MODELS: ModelRow\[\] = \[[\s\S]*?\];/,
      `const MODELS: ModelRow[] = [\n${modelsLit}\n];`,
    );
    fs.writeFileSync(canvasPath, src);
    console.log('\n// WROTE_CANVAS', canvasPath);
  } else {
    console.log('\n// SKIP_CANVAS missing', canvasPath);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
