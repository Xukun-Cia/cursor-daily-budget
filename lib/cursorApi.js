const { execSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getApiDayWindow, formatDate, parseResetInstant } = require('./workdays');
const {
  parseUsageSummaryRich,
  applyPoolLimits,
  computeTodayApiUsage,
  DEFAULT_AUTO_BUCKET_MODELS,
} = require('./usageDetails');

const MAX_EVENT_PAGES = 5;
const EVENTS_PAGE_SIZE = 100;

function getStateDbPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function getLogPath() {
  const logDir = path.join(os.homedir(), '.cursor', 'budget-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return path.join(logDir, 'api-response.json');
}

function logApiResponse(payload) {
  try {
    fs.writeFileSync(
      getLogPath(),
      JSON.stringify({ timestamp: new Date().toISOString(), ...payload }, null, 2),
      'utf-8',
    );
  } catch (_) {
    // best effort
  }
}

function readTokenFromDb() {
  const dbPath = getStateDbPath();
  const script = `
import sqlite3, json, base64, sys
try:
    conn = sqlite3.connect("${dbPath.replace(/\\/g, '\\\\')}")
    cur = conn.cursor()
    cur.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
    row = cur.fetchone()
    if not row:
        print(json.dumps({"error": "no_token"}))
        sys.exit(0)
    raw = row[0]
    parts = raw.split('.')
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=='))
    user_id = payload['sub'].split('|')[1]
    session = user_id + '%3A%3A' + raw
    print(json.dumps({"userId": user_id, "sessionToken": session, "accessToken": raw}))
    conn.close()
except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();

  try {
    const result = execSync(`python3 -c '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return JSON.parse(result.trim());
  } catch (err) {
    return { error: `Failed to read token: ${err.message}` };
  }
}

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function buildCookieHeaders(sessionToken) {
  return {
    Cookie: `WorkosCursorSessionToken=${sessionToken}`,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard/usage',
    Accept: 'application/json',
  };
}

function buildBearerHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    Accept: 'application/json',
  };
}

async function fetchUsageSummary(sessionToken) {
  return httpsRequest('https://cursor.com/api/usage-summary', {
    headers: buildCookieHeaders(sessionToken),
  });
}

async function fetchStripe(sessionToken) {
  return httpsRequest('https://cursor.com/api/auth/stripe', {
    headers: buildCookieHeaders(sessionToken),
  });
}

async function fetchUsageEventsPage(sessionToken, body) {
  return httpsRequest('https://cursor.com/api/dashboard/get-filtered-usage-events', {
    method: 'POST',
    headers: buildCookieHeaders(sessionToken),
    body: JSON.stringify(body),
  });
}

async function fetchEventsInRange(sessionToken, startMs, endMs) {
  const allEvents = [];

  for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
    const resp = await fetchUsageEventsPage(sessionToken, {
      startDate: String(startMs),
      endDate: String(endMs),
      page,
      pageSize: EVENTS_PAGE_SIZE,
    });

    const batch = resp.usageEventsDisplay || [];
    allEvents.push(...batch);

    const total = resp.totalUsageEventsCount || 0;
    if (batch.length < EVENTS_PAGE_SIZE || allEvents.length >= total) {
      break;
    }
  }

  return allEvents;
}

async function fetchConnectPeriodUsage(accessToken) {
  return httpsRequest(
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    {
      method: 'POST',
      headers: buildBearerHeaders(accessToken),
      body: '{}',
    },
  );
}

/**
 * Fetch usage summary, today's API spend (9:00→9:00), and billing metadata.
 */
async function fetchUsageData(sessionToken, userId, accessToken) {
  const errors = [];
  let stripe = null;
  let summaryRaw = null;
  let summary = null;
  let usageSource = null;
  let autoBucketModels = DEFAULT_AUTO_BUCKET_MODELS;
  let todayApiUsage = null;

  try {
    stripe = await fetchStripe(sessionToken);
  } catch (err) {
    errors.push(`stripe: ${err.message}`);
  }

  try {
    summaryRaw = await fetchUsageSummary(sessionToken);
    summary = parseUsageSummaryRich(summaryRaw);
    if (summary?.apiUsedPercent !== null) {
      usageSource = 'usage-summary';
    }
  } catch (err) {
    errors.push(`usage-summary: ${err.message}`);
  }

  let connect = null;
  if (accessToken) {
    try {
      connect = await fetchConnectPeriodUsage(accessToken);
      if (Array.isArray(connect.autoBucketModels) && connect.autoBucketModels.length > 0) {
        autoBucketModels = connect.autoBucketModels;
      }
      if (!summary?.apiUsedPercent) {
        const plan = connect.planUsage || {};
        if (typeof plan.apiPercentUsed === 'number') {
          summary = summary || {};
          summary.apiUsedPercent = plan.apiPercentUsed;
          summary.autoPercentUsed = summary.autoPercentUsed ?? plan.autoPercentUsed;
          summary.totalPercentUsed = summary.totalPercentUsed ?? plan.totalPercentUsed;
          if (!summary.resetDate && connect.billingCycleEnd) {
            summary.billingCycleEnd = connect.billingCycleEnd;
            const end = parseResetInstant(connect.billingCycleEnd);
            if (end) summary.resetDate = formatDate(end);
          }
          usageSource = 'connect-rpc';
        }
      }
    } catch (err) {
      errors.push(`connect-rpc: ${err.message}`);
    }
  }

  const membershipType =
    stripe?.membershipType
    || stripe?.individualMembershipType
    || summary?.membershipType
    || 'unknown';

  if (summary) {
    summary.membershipType = membershipType;
    applyPoolLimits(summary, membershipType);
  }

  try {
    const { start, end } = getApiDayWindow(new Date());
    const events = await fetchEventsInRange(
      sessionToken,
      start.getTime(),
      end.getTime(),
    );
    todayApiUsage = computeTodayApiUsage(
      events,
      autoBucketModels,
      summary?.apiLimitCents ?? null,
    );
    todayApiUsage.windowStart = start.toISOString();
    todayApiUsage.windowEnd = end.toISOString();
  } catch (err) {
    errors.push(`today-usage: ${err.message}`);
  }

  logApiResponse({
    source: usageSource,
    summary: summaryRaw,
    stripe,
    todayApiUsage,
    result: summary,
  });

  return {
    membershipType,
    apiUsedPercent: summary?.apiUsedPercent ?? null,
    resetDate: summary?.resetDate ?? null,
    summary,
    todayApiUsage,
    usageSource,
    fetchErrors: errors,
    raw: summaryRaw,
  };
}

module.exports = {
  readTokenFromDb,
  fetchUsageData,
  parseUsageSummaryRich,
};
