import './env';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { prisma } from './db';
import { crawlAll, collectSocials, collectTraffic, collectTechAndAds, collectBacklinks, collectSeo, collectKeywords, collectSemrushKeywords, collectSemrushTraffic, collectSemrushBacklinks, collectOutreach, syncOutreachSheets, updateOutreachStatus, outreachEmail, checkOutreachLinks, semrushState, semrushBalance } from './collector';
import { execSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app=express(); app.use(cors({origin:process.env.FRONTEND_ORIGIN||true})); app.use(express.json());
const port=Number(process.env.PORT||4000);
const serialise=(x:any)=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?Number(v):v));

app.get('/api/health',(_,res)=>res.json({ok:true,demo:process.env.DEMO_MODE==='true'}));
app.get('/api/competitors',async(req,res)=>{
  const group=req.query.group as any;
  const rows=await prisma.competitor.findMany({where:group?{group}:undefined,include:{snapshots:{orderBy:{capturedAt:'desc'},take:100},changes:{where:{detectedAt:{gte:new Date(Date.now()-72*3600000)}},orderBy:{detectedAt:'desc'}},socialSnapshots:{orderBy:{capturedAt:'desc'},take:50},techSnapshots:{orderBy:{capturedAt:'desc'},take:1},ads:{orderBy:{capturedAt:'desc'},take:1}}});
  // The relation is intentionally limited above. Replace it with one latest row
  // per configured platform so old daily snapshots cannot crowd out a platform.
  const ids=rows.map(row=>row.id);
  const social=ids.length?await prisma.socialSnapshot.findMany({where:{competitorId:{in:ids}},orderBy:{capturedAt:'desc'}}):[];
  const latest=new Map<string,typeof social[number]>();
  for(const item of social){ const key=`${item.competitorId}:${item.platform}`; if(!latest.has(key)) latest.set(key,item); }
  for(const row of rows){
    const configured=Object.keys((row.socials||{}) as Record<string,string>).filter(platform=>Boolean(((row.socials||{}) as Record<string,string>)[platform]));
    row.socialSnapshots=configured.map(platform=>latest.get(`${row.id}:${platform}`)||{
      id:`pending-${row.id}-${platform}`, competitorId:row.id, platform, followers:null,
      totalViews:null, recentVideos:null, title:null, status:'unavailable', capturedAt:null,
    }) as any;
  }
  res.json(serialise(rows));
});
app.get('/api/changes',async(req,res)=>{ const hours=Number(req.query.hours||72); res.json(serialise(await prisma.change.findMany({where:{detectedAt:{gte:new Date(Date.now()-hours*3600000)}},include:{competitor:true},orderBy:{detectedAt:'desc'},take:300}))); });
app.get('/api/traffic',async(req,res)=>{ const rows=await prisma.trafficSnapshot.findMany({include:{competitor:true},orderBy:{month:'desc'},take:500}); res.json(serialise(rows)); });
app.get('/api/backlinks',async(req,res)=>{
  const group=req.query.group as any;
  const competitors=await prisma.competitor.findMany({where:group?{group}:undefined,include:{backlinkSnapshots:{orderBy:{capturedAt:'desc'},take:4}}});
  // 每个数据源各留最新一条，Semrush 的当月总览与 DataForSEO 的月度明细并列展示。
  const payload=competitors.flatMap(competitor=>{const seen=new Set<string>(); return competitor.backlinkSnapshots.filter(snapshot=>{const source=snapshot.source||'dataforseo'; if(seen.has(source))return false; seen.add(source); return true;}).map(snapshot=>({...snapshot,competitor}));});
  res.json(serialise(payload));
});
app.get('/api/outreach',async(req,res)=>{
  const group=typeof req.query.group==='string'?req.query.group:undefined;
  const tier=typeof req.query.tier==='string'?req.query.tier:undefined;
  const status=typeof req.query.status==='string'?req.query.status:undefined;
  const minDr=Number(req.query.minDr||0); const dofollow=req.query.dofollow==='true';
  const competitors=await prisma.competitor.findMany({select:{id:true,group:true}}); const groups=new Map(competitors.map(item=>[item.id,item.group]));
  const all=await prisma.outreachProspect.findMany({include:{links:true},orderBy:[{qualityScore:'desc'},{capturedAt:'desc'}]});
  const rows=all.filter(row=>{const refs=Array.isArray(row.competitors)?row.competitors:[];const inGroup=!group||refs.some((ref:any)=>groups.get(Number(typeof ref==='object'?ref.id:ref))===group);return (!tier||row.tier===tier)&&(!status||row.status===status)&&(!minDr||Number(row.rank||0)>=minDr)&&(!dofollow||row.dofollow)&&inGroup;});
  const lastSync=all.map(row=>row.sheetsSyncAt).filter(Boolean).sort().reverse()[0]||null; const syncError=all.find(row=>row.sheetsSyncError)?.sheetsSyncError||null; const syncRows=lastSync?all.find(row=>row.sheetsSyncAt&&new Date(row.sheetsSyncAt).getTime()===new Date(lastSync).getTime())?.sheetsSyncRows||0:0;
  res.json(serialise({rows,stats:{total:rows.length,high:rows.filter(row=>row.tier==='high').length,placed:rows.filter(row=>row.status==='placed').length,dead:rows.filter(row=>row.status==='dead'||row.links.some(link=>!link.alive)).length},sheets:{lastSync,rows:syncRows,error:syncError}}));
});
app.post('/api/outreach/collect',(req,res)=>launchJob('outreach',parseLimit(req.query.limit),{},'outreach',res));
app.post('/api/outreach/sync-sheets',async(_,res)=>{try{res.json(await syncOutreachSheets());}catch(error){res.status(400).json({error:String((error as Error).message)});}});
app.post('/api/outreach/:id/status',async(req,res)=>{try{res.json(serialise(await updateOutreachStatus(Number(req.params.id),String(req.body?.status||''),req.body?.note)));}catch(error){res.status(400).json({error:String((error as Error).message)});}});
app.get('/api/outreach/:id/email',async(req,res)=>{try{res.json(await outreachEmail(Number(req.params.id)));}catch(error){res.status(404).json({error:String((error as Error).message)});}});
app.post('/api/outreach/check-links',async(_,res)=>{try{res.json(await checkOutreachLinks());}catch(error){res.status(400).json({error:String((error as Error).message)});}});
app.get('/api/seo',async(req,res)=>{
  const group=req.query.group as any;
  const competitors=await prisma.competitor.findMany({where:group?{group}:undefined,include:{seoReports:{orderBy:{capturedAt:'desc'},take:1}}});
  const payload=competitors.flatMap(competitor=>competitor.seoReports.map(report=>({...report,competitor})));
  res.json(serialise(payload));
});
app.get('/api/schema',async(req,res)=>{
  const group=req.query.group as any;
  const competitors=await prisma.competitor.findMany({where:group?{group}:undefined,include:{schemaSnapshots:{orderBy:{capturedAt:'desc'},take:20}}});
  const latest=new Map<string,any>();
  for(const competitor of competitors) for(const snapshot of competitor.schemaSnapshots){ const key=`${competitor.id}:${snapshot.pageType}`; if(!latest.has(key)) latest.set(key,{...snapshot,competitor}); }
  const rows=competitors.flatMap(competitor=>{
    const snapshots=[...latest.values()].filter(row=>row.competitorId===competitor.id);
    return snapshots.length?snapshots:[{id:`pending-${competitor.id}`,competitorId:competitor.id,pageType:'home',url:competitor.url,schemaTypes:[],productSchemaDetail:[],capturedAt:null,competitor}];
  });
  res.json(serialise(rows));
});
app.get('/api/keywords',async(req,res)=>{
  const group=req.query.group as any;
  const type=(req.query.type as string)==='paid'?'paid':'organic';
  const competitors=await prisma.competitor.findMany({where:group?{group}:undefined,include:{keywordSnapshots:{where:{isOpportunity:false},orderBy:[{etv:'desc'},{searchVolume:'desc'}],take:800}}});
  // 两个数据源都可能有同一竞品的关键词：Semrush 词库更大，存在时优先展示；
  // 完全没有 Semrush 数据的竞品回退到 DataForSEO 的行，避免出现空白。
  const rows=competitors.flatMap(competitor=>{
    const all=competitor.keywordSnapshots.filter(row=>row.type===type);
    const sources=new Set(all.map(row=>row.source||'dataforseo'));
    const preferred=sources.has('semrush')?'semrush':sources.has('dataforseo')?'dataforseo':null;
    return all.filter(row=>(row.source||'dataforseo')===preferred).slice(0,100).map(keyword=>({...keyword,competitor}));
  });
  const opportunities=await prisma.keywordSnapshot.findMany({where:{isOpportunity:true,opportunityGroup:group||undefined},include:{competitor:true},orderBy:{etv:'desc'},take:200});
  const competitorStatus=competitors.map(competitor=>({
    id:competitor.id,
    name:competitor.name,
    hasPaidKeywords:competitor.keywordSnapshots.some(row=>row.type==='paid'),
    hasSemrushPaidKeywords:competitor.keywordSnapshots.some(row=>row.type==='paid'&&row.source==='semrush'),
  }));
  res.json(serialise({rows,opportunities,type,competitors:competitorStatus}));
});
app.get('/api/semrush/status',async(_,res)=>{
  let balance:number|null=null; let error:string|null=null;
  try { balance=await semrushBalance(); } catch(e){ error=String((e as Error).message); }
  const state=semrushState();
  res.json({...state,balance,remainingUnits:balance===null?null:Math.max(0,balance-state.spent),error});
});
app.get('/api/semrush/balance',async(_,res)=>{
  let balance:number|null=null; let error:string|null=null;
  try { balance=await semrushBalance(); } catch(e){ error=String((e as Error).message); }
  const state=semrushState();
  res.json({...state,balance,remainingUnits:balance===null?null:Math.max(0,balance-state.spent),error});
});
app.get('/api/revenue',async(req,res)=>{
  const conversion=Number(req.query.conversion||0.015);
  const rate=Number.isFinite(conversion)&&conversion>0?conversion:0.015;
  const competitors=await prisma.competitor.findMany({include:{trafficSnapshots:{orderBy:[{month:'desc'},{source:'asc'}],take:4},snapshots:{where:{pageType:'products',priceMin:{not:null},priceMax:{not:null}},orderBy:{capturedAt:'desc'},take:500}}});
  const pricesByGroup=new Map<string,number[]>();
  for(const competitor of competitors){ const prices=competitor.snapshots.flatMap(snapshot=>[snapshot.priceMin,snapshot.priceMax]).filter((price):price is number=>typeof price==='number'&&price>0); pricesByGroup.set(competitor.group,[...(pricesByGroup.get(competitor.group)||[]),...prices]); }
  const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b); if(!sorted.length)return null; const middle=Math.floor(sorted.length/2); return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
  const trimmedMedian=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b); if(sorted.length<3)return median(sorted); const trim=Math.floor(sorted.length*.05); return median(sorted.slice(trim,Math.max(trim+1,sorted.length-trim)));};
  const fallback=new Map([...pricesByGroup.entries()].map(([group,prices])=>[group,trimmedMedian(prices)]));
  const rows=competitors.map(competitor=>{const direct=competitor.snapshots.flatMap(snapshot=>[snapshot.priceMin,snapshot.priceMax]).filter((price):price is number=>typeof price==='number'&&price>0); const average=trimmedMedian(direct); const averagePrice=average??fallback.get(competitor.group)??0; const visits=competitor.trafficSnapshots[0]?.visits||0; return {competitor,month:competitor.trafficSnapshots[0]?.month||null,visits,conversionRate:rate,averagePrice,priceFallback:average===null,revenue:visits*rate*averagePrice,annualRevenue:visits*rate*averagePrice*12};});
  res.json(serialise({conversionRate:rate,rows:rows.sort((a,b)=>b.revenue-a.revenue)}));
});
app.get('/api/social',async(_,res)=>{
  const competitors=await prisma.competitor.findMany({orderBy:{name:'asc'}});
  const ids=competitors.map(c=>c.id);
  const snapshots=ids.length?await prisma.socialSnapshot.findMany({where:{competitorId:{in:ids}},include:{competitor:true},orderBy:{capturedAt:'desc'}}):[];
  const latest=new Map<string,typeof snapshots[number]>();
  for(const item of snapshots){ const key=`${item.competitorId}:${item.platform}`; if(!latest.has(key)) latest.set(key,item); }
  // Include configured links which have not completed a collection yet. This
  // makes missing data explicit instead of making the competitor disappear.
  const rows:any[]=[];
  for(const competitor of competitors){
    const socials=(competitor.socials||{}) as Record<string,string>;
    for(const platform of Object.keys(socials).filter(key=>socials[key])){
      const item=latest.get(`${competitor.id}:${platform}`);
      rows.push(item||{id:`pending-${competitor.id}-${platform}`,competitorId:competitor.id,platform,followers:null,totalViews:null,recentVideos:null,title:null,status:'unavailable',capturedAt:null,competitor});
    }
  }
  res.json(serialise(rows));
});
app.post('/api/competitors',async(req,res)=>{ try { res.status(201).json(serialise(await prisma.competitor.create({data:req.body}))); } catch(e){res.status(400).json({error:String(e)})} });
app.put('/api/competitors/:id',async(req,res)=>{ res.json(serialise(await prisma.competitor.update({where:{id:Number(req.params.id)},data:req.body}))); });
app.delete('/api/competitors/:id',async(req,res)=>{ await prisma.competitor.delete({where:{id:Number(req.params.id)}}); res.status(204).end(); });

