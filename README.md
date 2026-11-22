# 皮具 & 乳胶制品竞品监控大屏

基于 Node.js 20（20.18.1 起）、Express、TypeScript、Prisma/SQLite、Playwright、node-cron、React 18、Vite、Tailwind CSS 和 ECharts 的竞品监控系统。新部署默认使用空数据库，可在「竞品管理」添加站点，也可导入自己的名单。

## 安装与启动

```bash
npm ci
npm ci --prefix client
cp .env.example .env   # Windows PowerShell 可用 Copy-Item .env.example .env
npx playwright install chromium
npx prisma generate --schema server/prisma/schema.prisma
npm run dev
```

开发环境的前端在 `http://localhost:5173/dashboard`，后端在 `http://localhost:4000`。执行 `npm run build` 后，用 `npm start` 启动生产构建，浏览器访问 `http://localhost:4000/dashboard`。复制 `.env` 后也可运行 `docker compose up --build`，访问同一地址，SQLite 数据保存在 Docker 命名卷中。

可选的批量导入读取项目根目录下自备的 `competitors.json`。顶层对象包含 `competitors` 数组，每项填写 `name`、`group`（`leather` 或 `latex`）、`url`、`country` 和 `socials`（平台名到账号链接的映射）。启动时按名称和 URL 新增记录，保留已存在的记录。Docker 部署可通过界面录入，或在容器启动后执行 `docker compose cp competitors.json monitor:/app/competitors.json`，再运行 `docker compose restart monitor`。

## 环境变量

复制 `.env.example` 为 `.env`。流量数据使用 DataForSEO Traffic Analytics API：填写 `DATAFORSEO_LOGIN`、`DATAFORSEO_PASSWORD`，sandbox 默认开启（`DATAFORSEO_SANDBOX=true`）；生产环境改为 `false`。可选的 Semrush 标准 SEO API 作为第二个数据源：填写 `SEMRUSH_API_KEY`（`SEMRUSH_DATABASE` 默认 `us`，`SEMRUSH_UNIT_BUDGET` 默认 48000 units，`DATA_PROVIDER` 默认 `auto`），Semrush 国内可直连、不经过代理；关键词页默认优先展示 Semrush 数据，没有 Semrush 数据的竞品回退到 DataForSEO。`DEMO_MODE=true` 时 bulk traffic、by country、by source 会使用演示数据，无 Key 也能完整体验。YouTube 使用 `YOUTUBE_API_KEY` 调 Data API v3；技术栈使用 `wappalyzer-wrapper` npm 规则库；广告情报通过 Playwright 抓取 Facebook Ad Library 公开搜索页，不需要 Meta API 审核。`HTTPS_PROXY` 可选，支持 `http://127.0.0.1:7892` 和 `socks5://127.0.0.1:7892`，同时作用于 Node HTTP 请求与 Playwright。数据库默认 `file:./dev.db`。

### 代理可用性自动回退

并非所有任务都需要代理：网站抓取、SEO 审计、技术栈检测、DataForSEO、Semrush 的目标站点在国内通常可直连；只有 YouTube、Instagram、Facebook、Meta 广告需要代理。为避免代理未开启时整批任务失败，服务在发起 Playwright 抓取前会对 `HTTPS_PROXY` 做一次 TCP 探测（约 1.2 秒）：

- 代理可达 → 继续走代理；
- 代理不可达 → 打印一条中文警告并**自动回退直连**，抓取/审计任务照常完成；
- DataForSEO 请求在网络层失败时同样会回退到直连客户端重试一次（服务端已有响应时不回退，例如 40200 余额不足）。

因此「社交类任务」仍需代理，其余任务不再因为忘记开代理而整体失败。

## 调度与抓取

服务启动控制台会打印任务注册表：网站抓取每 6 小时，社媒每天 02:00，流量每月 1 日 04:00，外链每月 1 日 04:30，关键词每月 1 日 05:00，技术栈/广告每周日 05:00，SEO 每周日 05:30。流量任务会将 33 个域名批量请求 DataForSEO Labs 接口，保存月访问量、国家分布和渠道构成，并删除超过 12 个月的历史。外链任务调用 DataForSEO Backlinks 的 summary、referring_domains、anchors，保存外链总数、引用域、dofollow 比例、rank、质量分档、Top 引用域和锚文本；三个请求未全部成功时不会覆盖旧数据。关键词任务调用 ranked_keywords 和组内前三高流量竞品的 domain_intersection，保存搜索量、排名、排名 URL、ETV 和机会词；DataForSEO 余额不足或接口失败时保留历史不写假数据。SEO 任务使用带代理的 Playwright + cheerio 审计首页、类目页和产品页，同时提取 JSON-LD 写入 SchemaSnapshot。收入预估完全本地计算，使用最新搜索流量、价格快照中位数和可切换转化率，界面明确标记为估算值。Playwright 使用随机 UA、仿真 Headers、Cookie 持久化、自动滚动和 3-8 秒等待；失败会写入日志并继续其他竞品。真实环境建议在允许抓取的站点上运行，并遵守 robots.txt、站点条款及验证码策略。

