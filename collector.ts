import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, BrowserContext } from 'playwright';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from './db';
import wappalyzerWrapper from 'wappalyzer-wrapper';
import { httpsAgent, httpAgent, proxySettings, proxyReachable, proxyLabel } from './network';

const UAS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36','Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 Version/17 Safari/605.1.15'];
const delay = (ms:number) => new Promise(r => setTimeout(r, ms));
const demo = process.env.DEMO_MODE === 'true';
const dataForSeoLogin = process.env.DATAFORSEO_LOGIN;
const dataForSeoPassword = process.env.DATAFORSEO_PASSWORD;
const dataForSeoBase = process.env.DATAFORSEO_SANDBOX === 'false'
  ? 'https://api.dataforseo.com'
  : 'https://sandbox.dataforseo.com';
const trafficApi = axios.create({
  baseURL: dataForSeoBase,
  auth: dataForSeoLogin && dataForSeoPassword ? { username: dataForSeoLogin, password: dataForSeoPassword } : undefined,
  headers: { 'Content-Type': 'application/json' },
  proxy: false,
  httpAgent,
  httpsAgent,
  timeout: 60000,
});
// DataForSEO 国内可直连，代理不可用时回退到该客户端。
const trafficApiDirect = axios.create({
  baseURL: dataForSeoBase,
  auth: dataForSeoLogin && dataForSeoPassword ? { username: dataForSeoLogin, password: dataForSeoPassword } : undefined,
  headers: { 'Content-Type': 'application/json' },
  proxy: false,
  timeout: 60000,
});
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const youtubeApi = axios.create({ baseURL: 'https://www.googleapis.com/youtube/v3', proxy: false, httpAgent, httpsAgent, timeout: 30000 });

let proxyFallbackWarned = false;
async function resolveProxy() {
  if (!proxySettings) return undefined;
  if (await proxyReachable()) return proxySettings;
  if (!proxyFallbackWarned) {
    proxyFallbackWarned = true;
    console.warn(`代理 ${proxyLabel} 不可达（可能未开启），本次抓取自动回退为直连；开启代理后重启服务即可恢复。`);
  }
  return undefined;
}

async function context(): Promise<{ctx:BrowserContext; close:()=>Promise<void>}> {
  const proxy = await resolveProxy();
  const browser = await chromium.launch({ headless: true, ...(proxy ? { proxy } : {}) });
  const cookieFile = path.resolve(process.cwd(), 'server/.cookies.json');
  const ctx = await browser.newContext({ userAgent: UAS[Math.floor(Math.random()*UAS.length)], extraHTTPHeaders: { 'Accept-Language':'en-US,en;q=0.9', 'DNT':'1' }, ...(fs.existsSync(cookieFile) ? { storageState: cookieFile } : {}) });
  return { ctx, close: async () => { await ctx.storageState({ path: cookieFile }); await browser.close(); } };
}

export async function crawlCompetitor(id:number, url:string) {
  const target = url.replace(/\/$/, '');
  if (demo) return saveSnapshot(id, 'home', url, 'Demo homepage', 12, 19, 99);
  let c; try {
    c = await context(); const page = await c.ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i=0;i<3;i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await delay(400); }
    const title = await page.title(); const body = await page.locator('body').innerText().catch(()=> '');
    const imageUrl = await page.locator('meta[property="og:image"]').getAttribute('content').catch(()=>null) || undefined;
    const hash = crypto.createHash('sha1').update(body).digest('hex');
    const prices = [...body.matchAll(/(?:[$€£]\s?)(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1])).filter(Boolean);
    const sku = await page.locator('[data-product-id], .product, .product-card, article').count().catch(()=>0);
    await saveSnapshot(id,'home',url,title,sku,prices.length?Math.min(...prices):undefined,prices.length?Math.max(...prices):undefined,hash,imageUrl);
    const shopify = await page.request.get(`${target}/products.json?limit=250`).catch(()=>null);
    if (shopify?.ok()) { const json = await shopify.json(); for (const p of (json.products||[])) await saveSnapshot(id,'products',`${target}/products/${p.handle}`,p.title,1,p.variants?.[0]?.price?Number(p.variants[0].price):undefined,p.variants?.[0]?.price?Number(p.variants[0].price):undefined,undefined,p.images?.[0]?.src); }
  } catch (e:any) { await prisma.change.create({ data:{ competitorId:id, type:'NEW_PAGE', url, title:`crawl skipped: ${String(e.message||e).slice(0,120)}` } }); }
  finally { await c?.close(); }
}

async function saveSnapshot(competitorId:number,pageType:string,url:string,title:string,skuCount:number,priceMin?:number,priceMax?:number,contentHash?:string,imageUrl?:string) {
  const prev = await prisma.snapshot.findFirst({ where:{ competitorId,url }, orderBy:{ capturedAt:'desc' } });
  await prisma.snapshot.create({ data:{ competitorId,pageType,url,title,skuCount,priceMin,priceMax,contentHash } });
  if (!prev) await prisma.change.create({ data:{ competitorId,type:pageType==='products'?'NEW_PRODUCT':'NEW_PAGE',url,title,imageUrl,skuCount,price:priceMin } });
  else if (prev.title !== title) await prisma.change.create({ data:{ competitorId,type:'NEW_PAGE',url,title,imageUrl,skuCount } });
  else if (prev.priceMin !== priceMin || prev.priceMax !== priceMax) await prisma.change.create({ data:{ competitorId,type:'PRICE_CHANGE',url,title,imageUrl,skuCount,price:priceMin } });
}

