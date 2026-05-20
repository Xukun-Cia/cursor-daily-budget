# Cursor Daily Budget

Cursor / VS Code 状态栏扩展：自动拉取 Cursor 订阅用量，按**中国法定工作日**（9:00–20:00 连续折算）计算 API 每日预算，并在状态栏实时展示。

## 功能

状态栏从左到右四项：

| 项 | 示例 | 说明 |
|---|---|---|
| 剩余工作日 | `10.52 day` | 到重置日前的 fractional 工作日 |
| API 用量 | `API 44.99%` | 本计费周期 API 池已用百分比 |
| 今日用量 | `今日 2.81%` | 当日 9:00 → 次日 9:00 的 API 消耗（占 $500 池） |
| 日估 | `日估 5.23%/d` | 剩余 API 额度 ÷ 剩余工作日 |

悬停可查看额度金额、计费周期、Auto 用量等详情。

### 自动抓取

- 从 Cursor 本地登录态读取 token，调用非官方 Dashboard API
- 主接口：`GET cursor.com/api/usage-summary`（Ultra 等按用量计费计划）
- 备用：`api2.cursor.sh` Connect RPC
- 今日 API 用量：按 usage events 汇总，排除 Composer/Auto 模型

### 工作日计算

- 内置中国法定节假日与调休数据（`lib/holidays.json`）
- 工作时段 9:00–20:00，按秒连续折算剩余工作日

## 安装

```bash
git clone https://github.com/Xukun-Cia/cursor-daily-budget.git
cd cursor-daily-budget
bash install.sh
```

然后在 Cursor 中执行 **Developer: Reload Window**。

`install.sh` 会将扩展同步到 `~/.cursor/extensions/local.cursor-daily-budget-<version>/`。

## 配置

在 Cursor 设置中搜索 `cursorBudget`：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `cursorBudget.refreshIntervalSeconds` | `60` | 自动刷新间隔（秒） |
| `cursorBudget.showInStatusBar` | `true` | 是否显示状态栏 |
| `cursorBudget.warningThresholdPercent` | `80` | 警告阈值 |
| `cursorBudget.criticalThresholdPercent` | `95` | 严重警告阈值 |

## 命令

- `Cursor Budget: Refresh` — 立即刷新
- `Cursor Budget: Menu` — 快捷菜单（刷新间隔、打开 Dashboard）
- `Cursor Budget: Open Dashboard` — 打开 cursor.com/dashboard/usage

## 要求

- Cursor 或 VS Code ≥ 1.85
- 已登录 Cursor 账号
- 系统需有 `python3`（用于读取本地 SQLite 中的 auth token）

## 目录结构

```
cursor-daily-budget/
├── extension.js          # 扩展入口
├── package.json
├── install.sh            # 安装到 ~/.cursor/extensions/
├── lib/
│   ├── cursorApi.js      # Token 读取 & API 请求
│   ├── usageDetails.js   # 用量解析 & 悬停文案
│   ├── workdays.js       # 工作日 / 日估计算
│   └── holidays.json     # 节假日数据
└── budget.py             # 可选：终端版（独立脚本）
```

## 免责声明

本扩展使用 Cursor Dashboard 的**非公开 API**，可能随 Cursor 更新而失效。仅供个人使用，与 Cursor 官方无关。

## License

MIT