## 路由

- `/dashboard`：Leather/Latex 分组卡片、SKU、价格区间、72h 动态、社媒粉丝
- `/competitors`：后续增删竞品
- `/alerts`：24h/72h/7d 变化时间线
- `/traffic`：12 个月访问量趋势与渠道
- `/social`：平台粉丝快照与最近更新时间
- `/backlinks`：外链总数、引用域、rank、dofollow、质量分档、Top 引用域和锚文本
- `/seo`：SEO 总分排行榜、8 维度得分、雷达图、逐页检查和改进建议
- `/keywords`：排名关键词、产品词/品牌词/长尾词布局和组内机会词
- `/revenue`：基于流量、转化率和客单价的收入估算（仅供横向对比）
- `/schema`：首页与产品页 JSON-LD 类型矩阵、Product 字段完整度
- `/outreach`：外链机会筛选、Google Sheets 同步、状态流转、邮件草稿与掉链追踪

### 外链机会与 Google Sheets

在 `.env` 配置 `MAIN_SITE_DOMAIN`、`MAIN_KEYWORDS`、`OUTREACH_MIN_DR`、`OUTREACH_DOFOLLOW_ONLY` 和可选的 `OUTREACH_SPAM_WORDS`。手动执行 `POST /api/outreach/collect?limit=3`，任务会聚合 DataForSEO referring_domains，排除主站已有引用域，并按 rank、dofollow、关键词相关性和引用竞品数评分。任务只写真实 API 返回值；DataForSEO 余额或网络错误会保留旧数据。

配置 `GOOGLE_SHEETS_WEBAPP_URL` 后，点击 `/outreach` 的“同步 Sheets”，或调用 `POST /api/outreach/sync-sheets`。同步失败会指数退避重试 3 次，并在页面状态卡中显示错误。外联状态为 `new → qualified → synced → contacted → replied → placed → dead`，系统不会自动向第三方网站发帖或发布链接。状态置为 `placed` 后，每周日 06:00 检查来源页是否仍包含指向 `MAIN_SITE_DOMAIN` 的链接。

Apps Script 部署：新建 Google Sheet，打开“扩展程序 → Apps Script”，粘贴以下完整代码，将脚本部署为 Web App（执行身份选择自己，访问权限按你的账号策略设置），把部署后的 URL 填入 `.env` 的 `GOOGLE_SHEETS_WEBAPP_URL`。

```javascript
const SHEET_NAME = 'Outreach';
const HEADERS = ['domain','urlFrom','anchor','dr','dofollow','competitors','keywords','qualityScore','tier','suggestedType','status','firstSeen','note'];

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ok:true, sheet:SHEET_NAME}))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const rows = JSON.parse(e.postData && e.postData.contents || '[]');
    if (!Array.isArray(rows)) throw new Error('payload must be an array');
    const sheet = getSheet_();
    const values = rows.map(row => HEADERS.map(key => {
      const value = row[key];
      return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : (value == null ? '' : value);
    }));
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).clearContent();
    if (values.length) sheet.getRange(2, 1, values.length, HEADERS.length).setValues(values);
    return json_({ok:true, rows:values.length});
  } catch (error) {
    return json_({ok:false, error:String(error)});
  }
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  return sheet;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
```

## 验证清单

