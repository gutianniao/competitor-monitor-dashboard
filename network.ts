import net from 'node:net';
import { ProxyAgent as UndiciProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export type ProxySettings = { server: string; username?: string; password?: string };

const rawProxy = process.env.HTTPS_PROXY?.trim();
let proxyUrl: URL | undefined;
if (rawProxy) {
  try { proxyUrl = new URL(rawProxy); }
  catch { console.warn('Ignoring invalid HTTPS_PROXY value; expected http:// or socks5:// URL.'); }
}

export const proxySettings: ProxySettings | undefined = proxyUrl
  ? { server: `${proxyUrl.protocol}//${proxyUrl.hostname}${proxyUrl.port ? `:${proxyUrl.port}` : ''}`, username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) }
  : undefined;
export const proxyUrlString = proxyUrl?.toString();
const isSocks = proxyUrl?.protocol.startsWith('socks');
export const httpAgent = proxyUrlString ? (isSocks ? new SocksProxyAgent(proxyUrlString) : new HttpsProxyAgent(proxyUrlString)) : undefined;
export const httpsAgent = httpAgent;

if (proxyUrlString) {
  setGlobalDispatcher(new UndiciProxyAgent(proxyUrlString));
  console.log(`HTTP proxy enabled: ${proxyUrl?.protocol}//${proxyUrl?.hostname}:${proxyUrl?.port || '(default)'}`);
}

/**
 * 探测 .env 里配置的代理端口是否真的可连接。
 * 很多本地任务（网站抓取 / SEO 审计 / 技术栈检测）目标站可直连，
 * 代理没开时不应让这些任务整体失败，因此启动抓取前做一次快速 TCP 探测。
 * 只缓存成功结果（代理一旦通了就一直用它）；失败则不缓存，允许后续恢复。
 */
let proxyKnownGood = false;
export async function proxyReachable(timeoutMs = 1200): Promise<boolean> {
  if (!proxyUrl) return false;
  if (proxyKnownGood) return true;
  const host = proxyUrl.hostname;
  const port = Number(proxyUrl.port || (proxyUrl.protocol.startsWith('socks') ? 1080 : 8080));
  const ok = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
  if (ok) proxyKnownGood = true;
  return ok;
}

export const proxyLabel = proxySettings?.server;
