#!/usr/bin/env python3
"""
Cursor Daily Budget — 终端版
每分钟刷新，显示到 Plan 重置日前每个工作日的 API/Composer 可用额度。
用法:
    python3 budget.py                       # 交互式，首次运行会提示输入
    python3 budget.py --api 3 --comp 1      # 直接指定用量百分比
    python3 budget.py --reset 2026-05-04    # 手动指定重置日
"""

import argparse
import base64
import json
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, date, timedelta
from pathlib import Path

HOLIDAYS_DATA = {
    "2025": {
        "holidays": [
            "2025-01-01",
            "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
            "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
            "2025-04-04", "2025-04-05", "2025-04-06",
            "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
            "2025-05-31", "2025-06-01", "2025-06-02",
            "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
            "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
        ],
        "workdays": [
            "2025-01-26", "2025-02-08", "2025-04-27",
            "2025-09-28", "2025-10-11",
        ],
    },
    "2026": {
        "holidays": [
            "2026-01-01", "2026-01-02", "2026-01-03",
            "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18",
            "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
            "2026-04-04", "2026-04-05", "2026-04-06",
            "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
            "2026-06-19", "2026-06-20", "2026-06-21",
            "2026-09-25", "2026-09-26", "2026-09-27",
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
            "2026-10-05", "2026-10-06", "2026-10-07",
        ],
        "workdays": [
            "2026-01-04", "2026-02-14", "2026-02-28",
            "2026-05-09", "2026-09-20", "2026-10-10",
        ],
    },
}

# ─── Chinese workday logic ───────────────────────────────────────────

def is_workday(d: date) -> bool:
    ds = d.isoformat()
    year_data = HOLIDAYS_DATA.get(str(d.year))
    if year_data:
        if ds in year_data["holidays"]:
            return False
        if ds in year_data["workdays"]:
            return True
    return d.weekday() < 5  # Mon-Fri

def count_workdays(start: date, end: date, include_start=True) -> int:
    count = 0
    cur = start if include_start else start + timedelta(days=1)
    while cur < end:
        if is_workday(cur):
            count += 1
        cur += timedelta(days=1)
    return count

# ─── Cursor API ──────────────────────────────────────────────────────