1. 启动日志出现 `Scheduled jobs` 九项任务（包含外链机会挖掘和已挂载链接检查），且 API `/api/health` 返回 `ok:true`。
2. 本地默认创建 `server/prisma/dev.db`。空库的 `/api/competitors` 返回 `[]`。如提供自己的导入文件，检查已导入的竞品，并确认重启后已有记录保留。
3. 打开 `/dashboard`，切换 Leather/Latex，确认卡片和“演示数据”标识；页面每 30 秒轮询。
4. 在 `/competitors` 添加一条测试竞品，再删除，确认数据库增删可用。
5. 在 `/alerts` 切换 24h/72h/7d，确认变化记录时间范围过滤。
6. 在 `/traffic` 看到月度访问量折线和渠道标签，在 `/social` 看到平台快照。
7. 配置 DataForSEO 凭证后关闭 `DEMO_MODE`，等待流量 cron 或手动调用 `collectTraffic()`，确认日志出现 `DataForSEO traffic saved`，并检查三类响应写入 `TrafficSnapshot`。如果供应商返回任务级错误（例如 `40402 Invalid Path`），系统会记录原因并保留已有历史，不会写入 0 值。
8. 配置 `YOUTUBE_API_KEY` 后运行社媒任务，检查 YouTube 快照中的订阅数、总播放量和近 30 天视频数；Instagram/Facebook 使用公开 meta description 和页面文本，TikTok 使用 `data-e2e="followers-count"`，Pinterest 使用页面 JSON 的 `follower_count`，X 无法公开读取时保持 `unavailable`。
9. 运行周任务，检查 `TechSnapshot` 出现 Wappalyzer 检测标签和 `AdSnapshot` 出现公开广告摘要、非零广告数量及 `status=ok`；若 Facebook 返回登录/反爬页，记录 `status=unavailable`，不写模板文本。
10. 执行 `POST /api/collect/backlinks?limit=2`，检查任务状态结束后 `/api/backlinks` 有两条当月快照；若 DataForSEO 或代理失败，日志显示原因且旧数据不被覆盖。
11. 执行 `POST /api/collect/seo?limit=2`，检查任务状态结束后 `/api/seo` 有报告，打开 `/seo` 查看排行榜、雷达图、优秀项、问题建议和逐页明细。
12. 代理可用时执行 `POST /api/collect/seo?limit=2`，检查 `/api/schema?group=leather` 返回首页/产品页快照，打开 `/schema` 查看矩阵。
13. 打开 `/revenue` 切换转化率，确认收入排行榜和卡片联动变化，并确认页面标注“估算值，仅供横向对比”。
14. DataForSEO 余额充足且代理可用时执行 `POST /api/collect/keywords?limit=1`，检查 `/api/keywords` 的排名关键词和机会词；40200 或网络错误应出现在任务状态并保留历史。
15. Semrush：在 `.env` 填写 `SEMRUSH_API_KEY`（`SEMRUSH_DATABASE=us`、`SEMRUSH_UNIT_BUDGET=48000`），重启后访问 `/api/semrush/balance`（或 `/api/semrush/status`）确认 Key 有效和实际余额；余额查询免费，不会扣 units。Key 未配置/失效时接口返回 `error`，任务保留已有数据且不写演示值。
16. Semrush 手动采集接口为 `POST /api/collect/semrush/keywords?limit=1`、`POST /api/collect/semrush/traffic?limit=1`、`POST /api/collect/semrush/backlinks?limit=1`，也可附加 `competitorIds=1,2,3` 精确选择竞品；旧的 `semrushKeywords`、`semrushTraffic`、`semrushBacklinks` 路径仍兼容。配额按自然词 10/行、付费词 20/行、流量 10/行、反链总览 40/行累计，调用间隔 200ms。余额不足时关键词 P0 自动降到 50 行，P1/P3 会按预算跳过；日志会打印 `已消耗 X units，剩余 Y，停止采集`，ERROR 132 或认证错误不会覆盖历史。
17. 打开 `/keywords` 切换「自然关键词/付费关键词」Tab，打开 `/traffic` 用「Semrush / DataForSEO」按钮对比同一月份的两个口径；两个数据源的数据在库中并存（`source` 字段区分），Semrush 反链只有总量指标，引用域与锚文本明细仍由 DataForSEO 提供。
18. 配置 `MAIN_SITE_DOMAIN` 后执行 `POST /api/outreach/collect?limit=3`，检查 `/api/outreach` 返回域名、质量分、分级、引用竞品和 `excludeReason`；DataForSEO 余额不足时任务状态记录错误且不写演示值。
19. 未配置 `GOOGLE_SHEETS_WEBAPP_URL` 时调用 `POST /api/outreach/sync-sheets`，应返回中文错误而不崩溃；配置 Apps Script URL 后点击同步，页面显示最后同步时间和行数。
20. 在 `/outreach` 将机会切换为 `placed`，确认自动生成存活记录；调用 `POST /api/outreach/check-links` 或等待周日 06:00 任务，掉链记录变为 `dead` 并在统计卡告警。