const platforms = ['instagram','facebook','tiktok','x','pinterest','reddit','youtube'];
function youtubeHandle(link:string) {
  const match = link.match(/youtube\.com\/(?:@([^/?#]+)|channel\/([^/?#]+)|user\/([^/?#]+)|c\/([^/?#]+))/i);
  return match?.[1] ? { forHandle: `@${match[1]}` } : match?.[2] ? { id: match[2] } : match?.[3] ? { forUsername: match[3] } : match?.[4] ? { forHandle: `@${match[4]}` } : {};
}
function parseCountToken(raw:string) {
  const normalized=raw.replace(/,/g,'').replace(/\s+/g,'').toUpperCase(); const match=normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/); if(!match) return undefined;
  const multiplier=match[2]==='K'?1000:match[2]==='M'?1000000:match[2]==='B'?1000000000:1; const value=Number(match[1])*multiplier; return Number.isFinite(value)?Math.round(value):undefined;
}
function parseFollowers(platform:string, text:string, html:string) {
  const sources=[text,html];
  if(platform==='tiktok') {
    const exact=html.match(/data-e2e=["']followers-count["'][^>]*>([\d.,]+(?:\s*[KMB])?)/i)?.[1];
    if(exact) return parseCountToken(exact);
  }
  if(platform==='pinterest') {
    const exact=[...html.matchAll(/(?:follower_count|followerCount)["']?\s*[:=]\s*([\d.,]+)/ig)].map(match=>parseCountToken(match[1])).filter((value): value is number=>value!==undefined);
    if(exact.length) return Math.max(...exact);
  }
  for(const source of sources) {
    const after=source.match(/([\d.,]+(?:\s*[KMB])?)\s*(?:followers?|粉丝)/i)?.[1];
    const before=source.match(/(?:followers?|粉丝)\s*[:|]?\s*([\d.,]+(?:\s*[KMB])?)/i)?.[1];
    const value=parseCountToken(after||before||''); if(value!==undefined) return value;
  }
  return undefined;
}
async function collectYoutube(link:string) {
  if (!youtubeApiKey) throw new Error('YOUTUBE_API_KEY missing');
  const query = youtubeHandle(link);
  const channelResponse = await youtubeApi.get('/channels', { params: { part:'snippet,statistics', key:youtubeApiKey, ...query } });
  const channel = channelResponse.data?.items?.[0];
  if (!channel) throw new Error('YouTube channel not found');
  const publishedAfter = new Date(Date.now()-30*86400000).toISOString();
  const videos = await youtubeApi.get('/search', { params: { part:'id', channelId:channel.id, type:'video', order:'date', maxResults:50, publishedAfter, key:youtubeApiKey } });
  return { followers:Number(channel.statistics?.subscriberCount)||undefined, totalViews:Number(channel.statistics?.viewCount)||undefined, recentVideos:Number(videos.data?.pageInfo?.totalResults)||0, title:channel.snippet?.title as string|undefined };
}
export async function collectSocials(limit?: number) {
  const all = await prisma.competitor.findMany(limit ? { take: limit } : undefined);
  // One browser reused for every scrape: launching a browser per platform used to
  // cost hundreds of Chromium cold starts per run and took hours.
  let shared: Awaited<ReturnType<typeof context>> | undefined;
  const getShared = async () => (shared ??= await context());
  const pages: string[] = [];
  try {
    for (const c of all) for (const platform of platforms) {
      const link = (c.socials as Record<string,string>)[platform]; if (!link) continue;
      let followers:number|undefined; let totalViews:number|undefined; let recentVideos:number|undefined; let title:string|undefined; let status='ok';
      if (demo) followers = 1500 + c.id*127 + platform.length*80;
      else if (platform === 'youtube') { try { ({followers,totalViews,recentVideos,title}=await collectYoutube(link)); } catch (e) { status='unavailable'; console.warn(`YouTube skipped ${c.name}: ${String((e as Error).message)}`); } }
      else {
        try {
          const cc=await getShared(); const p=await cc.ctx.newPage();
          try {
            await p.goto(link,{waitUntil:'domcontentloaded',timeout:20000});
            title=await p.title();
            const text=await p.locator('body').innerText(); const html=await p.content();
            followers=parseFollowers(platform,text,html);
          } finally { await p.close(); }
        } catch (e) { status='unavailable'; console.warn(`Social skipped ${c.name}/${platform}: ${String((e as Error).message)}`); }
      }
      if (followers===undefined && status==='ok') status='unavailable';
      await prisma.socialSnapshot.create({ data:{ competitorId:c.id,platform,followers,totalViews,recentVideos,title,status } });
      pages.push(`${c.name}/${platform}=${status}${followers?`(${followers})`:''}`);
    }
  } finally { await shared?.close(); }
  console.log(`Social snapshots done: ${pages.length} rows`);
}

const normalizeDomain = (url:string) => url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
const taskResults = (payload:any): any[] => (payload?.tasks || []).flatMap((task:any) => Array.isArray(task?.result) ? task.result : []).flatMap((result:any) => Array.isArray(result?.items) ? result.items : [result]);

/**
 * Traffic data comes from the DataForSEO Labs API family.
 *
 * The previous implementation called
 *   /v3/traffic_analytics/{bulk_traffic_estimation|by_country|by_source}/live
 * which does not exist — every run died with "40402 Invalid Path" and, because
 * DEMO_MODE was off, stored nothing at all. What actually exists:
 *   POST /v3/dataforseo_labs/google/historical_bulk_traffic_estimation/live
 *        -> up to 12 months of monthly organic/paid ETV for up to 1000 targets
 *   POST /v3/dataforseo_labs/google/domain_rank_overview/live
 *        -> per country+language organic/paid ETV for one target
 *   GET  /v3/dataforseo_labs/locations_and_languages  (free, code -> country)
 *
 * Caveat worth knowing: this source only models SEARCH traffic (organic + paid
 * ETV). Direct / referral / social channel splits are not available here — only
 * Similarweb/Semrush sell those. `channels` therefore holds an organic/paid
 * split, not a full channel mix.
 */
const DEFAULT_LOCATION = process.env.DATAFORSEO_LOCATION || 'United States';
const DEFAULT_LANGUAGE = process.env.DATAFORSEO_LANGUAGE || 'en';
const monthKey = (year:number, month:number) => `${year}-${String(month).padStart(2, '0')}`;

/** 优先走已配置的客户端；若属于网络层失败（代理不可达），回退直连重试一次。 */
async function dataForSeoPost(url:string, payload:unknown) {
  try { return await trafficApi.post(url, payload); }
  catch (error:any) {
    if (error?.response) throw error; // 服务端已响应（如 40200 余额不足），无需回退
    return trafficApiDirect.post(url, payload);
  }
}

// DataForSEO 余额不足等场景会返回 HTTP 4xx，但 body 顶层 status_code 仍是 20000，
// 真实的错误码在 tasks[].status_code（如 40200）。统一从最深层提取错误信息。
function dataForSeoHttpError(prefix:string, error:any): Error {
  const data = error?.response?.data;
  const failedTask = (data?.tasks || []).find((task:any) => Number(task?.status_code) !== 20000);
  const status = failedTask?.status_code ?? data?.status_code ?? error?.response?.status ?? 'network';
  const message = failedTask?.status_message ?? data?.status_message ?? error?.message ?? 'request failed';
  return new Error(`${prefix}: ${status} ${message}`.trim());
}

async function labsLive(pathname:string, payload:unknown) {
  if (!dataForSeoLogin || !dataForSeoPassword) throw new Error('DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD missing');
  let response;
  try {
    response = await dataForSeoPost(`/v3/dataforseo_labs/${pathname}/live`, payload);
  } catch (error:any) {
    throw dataForSeoHttpError(`DataForSEO ${pathname}`, error);
  }
  if (Number(response.data?.status_code) !== 20000) throw new Error(`DataForSEO ${pathname}: ${response.data?.status_code} ${response.data?.status_message || ''}`.trim());
  const failedTask = (response.data?.tasks || []).find((task:any) => Number(task?.status_code) !== 20000);
  if (failedTask) throw new Error(`DataForSEO ${pathname}: ${failedTask.status_code} ${failedTask.status_message || ''}`.trim());
  return taskResults(response.data);
}

async function backlinksLive(pathname:string, payload:unknown) {
  if (!dataForSeoLogin || !dataForSeoPassword) throw new Error('DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD missing');
  let response;
  try {
    response = await dataForSeoPost(`/v3/backlinks/${pathname}/live`, payload);
  } catch (error:any) {
    throw dataForSeoHttpError(`DataForSEO backlinks/${pathname}`, error);
  }
  if (Number(response.data?.status_code) !== 20000) throw new Error(`DataForSEO backlinks/${pathname}: ${response.data?.status_code} ${response.data?.status_message || ''}`.trim());
  const failedTask = (response.data?.tasks || []).find((task:any) => Number(task?.status_code) !== 20000);
  if (failedTask) throw new Error(`DataForSEO backlinks/${pathname}: ${failedTask.status_code} ${failedTask.status_message || ''}`.trim());
  return taskResults(response.data);
}

type MonthTraffic = { organic:number; paid:number; keywords:number };

/** One bulk request covers every competitor and returns the full 12-month series. */
async function fetchTrafficHistory(domains:string[]) {
  const rows = await labsLive('google/historical_bulk_traffic_estimation', [{ targets: domains, location_name: DEFAULT_LOCATION, language_code: DEFAULT_LANGUAGE }]);
  const byDomain = new Map<string, Map<string, MonthTraffic>>();
  for (const row of rows) {
    const domain = normalizeDomain(String(row?.target || row?.domain || ''));
    if (!domain) continue;
    const months = byDomain.get(domain) || new Map<string, MonthTraffic>();
    for (const [kind, key] of [['organic','organic'],['paid','paid']] as const) {
      for (const point of (row?.metrics?.[kind] || [])) {
        const month = monthKey(Number(point.year), Number(point.month));
        const entry = months.get(month) || { organic:0, paid:0, keywords:0 };
        entry[key] = Number(point.etv) || 0;
        if (kind === 'organic') entry.keywords = Number(point.count) || 0;
        months.set(month, entry);
      }
    }
    byDomain.set(domain, months);
  }
  return byDomain;
}

async function fetchCountryIndex() {
  const response = await trafficApi.get('/v3/dataforseo_labs/locations_and_languages');
  const index = new Map<number, { name:string; code:string }>();
  for (const item of response.data?.tasks?.[0]?.result || []) {
    if (item?.location_type === 'Country') index.set(Number(item.location_code), { name:String(item.location_name || ''), code:String(item.country_iso_code || '') });
  }
  return index;
}

/** Search traffic split by country: sum ETV across the per-locale rows. */
async function fetchCountries(domain:string, index:Map<number,{name:string;code:string}>) {
  const rows = await labsLive('google/domain_rank_overview', [{ target: domain, limit: 1000 }]);
  const totals = new Map<number, number>();
  for (const row of rows) {
    const code = Number(row?.location_code);
    if (!code) continue;
    const etv = (Number(row?.metrics?.organic?.etv) || 0) + (Number(row?.metrics?.paid?.etv) || 0);
    totals.set(code, (totals.get(code) || 0) + etv);
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([code, etv]) => ({
    code: index.get(code)?.code || String(code),
    name: index.get(code)?.name || `#${code}`,
    etv: Math.round(etv * 100) / 100,
    share: total ? Math.round((etv / total) * 1000) / 10 : 0,
  }));
}

function demoTrafficPayload(c:any, month:string) {
  return {
    visits: 5000 + c.id * 731,
    countries: [{ country:c.country, share:42 }, { country:'US', share:21 }, { country:'GB', share:12 }],
    channels: { direct:35, organic:30, social:20, referral:10, paid:5 },
    socialSources: [{ source:'instagram', share:44 }, { source:'youtube', share:31 }, { source:'tiktok', share:25 }],
  };
}

function previousMonthRange() {
  const end = new Date(); end.setUTCDate(1); end.setUTCHours(0,0,0,0);
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth()-1);
  return { month:start.toISOString().slice(0,7), dateFrom:start.toISOString().slice(0,10), dateTo:new Date(end.getTime()-86400000).toISOString().slice(0,10) };
}

export async function collectTraffic(limit?: number, options?: { countries?: boolean }) {
  const { month } = previousMonthRange();
  const all = await prisma.competitor.findMany(limit ? { take: limit } : undefined);
  if (!all.length) return;
  const withCountries = options?.countries !== false;

  if (demo) {
    for (const c of all) {
      const payload = demoTrafficPayload(c, month);
      await prisma.trafficSnapshot.upsert({ where:{ competitorId_month_source:{ competitorId:c.id, month, source:'dataforseo' } }, update:{ ...payload, demo:true }, create:{ competitorId:c.id, month, source:'dataforseo', ...payload, demo:true } });
    }
    console.log(`Demo traffic written for ${all.length} competitors (${month})`);
    return;
  }

  const domains = [...new Set(all.map(c => normalizeDomain(c.url)))];
  const history = await fetchTrafficHistory(domains);

  let countryIndex = new Map<number, { name:string; code:string }>();
  if (withCountries) {
    try { countryIndex = await fetchCountryIndex(); }
    catch (error) { console.warn(`Country index unavailable: ${String((error as Error).message)}`); }
  }

  let rows = 0;
  const missing:string[] = [];
  for (const c of all) {
    const domain = normalizeDomain(c.url);
    const months = history.get(domain);
    if (!months || !months.size) { missing.push(domain); continue; }

    let countries:any[] = [];
    if (countryIndex.size) {
      try { countries = await fetchCountries(domain, countryIndex); }
      catch (error) { console.warn(`Countries skipped ${c.name}: ${String((error as Error).message)}`); }
    }

    for (const [monthKeyValue, entry] of months) {
      const total = entry.organic + entry.paid;
      const channels = total > 0
        ? { organic: Math.round((entry.organic / total) * 1000) / 10, paid: Math.round((entry.paid / total) * 1000) / 10 }
        : { organic: 0, paid: 0 };
      const payload:any = { visits: Math.round(total), channels, socialSources: [] as any[] };
      // Never blank out a previously stored country breakdown just because this
      // particular run failed to fetch it (rate limit, out of credit, timeout).
      if (countries.length) payload.countries = countries;
      await prisma.trafficSnapshot.upsert({
        where:{ competitorId_month_source:{ competitorId:c.id, month:monthKeyValue, source:'dataforseo' } },
        update:{ ...payload, demo:false },
        create:{ competitorId:c.id, month:monthKeyValue, source:'dataforseo', countries, ...payload, demo:false },
      });
      rows++;
    }
  }
  console.log(`DataForSEO traffic saved: ${rows} monthly rows for ${all.length - missing.length}/${all.length} competitors`);
  if (missing.length) console.warn(`No DataForSEO traffic data for: ${missing.join(', ')}`);

  const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  await prisma.trafficSnapshot.deleteMany({ where:{ capturedAt:{ lt:cutoff } } });
}

const backlinkMonth = () => new Date().toISOString().slice(0, 7);
const numberValue = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};
const optionalNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const parsed = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};
const domainFromUrl = (url:string) => normalizeDomain(url);

function demoBacklinkPayload(c:any) {
  const totalBacklinks = 120 + c.id * 37;
  const referringDomains = 18 + (c.id % 13);
  return {
    totalBacklinks, referringDomains, referringIps: Math.max(5, Math.round(referringDomains * .8)),
    dofollowRatio: 64, rank: 180 + (c.id % 8) * 37,
    qualityBreakdown: { high: { count: 3, share: 15 }, medium: { count: 10, share: 50 }, low: { count: 7, share: 35 } },
    topReferrers: [{ domain: 'example-referrer.com', rank: 240, backlinks: 12, firstSeen: null, lastSeen: null }],
    topAnchors: [{ anchor: c.name, backlinks: 18, share: 15 }],
  };
}

async function fetchBacklinkData(domain:string) {
  const summaryRows = await backlinksLive('summary', [{ target: domain, include_subdomains: true }]);
  const referringRows = await backlinksLive('referring_domains', [{ target: domain, include_subdomains: true, limit: 50, order_by: ['rank,desc'] }]);
  const anchorRows = await backlinksLive('anchors', [{ target: domain, include_subdomains: true, limit: 20, order_by: ['backlinks,desc'] }]);
  const summary:any = summaryRows[0] || {};
  const totalBacklinksValue = optionalNumber(summary.backlinks, summary.total_backlinks, summary.backlinks_count);
  const referringDomainsValue = optionalNumber(summary.referring_domains, summary.referring_domains_count);
  if (totalBacklinksValue === undefined || referringDomainsValue === undefined) throw new Error('Backlinks summary missing total_backlinks/referring_domains');
  const totalBacklinks = Math.round(totalBacklinksValue);
  const referringDomains = Math.round(referringDomainsValue);
  const referringIpsValue = optionalNumber(summary.referring_ips, summary.referring_ips_count);
  const referringIps = referringIpsValue === undefined ? undefined : Math.round(referringIpsValue);
  const dofollow = numberValue(summary.dofollow);
  const nofollow = numberValue(summary.nofollow);
  const dofollowRatio = optionalNumber(summary.dofollow_ratio, dofollow + nofollow ? (dofollow / (dofollow + nofollow)) * 100 : undefined);
  const rank = optionalNumber(summary.rank, summary.main_domain_rank, summary.domain_rank);
  const topReferrers = referringRows.map((row:any) => ({
    domain: row.domain || row.referring_domain || row.main_domain || row.target,
    rank: numberValue(row.rank, row.domain_rank),
    backlinks: Math.round(numberValue(row.backlinks, row.backlinks_count)),
    firstSeen: row.first_seen || row.firstSeen || null,
    lastSeen: row.last_seen || row.lastSeen || null,
  })).filter((row:any) => row.domain);
  const qualityCounts = { high: 0, medium: 0, low: 0 };
  for (const referrer of topReferrers) {
    if (referrer.rank > 200) qualityCounts.high++;
    else if (referrer.rank >= 50) qualityCounts.medium++;
    else qualityCounts.low++;
  }
  const qualityTotal = topReferrers.length || 1;
  const qualityBreakdown = Object.fromEntries(Object.entries(qualityCounts).map(([key, count]) => [key, { count, share: Math.round((count / qualityTotal) * 1000) / 10 }]));
  const topAnchors = anchorRows.map((row:any) => ({
    anchor: row.anchor || row.text || row.anchor_text || '(空锚文本)',
    backlinks: Math.round(numberValue(row.backlinks, row.backlinks_count)),
    share: numberValue(row.share, row.percentage, row.percent),
  }));
  return { totalBacklinks, referringDomains, referringIps, dofollowRatio, rank, qualityBreakdown, topReferrers, topAnchors };
}

export async function collectBacklinks(limit?: number) {
  const all = await prisma.competitor.findMany(limit ? { take: limit } : undefined);
  const month = backlinkMonth();
  let saved = 0;
  for (const competitor of all) {
    try {
      const payload = demo ? demoBacklinkPayload(competitor) : await fetchBacklinkData(domainFromUrl(competitor.url));
      await prisma.backlinkSnapshot.upsert({
        where: { competitorId_month_source: { competitorId: competitor.id, month, source: 'dataforseo' } },
        update: { ...payload, demo },
        create: { competitorId: competitor.id, month, source: 'dataforseo', ...payload, demo },
      });
      saved++;
    } catch (error) {
      const message = String((error as Error).message);
      const previous = await prisma.backlinkSnapshot.findUnique({ where:{ competitorId_month_source:{ competitorId:competitor.id, month, source:'dataforseo' } } });
      if (previous) await prisma.backlinkSnapshot.update({ where:{ id:previous.id }, data:{ error:message } });
      console.warn(`Backlinks skipped ${competitor.name}: ${message}`);
    }
  }
  console.log(`Backlinks saved: ${saved}/${all.length} competitors (${month})`);
  if (all.length && saved === 0 && !demo) throw new Error('No backlink snapshots saved; inspect proxy/API errors above');
}

/* External-link opportunity mining and outreach workflow. */
const outreachStatuses = ['new','qualified','synced','contacted','replied','placed','dead'] as const;
const outreachMinRank = () => Number(process.env.OUTREACH_MIN_DR || 20);
const outreachDofollowOnly = () => String(process.env.OUTREACH_DOFOLLOW_ONLY || 'true').toLowerCase() !== 'false';
const outreachSpamWords = () => (process.env.OUTREACH_SPAM_WORDS || 'casino,porn,viagra,payday,betting,gambling,loan').split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
const mainSiteDomain = () => normalizeDomain(process.env.MAIN_SITE_DOMAIN || '');
const mainKeywords = () => (process.env.MAIN_KEYWORDS || '').split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
type OutreachSource = { domain:string; urlFrom:string|null; anchor:string|null; rank:number; dofollow:boolean; backlinks:number; brokenRatio:number; raw:any };
function outreachSource(row:any): OutreachSource | null {
  const domain=normalizeDomain(String(row?.domain || row?.referring_domain || row?.main_domain || row?.target || '')); if (!domain) return null;
  const rank=optionalNumber(row?.rank,row?.domain_rank,row?.authority) || 0;
  const dofollowCount=numberValue(row?.dofollow,row?.dofollow_links,row?.dofollow_backlinks);
  const nofollowCount=numberValue(row?.nofollow,row?.nofollow_links,row?.nofollow_backlinks);
  const backlinks=numberValue(row?.backlinks,row?.backlinks_count,row?.links);
  const broken=numberValue(row?.broken_backlinks,row?.broken_links);
  return { domain, urlFrom:row?.url_from || row?.url || row?.referring_url || row?.source_url || null, anchor:row?.anchor || row?.anchor_text || row?.text || null, rank, dofollow:typeof row?.dofollow==='boolean'?row.dofollow:dofollowCount>0 || (dofollowCount===0 && nofollowCount===0 && row?.link_type==='dofollow'), backlinks, brokenRatio:backlinks>0?broken/backlinks:0, raw:row };
}
function outreachSpamReason(domain:string, anchor:string|null) { const value=`${domain} ${anchor || ''}`.toLowerCase(); const tld=/\.(xxx|porn|casino|bet|gambling|loan)(?:\.|$)/i.test(domain); const word=outreachSpamWords().find(item=>value.includes(item)); return tld?'垃圾 TLD':word?`命中垃圾词：${word}`:undefined; }
function outreachTier(score:number) { return score>=70?'high':score>=40?'medium':'low'; }
function outreachMatches(value:string,pool:string[]) { const lower=value.toLowerCase(); return pool.filter(keyword=>keyword && lower.includes(keyword)).slice(0,8); }
function suggestedOutreachType(url:string|null, brokenRatio:number) { if (brokenRatio>0) return 'broken_link'; const value=(url||'').toLowerCase(); if (/directory|list/.test(value)) return 'directory'; if (/resource|guide|blog/.test(value)) return 'resource_page'; return 'guest_post'; }
function history(value:any):any[] { return Array.isArray(value)?value:[]; }

async function outreachKeywordPools(competitors:any[]) {
  const rows=await prisma.keywordSnapshot.findMany({where:{competitorId:{in:competitors.map(item=>item.id)},type:'organic',isOpportunity:false},orderBy:[{etv:'desc'},{searchVolume:'desc'}]});
  const pools=new Map<string,string[]>();
  for(const competitor of competitors) pools.set(competitor.group,[...new Set([...(pools.get(competitor.group)||[]),...rows.filter(row=>row.competitorId===competitor.id).slice(0,20).map(row=>row.keyword.toLowerCase())])]);
  return pools;
}
async function outreachReferrers(domain:string) { return backlinksLive('referring_domains',[{target:domain,include_subdomains:true,limit:50,order_by:['rank,desc']}]); }
type BacklinkAdapter = { source:'dataforseo'|'ahrefs'; fetchReferringDomains:(domain:string)=>Promise<any[]> };
const dataForSeoBacklinkAdapter:BacklinkAdapter = { source:'dataforseo', fetchReferringDomains:outreachReferrers };
const ahrefsBacklinkAdapter:BacklinkAdapter|undefined = process.env.AHREFS_API_KEY ? {
  source:'ahrefs',
  fetchReferringDomains:async(domain:string) => {
    const response=await axios.get('https://api.ahrefs.com/v3/site-explorer/refdomains',{proxy:false,httpAgent,httpsAgent,timeout:60000,headers:{Authorization:`Bearer ${process.env.AHREFS_API_KEY}`},params:{target:domain,mode:'domain',limit:50}});
    const rows=response.data?.refdomains || response.data?.data || [];
    return rows.map((row:any)=>({...row,domain:row.domain||row.refdomain,rank:row.domain_rating??row.dr,dofollow_links:row.dofollow_links??row.dofollow,backlinks:row.backlinks??row.links}));
  },
} : undefined;
const outreachAdapter = ahrefsBacklinkAdapter || dataForSeoBacklinkAdapter;

export async function collectOutreach(limit?:number) {
  const competitors=await prisma.competitor.findMany({...(limit?{take:limit}:{}),orderBy:{id:'asc'}}); if(!competitors.length) return {saved:0,excluded:0};
  if(demo) { console.warn('DEMO_MODE 下跳过外链机会挖掘，不写伪造机会数据'); return {saved:0,excluded:0}; }
  const pools=await outreachKeywordPools(competitors); const owned=new Set<string>(); const main=mainSiteDomain();
  if(main) { try { for(const row of await outreachAdapter.fetchReferringDomains(main)){const item=outreachSource(row);if(item)owned.add(item.domain);} } catch(error){console.warn(`主站外链排除清单获取失败：${String((error as Error).message)}`);} }
  const aggregates=new Map<string,{sources:OutreachSource[];competitors:any[];keywords:Set<string>}>(); let failed=0; let lastError='';
  for(const competitor of competitors) { try { const rows=await outreachAdapter.fetchReferringDomains(domainFromUrl(competitor.url)); const pool=[...mainKeywords(),...(pools.get(competitor.group)||[])]; for(const row of rows){const source=outreachSource(row);if(!source||owned.has(source.domain))continue;const item=aggregates.get(source.domain)||{sources:[],competitors:[],keywords:new Set<string>()};item.sources.push(source);if(!item.competitors.some(value=>value.id===competitor.id))item.competitors.push({id:competitor.id,name:competitor.name,group:competitor.group});for(const keyword of outreachMatches(`${source.domain} ${source.urlFrom||''} ${source.anchor||''}`,pool))item.keywords.add(keyword);aggregates.set(source.domain,item);} } catch(error){failed++;lastError=String((error as Error).message);console.warn(`Outreach skipped ${competitor.name}: ${lastError}`);} }
  let saved=0,excluded=0; const now=new Date();
  for(const [domain,item] of aggregates){const best=[...item.sources].sort((a,b)=>b.rank-a.rank)[0];const reasons:string[]=[];const spam=outreachSpamReason(domain,best.anchor);if(spam&&String(process.env.OUTREACH_EXCLUDE_SPAM||'true').toLowerCase()!=='false')reasons.push(spam);if(best.rank<=0)reasons.push('rank 为空或为 0');if(best.rank<outreachMinRank())reasons.push(`rank 低于 ${outreachMinRank()}`);if(best.brokenRatio>.5)reasons.push('broken backlinks 占比异常');if(outreachDofollowOnly()&&!best.dofollow)reasons.push('无 dofollow 外链');if(item.competitors.length>=5&&new Set(item.sources.map(value=>(value.anchor||'').toLowerCase())).size<=1)reasons.push('疑似链接农场');const score=reasons.length?0:Math.max(0,Math.min(100,Math.round(best.rank/10+(best.dofollow?10:0)+Math.min(20,item.keywords.size*5)+Math.min(10,item.competitors.length*2))));const existing=await prisma.outreachProspect.findUnique({where:{domain}});const statusHistory=history(existing?.statusHistory);if(!existing)statusHistory.push({status:'new',at:now.toISOString(),note:'首次发现'});const payload:any={urlFrom:best.urlFrom,anchor:best.anchor,rank:best.rank||null,dofollow:best.dofollow,competitors:item.competitors,keywords:[...item.keywords],qualityScore:score,tier:outreachTier(score),suggestedType:suggestedOutreachType(best.urlFrom,best.brokenRatio),excludeReason:reasons.join('；')||null,rawJson:{sources:item.sources.slice(0,20).map(value=>value.raw)},capturedAt:now,sheetsSyncError:null};await prisma.outreachProspect.upsert({where:{domain},update:payload,create:{domain,...payload,status:'new',statusHistory,firstSeen:now}});saved++;if(reasons.length)excluded++;}
  console.log(`Outreach opportunities saved: ${saved} (${excluded} excluded, ${failed} competitor errors)`);if(failed===competitors.length)throw new Error(`外链机会挖掘全部失败：${lastError}；保留已有数据`);return {saved,excluded};
}

export async function syncOutreachSheets() {
  const endpoint=process.env.GOOGLE_SHEETS_WEBAPP_URL?.trim(); if(!endpoint)throw new Error('未配置 GOOGLE_SHEETS_WEBAPP_URL，无法同步 Google Sheets');
  const rows=await prisma.outreachProspect.findMany({orderBy:{qualityScore:'desc'}}); const body=rows.map(row=>({domain:row.domain,urlFrom:row.urlFrom,anchor:row.anchor,dr:row.rank,dofollow:row.dofollow,competitors:Array.isArray(row.competitors)?row.competitors:[],keywords:row.keywords,qualityScore:row.qualityScore,tier:row.tier,suggestedType:row.suggestedType,status:row.status,firstSeen:row.firstSeen,note:row.excludeReason||''})); let errorText='';
  for(let attempt=0;attempt<3;attempt++){try{await axios.post(endpoint,body,{proxy:false,httpAgent,httpsAgent,timeout:30000,headers:{'Content-Type':'application/json'}});const syncedAt=new Date();await prisma.outreachProspect.updateMany({data:{sheetsSyncAt:syncedAt,sheetsSyncRows:body.length,sheetsSyncError:null}});await prisma.outreachProspect.updateMany({where:{status:'new',excludeReason:null},data:{status:'synced'}});return {rows:body.length,syncedAt};}catch(error){errorText=String((error as Error).message);if(attempt<2)await delay(500*2**attempt);}}
  await prisma.outreachProspect.updateMany({data:{sheetsSyncError:errorText}});throw new Error(`Google Sheets 同步失败：${errorText}`);
}

export async function updateOutreachStatus(id:number,status:string,note?:string) {
  if(!(outreachStatuses as readonly string[]).includes(status))throw new Error(`无效外链状态：${status}`);const existing=await prisma.outreachProspect.findUnique({where:{id}});if(!existing)throw new Error('外链机会不存在');
  const updated=await prisma.outreachProspect.update({where:{id},data:{status,statusHistory:[...history(existing.statusHistory),{status,at:new Date().toISOString(),note:note||''}]}});
  if(status==='placed'&&existing.urlFrom)await prisma.outreachLink.create({data:{prospectId:id,pageUrl:existing.urlFrom}}).catch(()=>undefined);
  return updated;
}

export async function checkOutreachLinks() {
  const target=mainSiteDomain();if(!target)throw new Error('未配置 MAIN_SITE_DOMAIN，无法检查已挂载链接');const links=await prisma.outreachLink.findMany({where:{prospect:{status:'placed'}},include:{prospect:true}});if(!links.length)return {checked:0,dead:0};
  const browserContext=await context();let checked=0,dead=0;try{for(const link of links){const page=await browserContext.ctx.newPage();try{const response=await page.goto(link.pageUrl,{waitUntil:'domcontentloaded',timeout:30000});const html=await page.content();const $=cheerio.load(html);const alive=$('a[href]').toArray().some(node=>normalizeDomain(absoluteUrl(link.pageUrl,$(node).attr('href')||''))===target);const note=alive?`HTTP ${response?.status()||200}`:'未发现指向主站的链接';await prisma.outreachLink.update({where:{id:link.id},data:{alive,lastCheckedAt:new Date(),note}});if(!alive){dead++;await prisma.outreachProspect.update({where:{id:link.prospectId},data:{status:'dead',statusHistory:[...history(link.prospect.statusHistory),{status:'dead',at:new Date().toISOString(),note}]}});}checked++;}catch(error){dead++;await prisma.outreachLink.update({where:{id:link.id},data:{alive:false,lastCheckedAt:new Date(),note:String((error as Error).message)}});}finally{await page.close();}}}finally{await browserContext.close();}return {checked,dead};
}

export async function outreachEmail(id:number) {
  const row=await prisma.outreachProspect.findUnique({where:{id}});if(!row)throw new Error('外链机会不存在');const keywords=Array.isArray(row.keywords)?row.keywords.join(', '):'';const main=process.env.MAIN_SITE_DOMAIN||'our site';
  return {subject:`Content collaboration opportunity for ${row.domain}`,body:`Hello ${row.domain} team,\n\nI enjoyed your page ${row.urlFrom||row.domain} and wanted to suggest a useful resource for your readers. We run ${main}, focused on ${keywords||'handcrafted leather and latex products'}.\n\nWould you consider adding a contextual reference using the anchor text “${row.anchor||keywords||'handcrafted products'}” where it is editorially appropriate? I can provide original content or a concise resource for your review.\n\nBest regards,\n${main}`};
}

type AuditCheck = { key:string; label:string; status:'pass'|'warn'|'fail'; message:string; suggestion?:string };
type AuditDimension = { score:number; max:number; checks:AuditCheck[] };
const check = (key:string,label:string,status:AuditCheck['status'],message:string,suggestion?:string):AuditCheck => ({key,label,status,message,suggestion});
const checkScore = (checks:AuditCheck[], max:number) => Math.round((checks.reduce((sum,item) => sum + (item.status === 'pass' ? 1 : item.status === 'warn' ? .5 : 0), 0) / Math.max(checks.length, 1)) * max * 10) / 10;
const absoluteUrl = (base:string, href:string) => { try { return new URL(href, base).toString(); } catch { return ''; } };
const schemaTypeNames = new Set(['Product','Offer','AggregateRating','Review','BreadcrumbList','Organization','WebSite','FAQPage','VideoObject','Article','CollectionPage','ItemList']);
function flattenSchema(value:any):any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenSchema);
  if (typeof value !== 'object') return [];
  const current = value['@type'] ? [value] : [];
  return [...current, ...flattenSchema(value['@graph'])];
}
function parseSchemaScripts(html:string) {
  const $ = cheerio.load(html);
  const objects:any[] = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    try { objects.push(...flattenSchema(JSON.parse($(node).text()))); } catch { /* malformed JSON-LD is an audit result, not a task failure */ }
  });
  const types = [...new Set(objects.flatMap(item => Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).filter(type => schemaTypeNames.has(type)))];
  const products = objects.filter(item => (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).includes('Product'));
  const productSchemaDetail = products.map(product => ({
    price: Boolean(product.offers?.price || product.price),
    priceCurrency: Boolean(product.offers?.priceCurrency || product.priceCurrency),
    availability: Boolean(product.offers?.availability || product.availability),
    aggregateRating: Boolean(product.aggregateRating),
    review: Boolean(product.review),
    brand: Boolean(product.brand),
    gtin: Boolean(product.gtin || product.gtin8 || product.gtin12 || product.gtin13 || product.gtin14),
    sku: Boolean(product.sku),
  }));
  return { schemaTypes: types, productSchemaDetail };
}

async function auditPage(page:any, url:string, brand:string, homeUrl:string):Promise<any> {
  const started = Date.now();
  const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  const html = await page.content();
  const schema = parseSchemaScripts(html);
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const title = ($('title').first().text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const h1Count = $('h1').length;
  const headings = $('h1,h2,h3').toArray().map(node => Number(node.tagName.slice(1)));
  const hasJump = headings.some((level, index) => index > 0 && level - headings[index - 1] > 1);
  const words = bodyText.split(/\s+/).filter(Boolean).length;
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  const images = $('img').toArray();
  const altCoverage = images.length ? images.filter(img => Boolean($(img).attr('alt')?.trim())).length / images.length * 100 : 100;
  const lazyUsage = images.length ? images.filter(img => $(img).attr('loading') === 'lazy').length / images.length * 100 : 100;
  const modernImages = images.length ? images.filter(img => /\.(?:webp|avif)(?:[?#]|$)/i.test($(img).attr('src') || '')).length / images.length * 100 : 100;
  const links = $('a[href]').toArray().map(node => absoluteUrl(url, $(node).attr('href') || '')).filter(Boolean);
  const homeHost = new URL(homeUrl).hostname;
  const internalLinks = [...new Set(links.filter(link => { try { return new URL(link).hostname === homeHost; } catch { return false; } }))];
  const externalLinks = links.filter(link => !internalLinks.includes(link));
  const noopenerRatio = externalLinks.length ? $('a[href]').toArray().filter(node => { const href = absoluteUrl(url, $(node).attr('href') || ''); return href && !internalLinks.includes(href) && (($(node).attr('rel') || '').split(/\s+/).includes('noopener')); }).length / externalLinks.length * 100 : 100;
  let brokenInternal = 0;
  for (const link of internalLinks.slice(0, 20)) { try { const head = await page.request.fetch(link, { method:'HEAD', timeout:8000 }); if (head.status() >= 400) brokenInternal++; } catch { brokenInternal++; } }
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return { ttfb: navigation?.responseStart || 0, domContentLoaded: navigation?.domContentLoadedEventEnd || 0, resourceCount: resources.length, transferSize: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0), renderBlocking: resources.filter(item => /(?:css|javascript)/i.test(item.name)).length };
  }).catch(() => ({ttfb:0,domContentLoaded:Date.now()-started,resourceCount:0,transferSize:htmlBytes,renderBlocking:0}));
  const viewport = $('meta[name="viewport"]').length > 0;
  const media = html.includes('@media') || $('link[media],source[srcset],img[srcset]').length > 0;
  const jsonLd = $('script[type="application/ld+json"]').map((_, node) => $(node).text()).get().join(' ');
  const https = /^https:/i.test(url);
  const sitemap = await page.request.fetch(new URL('/sitemap.xml', homeUrl).toString(), { method:'GET', timeout:10000 }).then((r:any)=>r.ok()).catch(()=>false);
  const robotsResponse = await page.request.fetch(new URL('/robots.txt', homeUrl).toString(), { method:'GET', timeout:10000 }).catch(()=>null);
  const robotsText = robotsResponse ? await robotsResponse.text().catch(()=> '') : '';
  const robotsBlocked = /disallow:\s*\/\s*(?:$|\r?\n)/im.test(robotsText);
  const canonical = $('link[rel="canonical"]').length > 0;
  const ogComplete = ['og:title','og:description','og:image'].every(property => $(`meta[property="${property}"]`).attr('content'));
  const twitterCard = Boolean($('meta[name="twitter:card"]').attr('content'));
  const hreflang = $('link[hreflang]').length > 0;
  const hasStructured = /(?:Product|Organization)/i.test(jsonLd);
  const bodyHtmlRatio = htmlBytes ? Buffer.byteLength(bodyText, 'utf8') / htmlBytes * 100 : 0;
  const dimensions:Record<string,AuditDimension> = {
    title: { max:15, score:checkScore([check('title','Title',title.length >= 10 && title.length <= 60 ? 'pass' : title ? 'warn' : 'fail', title ? `title 长度 ${title.length} 字符` : '缺少 title', '补充 10-60 字符且包含品牌词的标题'), check('description','Meta description',description.length >= 50 && description.length <= 160 ? 'pass' : description ? 'warn' : 'fail', description ? `摘要长度 ${description.length} 字符` : '缺少 meta description', '补充 50-160 字符的页面摘要'), check('brand','Brand in title',title.toLowerCase().includes(brand.toLowerCase()) ? 'pass' : 'warn', title.toLowerCase().includes(brand.toLowerCase()) ? '标题包含品牌词' : '标题未包含品牌词')],15), checks:[] },
    content: { max:15, score:0, checks:[] }, images: { max:10, score:0, checks:[] }, links: { max:10, score:0, checks:[] }, mobile: { max:10, score:0, checks:[] }, social: { max:10, score:0, checks:[] }, infrastructure: { max:15, score:0, checks:[] }, code: { max:15, score:0, checks:[] },
  };
  dimensions.title.checks = [check('title','Title',title.length >= 10 && title.length <= 60 ? 'pass' : title ? 'warn' : 'fail', title ? `title 长度 ${title.length} 字符` : '缺少 title', '补充 10-60 字符且包含品牌词的标题'), check('description','Meta description',description.length >= 50 && description.length <= 160 ? 'pass' : description ? 'warn' : 'fail', description ? `摘要长度 ${description.length} 字符` : '缺少 meta description', '补充 50-160 字符的页面摘要'), check('brand','Brand in title',title.toLowerCase().includes(brand.toLowerCase()) ? 'pass' : 'warn', title.toLowerCase().includes(brand.toLowerCase()) ? '标题包含品牌词' : '标题未包含品牌词')];
  dimensions.content.checks = [check('h1','Single H1',h1Count === 1 ? 'pass' : 'fail', `H1 数量 ${h1Count}`, '保留一个主标题 H1'), check('headingOrder','Heading order',!hasJump ? 'pass' : 'warn', !hasJump ? '标题层级连续' : '标题层级存在跳级', '按 H1 → H2 → H3 顺序组织标题'), check('wordCount','Text content',words >= 300 ? 'pass' : words >= 100 ? 'warn' : 'fail', `正文约 ${words} 词`, '补充至少 300 词的有效正文'), check('textRatio','Text/HTML ratio',bodyHtmlRatio > 10 ? 'pass' : bodyHtmlRatio > 5 ? 'warn' : 'fail', `文字/HTML 比例 ${bodyHtmlRatio.toFixed(1)}%`, '减少无意义 HTML 并增加可读文本')];
  dimensions.images.checks = [check('alt','Image alt',altCoverage >= 90 ? 'pass' : altCoverage >= 60 ? 'warn' : 'fail', `alt 覆盖率 ${altCoverage.toFixed(1)}%`, '为图片补充描述性 alt'), check('lazy','Lazy loading',lazyUsage >= 70 ? 'pass' : lazyUsage >= 30 ? 'warn' : 'fail', `lazy 使用率 ${lazyUsage.toFixed(1)}%`, '为非首屏图片添加 loading="lazy"'), check('modern','Modern image',modernImages >= 50 ? 'pass' : modernImages > 0 ? 'warn' : 'fail', `WebP/AVIF 占比 ${modernImages.toFixed(1)}%`, '将图片转换为 WebP 或 AVIF')];
  dimensions.links.checks = [check('internal','Internal links',internalLinks.length > 0 ? 'pass' : 'fail', `内链 ${internalLinks.length} 个`), check('external','External links',externalLinks.length >= 0 ? 'pass' : 'warn', `外链 ${externalLinks.length} 个`), check('broken','Broken links',brokenInternal === 0 ? 'pass' : brokenInternal <= 2 ? 'warn' : 'fail', `抽检 ${Math.min(20, internalLinks.length)} 个内链，${brokenInternal} 个异常`, '修复返回 4xx/5xx 的内链'), check('noopener','External noopener',noopenerRatio >= 80 ? 'pass' : noopenerRatio > 0 ? 'warn' : 'fail', `noopener 覆盖率 ${noopenerRatio.toFixed(1)}%`, '外链补充 rel="noopener"')];
  dimensions.mobile.checks = [check('viewport','Viewport',viewport ? 'pass' : 'fail', viewport ? '存在 viewport meta' : '缺少 viewport meta', '添加移动端 viewport'), check('font','Base font',/font-size\s*:\s*(?:1[2-9]|[2-9]\d)px/i.test(html) ? 'pass' : 'warn', '完成基础字体大小检查', '确保正文移动端不小于 16px'), check('responsive','Responsive markers',media ? 'pass' : 'warn', media ? '检测到 media query/srcset' : '未检测到响应式标记', '添加 media query 或 srcset')];
  dimensions.social.checks = [check('og','Open Graph',ogComplete ? 'pass' : 'fail', ogComplete ? 'og:title/description/image 完整' : 'Open Graph 标签不完整', '补齐 og:title、og:description、og:image'), check('twitter','Twitter card',twitterCard ? 'pass' : 'warn', twitterCard ? '存在 twitter:card' : '缺少 twitter:card', '添加 twitter:card'), check('canonical','Canonical',canonical ? 'pass' : 'warn', canonical ? '存在 canonical' : '缺少 canonical', '添加规范链接 canonical')];
  dimensions.infrastructure.checks = [check('https','HTTPS',https ? 'pass' : 'fail', https ? '使用 HTTPS' : '未使用 HTTPS', '启用 HTTPS'), check('sitemap','Sitemap',sitemap ? 'pass' : 'warn', sitemap ? 'sitemap.xml 可达' : 'sitemap.xml 不可达', '提供可访问的 sitemap.xml'), check('robots','Robots',robotsResponse?.ok() && !robotsBlocked ? 'pass' : robotsResponse?.ok() ? 'warn' : 'fail', robotsResponse?.ok() ? (robotsBlocked ? 'robots.txt 全站禁止抓取' : 'robots.txt 可达且未全站禁止') : 'robots.txt 不可达', '检查 robots.txt 抓取规则'), check('structured','JSON-LD',hasStructured ? 'pass' : 'warn', hasStructured ? '包含 Product/Organization 结构化数据' : '未检测到 Product/Organization JSON-LD', '添加结构化数据'), check('hreflang','Hreflang',hreflang ? 'pass' : 'warn', hreflang ? '存在 hreflang' : '未检测到 hreflang（单语言站点可忽略）')];
  dimensions.code.checks = [check('ttfb','TTFB',timing.ttfb < 800 ? 'pass' : timing.ttfb < 1500 ? 'warn' : 'fail', `TTFB ${Math.round(timing.ttfb)}ms`, '将 TTFB 控制在 800ms 内'), check('dom','DOM nodes',$('body *').length < 1500 ? 'pass' : $('body *').length < 2500 ? 'warn' : 'fail', `DOM 节点 ${$('body *').length}`, '减少无必要 DOM 节点'), check('size','Page size',Math.max(htmlBytes, timing.transferSize) < 3 * 1024 * 1024 ? 'pass' : 'fail', `页面资源约 ${(Math.max(htmlBytes, timing.transferSize) / 1024 / 1024).toFixed(2)}MB`, '压缩页面和资源体积'), check('blocking','Render blocking',timing.renderBlocking < 10 ? 'pass' : timing.renderBlocking < 20 ? 'warn' : 'fail', `检测到约 ${timing.renderBlocking} 个脚本/样式资源`), check('valid','HTML validity',Boolean(response && response.ok()) ? 'pass' : 'fail', response?.ok() ? '页面正常返回' : `页面状态 ${response?.status() || '未知'}`)];
  for (const dimension of Object.values(dimensions)) dimension.score = checkScore(dimension.checks, dimension.max);
  const allChecks = Object.values(dimensions).flatMap(dimension => dimension.checks);
  const strengths = allChecks.filter(item => item.status === 'pass').map(item => item.message);
  const issues = allChecks.filter(item => item.status !== 'pass').map(item => ({ item: item.message, suggestion: item.suggestion || '请检查并优化该项' }));
  return { url, title, score: Math.round(Object.values(dimensions).reduce((sum, dimension) => sum + dimension.score, 0)), dimensions, checks: allChecks, strengths, issues, metrics: timing, schema };
}

export async function collectSeo(limit?: number) {
  const all = await prisma.competitor.findMany({ ...(limit ? { take: limit } : {}), include: { snapshots: { orderBy: { capturedAt:'desc' }, take: 20 } } });
  let saved = 0;
  for (const competitor of all) {
    let browserContext: Awaited<ReturnType<typeof context>> | undefined;
    try {
      browserContext = await context();
      const productSnapshot = competitor.snapshots.find(snapshot => snapshot.pageType === 'products' || /products\//i.test(snapshot.url));
      const representative = competitor.snapshots.find(snapshot => snapshot.url !== competitor.url && /category|collection/i.test(snapshot.url));
      const urls = [competitor.url, representative?.url, productSnapshot?.url].filter(Boolean).slice(0, 3) as string[];
      const pages:any[] = [];
      for (const url of [...new Set(urls)]) { const page = await browserContext.ctx.newPage(); try { pages.push(await auditPage(page, url, competitor.name, competitor.url)); } finally { await page.close(); } }
      const titleCounts = new Map<string, number>(); for (const page of pages) titleCounts.set(page.title, (titleCounts.get(page.title) || 0) + 1);
      for (const page of pages) if (page.title && (titleCounts.get(page.title) || 0) > 1) { page.issues.push({ item:'多个页面 title 重复', suggestion:'为每个页面设置唯一、描述准确的 title' }); page.dimensions.title.checks.push(check('uniqueTitle','Unique title','warn','多个页面 title 重复','为每个页面设置唯一 title')); page.dimensions.title.score = checkScore(page.dimensions.title.checks, page.dimensions.title.max); }
      const dimensions:Record<string,any> = {}; for (const key of Object.keys(pages[0]?.dimensions || {})) dimensions[key] = { score: Math.round(pages.reduce((sum, page) => sum + page.dimensions[key].score, 0) / Math.max(pages.length, 1) * 10) / 10, max: pages[0].dimensions[key].max, checks: pages.flatMap(page => page.dimensions[key].checks) };
      const strengths = [...new Set(pages.flatMap(page => page.strengths))];
      const issues = pages.flatMap(page => page.issues).filter((item, index, list) => index === list.findIndex(other => other.item === item.item));
      const score = Math.round(Object.values(dimensions).reduce((sum:any, dimension:any) => sum + dimension.score, 0));
      await prisma.seoReport.create({ data:{ competitorId:competitor.id, score, dimensions, strengths, issues, pages } });
      for (const page of pages) {
        const pageType = page.url === competitor.url ? 'home' : /products\//i.test(page.url) ? 'product' : 'category';
        await prisma.schemaSnapshot.create({ data:{ competitorId:competitor.id, pageType, url:page.url, schemaTypes:page.schema.schemaTypes, productSchemaDetail:page.schema.productSchemaDetail } });
      }
      saved++;
      console.log(`SEO audit saved: ${competitor.name} ${score}/100`);
    } catch (error) { console.warn(`SEO skipped ${competitor.name}: ${String((error as Error).message)}`); }
    finally { await browserContext?.close(); }
  }
  if (all.length && saved === 0) throw new Error('No SEO reports saved; inspect proxy/site errors above');
}

const keywordMarket = process.env.DATAFORSEO_LOCATION || 'United States';
const keywordLanguage = process.env.DATAFORSEO_LANGUAGE || 'en';
function keywordResultValue(row:any, path:string[]) { return path.reduce((value,key)=>value?.[key], row); }
function parseRankedKeyword(row:any) {
  const keyword = row.keyword || keywordResultValue(row,['keyword_data','keyword']) || keywordResultValue(row,['keyword_data','keyword_info','keyword']);
  const info = row.keyword_data?.keyword_info || row.keyword_info || {};
  const serp = row.ranked_serp_element?.serp_item || row.ranked_serp_element || row.serp_item || {};
  if (!keyword) return null;
  return { keyword:String(keyword), searchVolume:optionalNumber(info.search_volume, row.search_volume), position:optionalNumber(serp.rank_absolute, serp.rank, row.position), rankedUrl:serp.url || row.ranked_url || null, etv:optionalNumber(info.etv, row.etv) };
}

export async function collectKeywords(limit?: number) {
  const all = await prisma.competitor.findMany({ ...(limit ? { take: limit } : {}), include:{ trafficSnapshots:{ orderBy:{ month:'desc' }, take:1 } } });
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0,0,0,0);
  let saved = 0;
  for (const competitor of all) {
    try {
      if (demo) {
        const demoRows = ['latex catsuit','leather harness','latex choker'].map((keyword,index)=>({keyword,searchVolume:900-index*150,position:index+1,rankedUrl:competitor.url,etv:120-index*20}));
        await prisma.keywordSnapshot.deleteMany({ where:{ competitorId:competitor.id, source:'dataforseo', type:'organic', capturedAt:{ gte:monthStart } } });
        await prisma.keywordSnapshot.createMany({ data:demoRows.map(row=>({...row,competitorId:competitor.id,market:keywordMarket})) }); saved += demoRows.length; continue;
      }
      const rows = await labsLive('google/ranked_keywords', [{ target:domainFromUrl(competitor.url), location_name:keywordMarket, language_code:keywordLanguage, limit:100, order_by:['etv,desc'] }]);
      const parsed = rows.map(parseRankedKeyword).filter(Boolean) as any[];
      if (!parsed.length) throw new Error('ranked_keywords returned no keyword rows');
      await prisma.keywordSnapshot.deleteMany({ where:{ competitorId:competitor.id, capturedAt:{ gte:monthStart } } });
      await prisma.keywordSnapshot.createMany({ data:parsed.map(row=>({...row,competitorId:competitor.id,market:keywordMarket})) });
      saved += parsed.length;
    } catch (error) { console.warn(`Keywords skipped ${competitor.name}: ${String((error as Error).message)}`); }
  }
  for (const group of ['leather','latex'] as const) {
    const candidates = all.filter(competitor=>competitor.group===group).sort((a,b)=>(b.trafficSnapshots[0]?.visits||0)-(a.trafficSnapshots[0]?.visits||0)).slice(0,3);
    if (candidates.length < 2 || demo) continue;
    try {
      const rows = await labsLive('google/domain_intersection', [{ targets:candidates.map(competitor=>domainFromUrl(competitor.url)), location_name:keywordMarket, language_code:keywordLanguage, limit:100, order_by:['etv,desc'] }]);
      const opportunities = rows.map(parseRankedKeyword).filter(Boolean) as any[];
      if (opportunities.length && candidates[0]) {
        await prisma.keywordSnapshot.createMany({ data:opportunities.map(row=>({...row,competitorId:candidates[0].id,market:keywordMarket,isOpportunity:true,opportunityGroup:group})) });
      }
    } catch (error) { console.warn(`Keyword intersection skipped ${group}: ${String((error as Error).message)}`); }
  }
  console.log(`Keywords saved: ${saved} rows for ${all.length} competitors`);
  if (all.length && saved === 0 && !demo) throw new Error('No keyword snapshots saved; inspect DataForSEO errors above');
}

export async function collectTechAndAds(limit?: number) {
  const all=await prisma.competitor.findMany(limit ? { take: limit } : undefined); for(const c of all){
    let technologies:any[]=['Detection unavailable'];
    let techContext: Awaited<ReturnType<typeof context>> | undefined;
    try {
      techContext=await context(); const p=await techContext.ctx.newPage(); const response=await p.goto(c.url,{waitUntil:'domcontentloaded',timeout:30000});
      const html=await p.content(); const scripts=await p.locator('script[src]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLScriptElement).src));
      const rawHeaders=response?.headers()||{}; const headers=Object.fromEntries(Object.entries(rawHeaders).map(([key,value])=>[key,[value]]));
      const detected=await wappalyzerWrapper.analyze({url:c.url,html,scripts,headers}) as Array<{app?:string;version?:string;categories?:string[]}>;
      technologies=detected.map(item=>({name:item.app||'Unknown',version:item.version||'',categories:item.categories||[]}));
      await p.close();
    } catch (error) { console.warn(`Wappalyzer skipped ${c.name}: ${String((error as Error).message)}`); }
    finally { await techContext?.close(); }
    await prisma.techSnapshot.create({data:{competitorId:c.id,technologies}});
    let activeCount:number|undefined; let copySummary='Ad Library unavailable'; let adPlatforms:string[]=[]; let adStatus='unavailable';
    let adContext: Awaited<ReturnType<typeof context>> | undefined;
    try {
      adContext=await context(); const p=await adContext.ctx.newPage(); const adUrl=`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(c.name)}&search_type=keyword_unordered`;
      await p.goto(adUrl,{waitUntil:'domcontentloaded',timeout:30000}); await p.waitForTimeout(2500); const body=await p.locator('body').innerText(); const html=await p.content();
      const countMatch=html.match(/search_results_connection[\\"]*:[\\"]*\{[\\"]*count[\\"]*:(\d+)/); const textCount=body.match(/~([\d,]+)\s+results?/i)?.[1];
      activeCount=countMatch?Number(countMatch[1]):textCount?Number(textCount.replace(/,/g,'')):undefined;
      const copyMatches=[...html.matchAll(/[\\"]body[\\"]*:[\\"]*\{[\\"]*text[\\"]*:[\\"]*"((?:\\\\.|[^"\\])*)"/g)].map(match=>{try{return JSON.parse(`"${match[1]}"`)}catch{return match[1]}}).filter(text=>text.trim().length>12);
      const titleMatches=[...html.matchAll(/[\\"]title[\\"]*:[\\"]*"((?:\\\\.|[^"\\])*)"/g)].map(match=>{try{return JSON.parse(`"${match[1]}"`)}catch{return match[1]}}).filter(text=>text.trim().length>3);
      const summaries=[...new Set([...copyMatches,...titleMatches])].slice(0,5); if(summaries.length) copySummary=summaries.join(' | ').slice(0,1000);
      const platformMatches=[...html.matchAll(/[\\"]publisher_platform[\\"]*:[\\"]*\[((?:[^\]])*)\]/g)].flatMap(match=>match[1].match(/[A-Z_]+/g)||[]); adPlatforms=[...new Set(platformMatches.filter(x=>['FACEBOOK','INSTAGRAM','MESSENGER','AUDIENCE_NETWORK','WHATSAPP','THREADS'].includes(x)).map(x=>x[0]+x.slice(1).toLowerCase()))];
      adStatus=activeCount!==undefined||summaries.length>0?'ok':'unavailable'; await p.close();
    } catch (error) { console.warn(`Ad Library skipped ${c.name}: ${String((error as Error).message)}`); }
    finally { await adContext?.close(); }
    await prisma.adSnapshot.create({data:{competitorId:c.id,activeCount,copySummary,platforms:adPlatforms,status:adStatus}});
  }
}

export async function crawlAll(limit?:number){ for(const c of await prisma.competitor.findMany(limit?{take:limit}:undefined)) await crawlCompetitor(c.id,c.url); }

/* -------------------------------------------------------------------------- *
 * Semrush 数据源（标准 SEO API）
 *
 * 用途：Semrush 的关键词库比 DataForSEO 更大，用于补齐/交叉验证关键词、
 * 付费关键词（谁在投 Google Ads、投什么词）与反链总览。
 *
 * 实现要点：
 *  - 端点 https://api.semrush.com/ ，GET + key 参数，响应是「分号分隔纯文本」，
 *    第一行是表头，必须按 export_columns 的顺序解析（不是 JSON）。
 *  - 反链走另一组地址：https://api.semrush.com/analytics/v1/ ，参数用 target。
 *  - 按行扣 units（自然词 10、付费词 20、域名概览 10、反链总览 40），
 *    所以每次请求后按实际返回行数累计消耗，超出预算立即停止。
 *  - 余额查询接口免费：www.semrush.com/users/countapiunits.html。
 *  - Semrush 国内可直连，因此这里不挂代理（与 DataForSEO 一致）。
 * -------------------------------------------------------------------------- */
const semrushKey = process.env.SEMRUSH_API_KEY;
const semrushDatabase = (process.env.SEMRUSH_DATABASE || 'us').toLowerCase();
const semrushBudget = Number(process.env.SEMRUSH_UNIT_BUDGET || 48000);
const SEMRUSH_UNIT_COST = { domain_organic: 10, domain_adwords: 20, domain_ranks: 10, backlinks_overview: 40 } as const;
let semrushSpent = 0;

// 标准 Semrush API 的所有报告（包括 backlinks_overview）都走同一个
// https://api.semrush.com/ 入口；该服务按 query string 解析 type/domain。
const semrushApi = axios.create({ baseURL: 'https://api.semrush.com/', proxy: false, timeout: 60000 });

export function semrushState() {
  return { configured: Boolean(semrushKey), spent: semrushSpent, budget: semrushBudget, database: semrushDatabase, unitsLeft: semrushBudget - semrushSpent };
}

/** 免费接口：返回账户剩余 units（不消耗配额）。 */
export async function semrushBalance(): Promise<number> {
  if (!semrushKey) throw new Error('SEMRUSH_API_KEY 未配置：请在项目 .env 填入购买的 Key 后重启服务');
  const response = await axios.get('https://www.semrush.com/users/countapiunits.html', { params: { key: semrushKey }, proxy: false, timeout: 30000 });
  const value = Number(String(response.data).trim());
  if (!Number.isFinite(value)) throw new Error(`Semrush 余额查询失败：${String(response.data).slice(0, 160)}`);
  return value;
}

/** Semrush 返回的是「表头 + 分号分隔数据行」，按 export_columns 顺序取值。 */
function parseSemrushRows(text: string, columns: string[]): Array<Record<string, string>> {
  const lines = String(text).replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (/^ERROR/i.test(lines[0])) throw new Error(`Semrush API 错误：${lines[0].slice(0, 200)}`);
  if (/^NOTHING FOUND/i.test(lines[0])) return [];
  const body = lines.length > 1 && lines[0].includes(';') ? lines.slice(1) : lines;
  return body.map(line => {
    const cells = line.split(';');
    const row: Record<string, string> = {};
    columns.forEach((column, index) => { row[column] = (cells[index] ?? '').trim(); });
    return row;
  });
}

async function semrushCall(options: {
  type: string;
  params: Record<string, string | number>;
  columns: string[];
  costPerLine: number;
  backlinks?: boolean;
}) {
  if (!semrushKey) throw new Error('SEMRUSH_API_KEY 未配置');
  const query: Record<string, string | number> = { key: semrushKey, type: options.type, ...options.params };
  // Semrush 限制为每秒最多 10 个请求。共享节流器同时覆盖关键词、流量、反链。
  const elapsed = Date.now() - semrushLastCall;
  if (elapsed < 200) await delay(200 - elapsed);
  semrushLastCall = Date.now();
  let response;
  try {
    response = await semrushApi.get('', { params: query });
  } catch (error: any) {
    const status = error?.response?.status || 'network';
    throw new Error(`Semrush ${options.type}: ${status} ${String(error?.response?.data || error?.message || error).slice(0, 160)}`);
  }
  const rows = parseSemrushRows(response.data, options.columns);
  const cost = rows.length * options.costPerLine;
  semrushSpent += cost;
  console.log(`Semrush ${options.type}: ${rows.length} 行 · 消耗 ${cost} units · 本次累计 ${semrushSpent}/${semrushBudget}`);
  if (semrushSpent >= semrushBudget) {
    console.warn(`已消耗 ${semrushSpent} units，剩余 0，停止采集`);
  }
  return { rows, cost };
}

let semrushLastCall = 0;

async function semrushPrepare(label: string) {
  const balance = await semrushBalance();
  const spendable = Math.max(0, Math.min(semrushBudget - semrushSpent, balance));
  console.log(`Semrush ${label}: 账户余额 ${balance} units，可消费预算 ${spendable} units`);
  return spendable;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const semrushMonth = () => new Date().toISOString().slice(0, 7);
function semrushEtv(row: Record<string,string>) {
  const volume=optionalNumber(row.searchVolume);
  const share=optionalNumber(row.trafficShare);
  return volume!==undefined&&share!==undefined ? round1(volume*share/100) : undefined;
}
type SemrushOptions = { competitorIds?: number[] };

async function semrushCompetitors(limit?: number, options?: SemrushOptions) {
  const where = options?.competitorIds?.length ? { id: { in: options.competitorIds } } : undefined;
  return prisma.competitor.findMany({
    where,
    ...(limit ? { take: limit } : {}),
    orderBy: { id: 'asc' },
  });
}

function semrushCanSpend(spendable: number, units: number) {
  return semrushSpent + units <= spendable;
}

/** 自然关键词（top100）+ 付费关键词（top20）写入 KeywordSnapshot，source='semrush'。 */
export async function collectSemrushKeywords(limit?: number, options?: SemrushOptions) {
  const all = await semrushCompetitors(limit, options);
  if (!all.length) return;
  const spendable = await semrushPrepare('keywords');
  if (!spendable) throw new Error('Semrush units 不足，已停止关键词采集');
  const fullOrganicUnits = all.length * 100 * SEMRUSH_UNIT_COST.domain_organic;
  const paidUnits = all.length * 20 * SEMRUSH_UNIT_COST.domain_adwords;
  let organicLimit = 100;
  let collectPaid = true;
  if (spendable < fullOrganicUnits + paidUnits) {
    organicLimit = 50;
    console.warn(`Semrush 余额低于关键词完整预算，P0 自然词降级为 display_limit=50`);
    if (spendable < all.length * organicLimit * SEMRUSH_UNIT_COST.domain_organic + paidUnits) {
      collectPaid = false;
      console.warn('Semrush 余额不足以覆盖付费关键词任务，跳过 P1 domain_adwords');
    }
    if (spendable < all.length * organicLimit * SEMRUSH_UNIT_COST.domain_organic) {
      throw new Error('Semrush units 不足以执行降级后的关键词任务，已拒绝执行');
    }
  }
  let saved = 0; let stopped = false;
  for (const competitor of all) {
    if (stopped) break;
    const domain = domainFromUrl(competitor.url);
    const organicRequestLimit = Math.min(organicLimit, Math.floor(Math.max(0, spendable - semrushSpent) / SEMRUSH_UNIT_COST.domain_organic));
    if (organicRequestLimit < 1) { console.warn(`已消耗 ${semrushSpent} units，剩余 ${Math.max(0, spendable - semrushSpent)}，停止采集`); stopped = true; break; }
    try {
      const organic = await semrushCall({
        type: 'domain_organic',
        params: { domain, database: semrushDatabase, display_limit: organicRequestLimit, export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr' },
        columns: ['keyword', 'position', 'previousPosition', 'searchVolume', 'cpc', 'url', 'trafficShare'],
        costPerLine: SEMRUSH_UNIT_COST.domain_organic,
      });
      const organicRows = organic.rows.map(row => ({
        competitorId: competitor.id,
        keyword: row.keyword,
        position: optionalNumber(row.position) ?? null,
        searchVolume: optionalNumber(row.searchVolume) === undefined ? null : Math.round(Number(row.searchVolume)),
        etv: semrushEtv(row),
        cpc: optionalNumber(row.cpc),
        rankedUrl: row.url || null,
        trafficShare: optionalNumber(row.trafficShare),
        type: 'organic',
        source: 'semrush',
        market: semrushDatabase,
      })).filter(row => row.keyword);
      await prisma.keywordSnapshot.deleteMany({ where: { competitorId: competitor.id, source: 'semrush', type: 'organic' } });
      if (organicRows.length) await prisma.keywordSnapshot.createMany({ data: organicRows });

      const paidRequestLimit = collectPaid ? Math.min(20, Math.floor(Math.max(0, spendable - semrushSpent) / SEMRUSH_UNIT_COST.domain_adwords)) : 0;
      if (paidRequestLimit > 0) {
        const paid = await semrushCall({
          type: 'domain_adwords',
          params: { domain, database: semrushDatabase, display_limit: paidRequestLimit, export_columns: 'Ph,Po,Pp,Nq,Cp,Ur,Tr' },
          columns: ['keyword', 'position', 'previousPosition', 'searchVolume', 'cpc', 'url', 'trafficShare'],
          costPerLine: SEMRUSH_UNIT_COST.domain_adwords,
        });
        const paidRows = paid.rows.map(row => ({
          competitorId: competitor.id,
          keyword: row.keyword,
          position: optionalNumber(row.position) ?? null,
          searchVolume: optionalNumber(row.searchVolume) === undefined ? null : Math.round(Number(row.searchVolume)),
          etv: semrushEtv(row),
          cpc: optionalNumber(row.cpc),
          rankedUrl: row.url || null,
          trafficShare: optionalNumber(row.trafficShare),
          type: 'paid',
          source: 'semrush',
          market: semrushDatabase,
        })).filter(row => row.keyword);
        await prisma.keywordSnapshot.deleteMany({ where: { competitorId: competitor.id, source: 'semrush', type: 'paid' } });
        if (paidRows.length) await prisma.keywordSnapshot.createMany({ data: paidRows });
      }
      saved++;
      await delay(250);
    } catch (error) { console.warn(`Semrush keywords skipped ${competitor.name}: ${String((error as Error).message)}`); }
  }
  console.log(`Semrush keywords saved: ${saved}/${all.length} competitors · 累计消耗 ${semrushSpent} units`);
  if (all.length && saved === 0) throw new Error('Semrush 关键词未写入任何数据，请检查 Key 与 units 余额');
}

/** 当月流量（domain_ranks）：有机/付费流量，用于与 DataForSEO 交叉验证。 */
export async function collectSemrushTraffic(limit?: number, options?: SemrushOptions) {
  const all = await semrushCompetitors(limit, options);
  if (!all.length) return;
  const spendable = await semrushPrepare('traffic');
  if (!spendable) throw new Error('Semrush units 不足，已停止流量采集');
  const month = semrushMonth();
  let saved = 0;
  for (const competitor of all) {
    if (!semrushCanSpend(spendable, SEMRUSH_UNIT_COST.domain_ranks)) { console.warn(`已消耗 ${semrushSpent} units，剩余 ${Math.max(0, spendable - semrushSpent)}，停止采集`); break; }
    try {
      const { rows } = await semrushCall({
        type: 'domain_ranks',
        params: { domain: domainFromUrl(competitor.url), database: semrushDatabase, export_columns: 'Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac,Sh' },
        columns: ['database', 'domain', 'rank', 'organicKeywords', 'organicTraffic', 'organicCost', 'adwordsKeywords', 'adwordsTraffic', 'adwordsCost', 'shareOfVoice'],
        costPerLine: SEMRUSH_UNIT_COST.domain_ranks,
      });
      const row = rows[0];
      if (!row) { console.warn(`Semrush 无流量数据: ${competitor.name}`); continue; }
      const organicTraffic = optionalNumber(row.organicTraffic) || 0;
      const paidTraffic = optionalNumber(row.adwordsTraffic) || 0;
      const visits = Math.round(organicTraffic + paidTraffic);
      const channels = visits ? { organic: round1((organicTraffic / visits) * 100), paid: round1((paidTraffic / visits) * 100) } : { organic: 0, paid: 0 };
      const payload = { visits, channels, countries: [] as any[], socialSources: [] as any[], demo: false };
      // 与 DataForSEO 的行共存（unique 键含 source），用于交叉验证同一月份的两个口径。
      await prisma.trafficSnapshot.upsert({
        where: { competitorId_month_source: { competitorId: competitor.id, month, source: 'semrush' } },
        update: payload,
        create: { competitorId: competitor.id, month, source: 'semrush', ...payload },
      });
      saved++;
      await delay(250);
    } catch (error) { console.warn(`Semrush traffic skipped ${competitor.name}: ${String((error as Error).message)}`); }
  }
  console.log(`Semrush traffic saved: ${saved}/${all.length} competitors (${month}) · 累计消耗 ${semrushSpent} units`);
  if (all.length && saved === 0) throw new Error('Semrush 流量未写入任何数据，请检查 Key 与 units 余额');
}

/** 反链总览（backlinks_overview）：只有总量指标，明细留给 DataForSEO。 */
export async function collectSemrushBacklinks(limit?: number, options?: SemrushOptions) {
  const all = await semrushCompetitors(limit, options);
  if (!all.length) return;
  const spendable = await semrushPrepare('backlinks');
  if (!spendable) throw new Error('Semrush units 不足，已停止反链采集');
  const required = all.length * SEMRUSH_UNIT_COST.backlinks_overview;
  if (spendable < required) {
    console.warn(`Semrush 余额不足以执行 P3 反链总览（需要 ${required} units），跳过该任务，保留已有数据`);
    return;
  }
  const month = semrushMonth();
  let saved = 0;
  for (const competitor of all) {
    if (!semrushCanSpend(spendable, SEMRUSH_UNIT_COST.backlinks_overview)) { console.warn(`已消耗 ${semrushSpent} units，剩余 ${Math.max(0, spendable - semrushSpent)}，停止采集`); break; }
    try {
      const { rows } = await semrushCall({
        type: 'backlinks_overview',
        params: { domain: domainFromUrl(competitor.url), database: semrushDatabase, export_columns: 'total,domains_num,urls_num,follows_num,nofollows_num' },
        columns: ['total', 'domains_num', 'urls_num', 'follows_num', 'nofollows_num'],
        costPerLine: SEMRUSH_UNIT_COST.backlinks_overview,
      });
      const row = rows[0];
      const total = optionalNumber(row?.total);
      if (total === undefined) { console.warn(`Semrush 无反链数据: ${competitor.name}`); continue; }
      const follows = optionalNumber(row?.follows_num) || 0;
      const payload = {
        totalBacklinks: Math.round(total),
        referringDomains: Math.round(optionalNumber(row?.domains_num) || 0),
        referringIps: undefined,
        dofollowRatio: total ? round1((follows / total) * 100) : undefined,
        rank: undefined,
        qualityBreakdown: {} as any,
        topReferrers: [] as any[],
        topAnchors: [] as any[],
        demo: false,
        error: null as string | null,
      };
      await prisma.backlinkSnapshot.upsert({
        where: { competitorId_month_source: { competitorId: competitor.id, month, source: 'semrush' } },
        update: payload,
        create: { competitorId: competitor.id, month, source: 'semrush', ...payload },
      });
      saved++;
      await delay(250);
    } catch (error) { console.warn(`Semrush backlinks skipped ${competitor.name}: ${String((error as Error).message)}`); }
  }
  console.log(`Semrush backlinks saved: ${saved}/${all.length} competitors (${month}) · 累计消耗 ${semrushSpent} units`);
  if (all.length && saved === 0) throw new Error('Semrush 反链未写入任何数据，请检查 Key 与 units 余额');
}
