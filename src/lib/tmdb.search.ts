/* eslint-disable @typescript-eslint/no-explicit-any */

import { HttpsProxyAgent } from 'https-proxy-agent';

export interface TMDBSearchResult {
  id: number;
  title?: string; // 电影
  name?: string; // 电视剧
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  overview: string;
  vote_average: number;
  media_type: 'movie' | 'tv';
}

interface TMDBSearchResponse {
  results: TMDBSearchResult[];
  page: number;
  total_pages: number;
  total_results: number;
}

// 代理 agent 缓存，避免每次都创建新实例
const proxyAgentCache = new Map<string, HttpsProxyAgent<string>>();

/**
 * 获取或创建代理 agent（复用连接池）
 */
function getProxyAgent(proxy: string): HttpsProxyAgent<string> {
  if (!proxyAgentCache.has(proxy)) {
    const agent = new HttpsProxyAgent(proxy, {
      // 增加超时时间
      timeout: 30000, // 30秒
      // 保持连接活跃
      keepAlive: true,
      keepAliveMsecs: 60000, // 60秒
      // 最大空闲连接数
      maxSockets: 10,
      maxFreeSockets: 5,
    });
    proxyAgentCache.set(proxy, agent);
  }
  return proxyAgentCache.get(proxy)!;
}

/**
 * 搜索 TMDB (电影+电视剧)
 */
export async function searchTMDB(
  apiKey: string,
  query: string,
  proxy?: string
): Promise<{ code: number; result: TMDBSearchResult | null }> {
  try {
    if (!apiKey) {
      return { code: 400, result: null };
    }

    // 使用 multi search 同时搜索电影和电视剧
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&language=zh-CN&query=${encodeURIComponent(query)}&page=1`;

    const fetchOptions: any = proxy
      ? {
          agent: getProxyAgent(proxy),
          // 设置请求超时（30秒）
          signal: AbortSignal.timeout(30000),
        }
      : {
          // 即使不用代理也设置超时
          signal: AbortSignal.timeout(15000),
        };

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      console.error('TMDB 搜索失败:', response.status, response.statusText);
      return { code: response.status, result: null };
    }

    const data: TMDBSearchResponse = await response.json();

    // 过滤出电影和电视剧，取第一个结果
    const validResults = data.results.filter(
      (item) => item.media_type === 'movie' || item.media_type === 'tv'
    );

    if (validResults.length === 0) {
      return { code: 404, result: null };
    }

    return {
      code: 200,
      result: validResults[0],
    };
  } catch (error) {
    console.error('TMDB 搜索异常:', error);
    return { code: 500, result: null };
  }
}

/**
 * 获取 TMDB 图片完整 URL
 */
export function getTMDBImageUrl(
  path: string | null,
  size: string = 'w500'
): string {
  if (!path) return '';
  return `https://image.tmdb.org/t/p/${size}${path}`;
}