def get_state_db_path() -> str:
    home = Path.home()
    if sys.platform == "darwin":
        return str(home / "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    elif sys.platform == "win32":
        return str(home / "AppData/Roaming/Cursor/User/globalStorage/state.vscdb")
    return str(home / ".config/Cursor/User/globalStorage/state.vscdb")

def read_token():
    db_path = get_state_db_path()
    if not os.path.exists(db_path):
        return None, None, "state.vscdb not found"

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
    row = cur.fetchone()
    conn.close()

    if not row:
        return None, None, "No access token in DB"

    raw_token = row[0]
    parts = raw_token.split(".")
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
    user_id = payload["sub"].split("|")[1]
    session_token = f"{user_id}%3A%3A{raw_token}"
    return user_id, session_token, None

def fetch_cursor_usage(session_token, user_id):
    headers = {
        "Cookie": f"WorkosCursorSessionToken={session_token}",
        "User-Agent": "Mozilla/5.0",
        "Origin": "https://cursor.com",
        "Referer": "https://cursor.com/settings",
    }

    req = urllib.request.Request(f"https://cursor.com/api/usage?user={user_id}")
    for k, v in headers.items():
        req.add_header(k, v)
    resp = urllib.request.urlopen(req, timeout=15)
    usage = json.loads(resp.read().decode())

    req2 = urllib.request.Request("https://cursor.com/api/auth/stripe")
    for k, v in headers.items():
        req2.add_header(k, v)
    resp2 = urllib.request.urlopen(req2, timeout=15)
    stripe = json.loads(resp2.read().decode())

    start_of_month = usage.get("startOfMonth")
    reset_date = None
    if start_of_month:
        start = datetime.fromisoformat(start_of_month.replace("Z", "+00:00"))
        month = start.month + 1
        year = start.year
        if month > 12:
            month = 1
            year += 1
        reset_date = f"{year}-{month:02d}-{start.day:02d}"

    gpt4 = usage.get("gpt-4", {})
    api_pct = None
    if gpt4.get("maxRequestUsage") and gpt4["maxRequestUsage"] > 0:
        api_pct = (gpt4["numRequests"] / gpt4["maxRequestUsage"]) * 100

    return {
        "membership": stripe.get("membershipType", "unknown"),
        "reset_date": reset_date,
        "api_pct": api_pct,
    }

# ─── Display ─────────────────────────────────────────────────────────

BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
RED = "\033[31m"
RESET = "\033[0m"
CLEAR = "\033[2J\033[H"

def color_budget(value):
    if value >= 8:
        return GREEN
    elif value >= 4:
        return YELLOW
    return RED

def render(api_pct, comp_pct, reset_date_str, membership, error_msg=None):
    today = date.today()
    reset = date.fromisoformat(reset_date_str)
    remaining_days = count_workdays(today, reset, include_start=True)

    api_remain = max(0, 100 - api_pct) if api_pct is not None else None
    comp_remain = max(0, 100 - comp_pct) if comp_pct is not None else None
    api_daily = (api_remain / remaining_days) if api_remain is not None and remaining_days > 0 else None
    comp_daily = (comp_remain / remaining_days) if comp_remain is not None and remaining_days > 0 else None

    now_str = datetime.now().strftime("%H:%M:%S")

    lines = [
        CLEAR,
        f"{BOLD}╔══════════════════════════════════════════════════╗{RESET}",
        f"{BOLD}║         Cursor Daily Budget  ({DIM}{now_str}{RESET}{BOLD})         ║{RESET}",
        f"{BOLD}╠══════════════════════════════════════════════════╣{RESET}",
        f"{BOLD}║{RESET}  Plan:          {CYAN}{membership:32s}{RESET}{BOLD}║{RESET}",
        f"{BOLD}║{RESET}  重置日:        {CYAN}{reset_date_str:32s}{RESET}{BOLD}║{RESET}",
        f"{BOLD}║{RESET}  剩余工作日:    {CYAN}{str(remaining_days) + ' 天':32s}{RESET}{BOLD}║{RESET}",
        f"{BOLD}╠══════════════════════════════════════════════════╣{RESET}",
    ]

    if api_pct is not None:
        c = color_budget(api_daily or 0)
        bar_len = int(api_pct / 100 * 30)
        bar = "█" * bar_len + "░" * (30 - bar_len)
        lines += [
            f"{BOLD}║{RESET}  {BOLD}[API]{RESET}",
            f"{BOLD}║{RESET}    已用: {api_pct:5.1f}%  [{bar}]",
            f"{BOLD}║{RESET}    剩余: {api_remain:5.1f}%",
            f"{BOLD}║{RESET}    每日: {c}{BOLD}{api_daily:5.2f}%/天{RESET}",
            f"{BOLD}║{RESET}",
        ]
    else:
        lines.append(f"{BOLD}║{RESET}  {DIM}[API] 未配置 (--api X){RESET}")

    if comp_pct is not None:
        c = color_budget(comp_daily or 0)
        bar_len = int(comp_pct / 100 * 30)
        bar = "█" * bar_len + "░" * (30 - bar_len)
        lines += [
            f"{BOLD}║{RESET}  {BOLD}[Composer+AUTO]{RESET}",
            f"{BOLD}║{RESET}    已用: {comp_pct:5.1f}%  [{bar}]",
            f"{BOLD}║{RESET}    剩余: {comp_remain:5.1f}%",
            f"{BOLD}║{RESET}    每日: {c}{BOLD}{comp_daily:5.2f}%/天{RESET}",
            f"{BOLD}║{RESET}",
        ]
    else:
        lines.append(f"{BOLD}║{RESET}  {DIM}[Composer+AUTO] 未配置 (--comp X){RESET}")

    lines.append(f"{BOLD}╚══════════════════════════════════════════════════╝{RESET}")

    if error_msg:
        lines.append(f"\n{YELLOW}⚠ {error_msg}{RESET}")

    lines.append(f"\n{DIM}每 60 秒自动刷新 | Ctrl+C 退出{RESET}")

    print("\n".join(lines))

# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Cursor Daily Budget — 计算每日用量预算")
    parser.add_argument("--api", type=float, default=None, help="当前 API 已用百分比 (0-100)")
    parser.add_argument("--comp", type=float, default=None, help="当前 Composer+AUTO 已用百分比 (0-100)")
    parser.add_argument("--reset", type=str, default=None, help="重置日期 YYYY-MM-DD")
    parser.add_argument("--once", action="store_true", help="只显示一次，不循环刷新")
    args = parser.parse_args()

    user_id, session_token, token_err = read_token()
    reset_date = args.reset
    membership = "unknown"
    api_pct = args.api
    comp_pct = args.comp
    fetch_err = None

    if session_token:
        try:
            result = fetch_cursor_usage(session_token, user_id)
            membership = result["membership"]
            if not reset_date and result["reset_date"]:
                reset_date = result["reset_date"]
            if api_pct is None and result["api_pct"] is not None:
                api_pct = result["api_pct"]
        except Exception as e:
            fetch_err = str(e)
    elif token_err:
        fetch_err = token_err

    if not reset_date:
        print(f"{RED}错误: 无法自动获取重置日期，请使用 --reset YYYY-MM-DD 指定{RESET}")
        sys.exit(1)

    if api_pct is None and comp_pct is None:
        print(f"{YELLOW}提示: 请通过 --api X --comp Y 指定当前用量百分比{RESET}")
        print(f"{YELLOW}例如: python3 budget.py --api 3 --comp 1{RESET}")
        print()

    error_msg = fetch_err
    if token_err:
        error_msg = token_err

    try:
        while True:
            render(api_pct, comp_pct, reset_date, membership, error_msg)
            if args.once:
                break
            time.sleep(60)
    except KeyboardInterrupt:
        print(f"\n{DIM}已退出{RESET}")

if __name__ == "__main__":
    main()
