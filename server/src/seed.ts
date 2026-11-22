import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './db';

export async function seed() {
  const file = path.resolve(process.cwd(), 'competitors.json');
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log('未找到 competitors.json，已跳过种子导入。可在竞品管理页面添加竞品。');
    return;
  }
  const data = JSON.parse(contents) as { competitors: Array<{name:string;group:'leather'|'latex';url:string;country:string;socials:Record<string,string>}> };
  for (const item of data.competitors) {
    await prisma.competitor.upsert({ where: { name_url: { name: item.name, url: item.url } }, update: {}, create: item });
  }
  console.log(`Seeded ${data.competitors.length} competitors (existing rows preserved).`);
}
if (require.main === module) seed().catch(console.error).finally(() => prisma.$disconnect());