type JobState = { running:boolean; startedAt?:string; finishedAt?:string; error?:string; limit?:number };
const jobs: Record<string, (limit?:number, options?:any)=>Promise<unknown>> = { crawl: crawlAll, social: collectSocials, traffic: collectTraffic, tech: collectTechAndAds, backlinks: collectBacklinks, outreach: collectOutreach, seo: collectSeo, keywords: collectKeywords, semrushKeywords: collectSemrushKeywords, semrushTraffic: collectSemrushTraffic, semrushBacklinks: collectSemrushBacklinks };
const jobState: Record<string, JobState> = { crawl:{running:false}, social:{running:false}, traffic:{running:false}, tech:{running:false}, backlinks:{running:false}, outreach:{running:false}, seo:{running:false}, keywords:{running:false}, semrushKeywords:{running:false}, semrushTraffic:{running:false}, semrushBacklinks:{running:false} };
app.get('/api/collect/status',(_,res)=>res.json(serialise(jobState)));
function parseLimit(value:unknown) {
  const parsed=Number(value);
  return Number.isFinite(parsed)&&parsed>0?Math.floor(parsed):undefined;
}
function parseCompetitorIds(value:unknown) {
  if(typeof value!=='string'||!value.trim()) return undefined;
  const ids=value.split(',').map(item=>Number(item.trim())).filter(item=>Number.isInteger(item)&&item>0);
  return ids.length?ids:undefined;
}
function launchJob(name:string, limit:number|undefined, options:any, responseJob:string, res:any) {
  const job=jobs[name];
  if(!job) return res.status(404).json({error:'unknown job',available:Object.keys(jobs)});
  if(jobState[name].running) return res.status(409).json({error:'job already running',job:responseJob});
  jobState[name]={running:true,startedAt:new Date().toISOString(),limit};
  job(limit,options)
    .then(()=>{ jobState[name]={...jobState[name],running:false,finishedAt:new Date().toISOString()}; console.log(`Manual job finished: ${name}`); })
    .catch((e:any)=>{ jobState[name]={...jobState[name],running:false,finishedAt:new Date().toISOString(),error:String(e?.message||e)}; console.error(`Manual job failed: ${name}`,e); });
  return res.status(202).json({ok:true,job:responseJob,limit:limit??null,competitorIds:options?.competitorIds??null,status:'running'});
}

// Semrush 的公开手动入口使用用户文档中的路径；保留 camelCase 任务名作为兼容别名。
for (const [route, name] of [['keywords','semrushKeywords'],['traffic','semrushTraffic'],['backlinks','semrushBacklinks']]) {
  app.post(`/api/collect/semrush/${route}`,(req,res)=>launchJob(name,parseLimit(req.query.limit),{competitorIds:parseCompetitorIds(req.query.competitorIds)},`semrush/${route}`,res));
}
app.post('/api/collect/:job',(req,res)=>{
  const name=req.params.job;
  const limit=parseLimit(req.query.limit);
  const options={countries:req.query.countries!=='0',competitorIds:parseCompetitorIds(req.query.competitorIds)};
  return launchJob(name,limit,options,name,res);
});

const clientDist = path.resolve(process.cwd(), 'client/dist');
const clientIndex = path.join(clientDist, 'index.html');
if (existsSync(clientIndex)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api(?:\/|$)).*$/, (_, res) => res.sendFile(clientIndex));
}

async function init(){
  const databaseUrl = process.env.DATABASE_URL;
  if (process.platform === 'win32' && databaseUrl?.startsWith('file:')) {
    // Prisma on Windows can fail to initialize a SQLite file that does not exist yet.
    const filename = decodeURIComponent(databaseUrl.slice(5).split('?')[0]);
    if (filename && filename !== ':memory:') {
      const databasePath = filename.startsWith('//')
        ? fileURLToPath(databaseUrl)
        : path.resolve('server/prisma', filename);
      mkdirSync(path.dirname(databasePath), { recursive: true });
      closeSync(openSync(databasePath, 'a'));
    }
  }
  execSync('npx prisma db push --schema server/prisma/schema.prisma',{stdio:'inherit'});
  const {seed}=await import('./seed'); await seed();
  // Older runs used status=ok with a null follower count. Normalize those
  // records once so historical failures are also shown as unavailable.
  await prisma.socialSnapshot.updateMany({where:{followers:null,status:'ok'},data:{status:'unavailable'}});
}
function registerJobs(){ const jobs=[['0 */6 * * *','website crawl',crawlAll],['0 2 * * *','social snapshots',collectSocials],['0 4 1 * *','traffic snapshot',collectTraffic],['30 4 1 * *','backlink snapshot',collectBacklinks],['50 4 1 * *','outreach opportunities',collectOutreach],['0 5 1 * *','keyword snapshot',collectKeywords],['0 5 * * 0','tech and ads',collectTechAndAds],['30 5 * * 0','SEO audit',collectSeo],['0 6 * * 0','outreach link checks',checkOutreachLinks]] as const; console.log('Scheduled jobs:'); for(const [spec,name,fn] of jobs){ console.log(`- ${name}: ${spec}`); cron.schedule(spec,()=>fn().catch(console.error)); } }
init().then(()=>{registerJobs(); app.listen(port,()=>console.log(`API listening on http://localhost:${port}`));});
