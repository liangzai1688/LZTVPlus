/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { OpenListClient } from '@/lib/openlist.client';
import {
  getCachedMetaInfo,
  MetaInfo,
  setCachedMetaInfo,
} from '@/lib/openlist-cache';
import { getTMDBImageUrl } from '@/lib/tmdb.search';

export const runtime = 'nodejs';

/**
 * GET /api/openlist/list?page=1&pageSize=20
 * 获取私人影库视频列表
 */
export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');

    const config = await getConfig();
    const openListConfig = config.OpenListConfig;

    if (!openListConfig || !openListConfig.URL || !openListConfig.Token) {
      return NextResponse.json(
        { error: 'OpenList 未配置', list: [], total: 0 },
        { status: 200 }
      );
    }

    const rootPath = openListConfig.RootPath || '/';
    const client = new OpenListClient(openListConfig.URL, openListConfig.Token);

    // 读取 metainfo.json
    let metaInfo: MetaInfo | null = getCachedMetaInfo(rootPath);

    console.log('[OpenList List] 缓存检查:', {
      rootPath,
      hasCachedMetaInfo: !!metaInfo,
    });

    if (!metaInfo) {
      try {
        const metainfoPath = `${rootPath}${rootPath.endsWith('/') ? '' : '/'}metainfo.json`;
        console.log('[OpenList List] 尝试读取 metainfo.json:', metainfoPath);

        const fileResponse = await client.getFile(metainfoPath);
        console.log('[OpenList List] getFile 完整响应:', JSON.stringify(fileResponse, null, 2));

        if (fileResponse.code === 200 && fileResponse.data.raw_url) {
          console.log('[OpenList List] 使用 raw_url 获取文件内容');

          const downloadUrl = fileResponse.data.raw_url;
          console.log('[OpenList List] 下载 URL:', downloadUrl);

          const contentResponse = await fetch(downloadUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
          });
          console.log('[OpenList List] fetch 响应:', {
            status: contentResponse.status,
            ok: contentResponse.ok,
          });

          if (!contentResponse.ok) {
            throw new Error(`获取文件内容失败: ${contentResponse.status}`);
          }

          const content = await contentResponse.text();
          console.log('[OpenList List] 文件内容长度:', content.length);
          console.log('[OpenList List] 文件内容预览:', content.substring(0, 200));

          try {
            metaInfo = JSON.parse(content);
            console.log('[OpenList List] JSON 解析成功');
            console.log('[OpenList List] metaInfo 结构:', {
              hasfolders: !!metaInfo?.folders,
              foldersType: typeof metaInfo?.folders,
              keys: metaInfo?.folders ? Object.keys(metaInfo.folders) : [],
            });

            // 验证数据结构
            if (!metaInfo || typeof metaInfo !== 'object') {
              throw new Error('metaInfo 不是有效对象');
            }
            if (!metaInfo.folders || typeof metaInfo.folders !== 'object') {
              throw new Error('metaInfo.folders 不存在或不是对象');
            }

            console.log('[OpenList List] 解析成功，视频数量:', Object.keys(metaInfo.folders).length);
            setCachedMetaInfo(rootPath, metaInfo);
          } catch (parseError) {
            console.error('[OpenList List] JSON 解析或验证失败:', parseError);
            throw new Error(`JSON 解析失败: ${(parseError as Error).message}`);
          }
        } else {
          console.error('[OpenList List] getFile 失败或无 sign:', {
            code: fileResponse.code,
            message: fileResponse.message,
            data: fileResponse.data,
          });
          throw new Error(`getFile 返回错误: code=${fileResponse.code}, message=${fileResponse.message}`);
        }
      } catch (error) {
        console.error('[OpenList List] 读取 metainfo.json 失败:', error);
        return NextResponse.json(
          {
            error: 'metainfo.json 读取失败',
            details: (error as Error).message,
            list: [],
            total: 0,
          },
          { status: 200 }
        );
      }
    }

    if (!metaInfo) {
      console.error('[OpenList List] metaInfo 为 null');
      return NextResponse.json(
        { error: '无数据', list: [], total: 0 },
        { status: 200 }
      );
    }

    // 验证 metaInfo 结构
    if (!metaInfo.folders || typeof metaInfo.folders !== 'object') {
      console.error('[OpenList List] metaInfo.folders 无效:', {
        hasfolders: !!metaInfo.folders,
        foldersType: typeof metaInfo.folders,
        metaInfoKeys: Object.keys(metaInfo),
      });
      return NextResponse.json(
        { error: 'metainfo.json 结构无效', list: [], total: 0 },
        { status: 200 }
      );
    }

    console.log('[OpenList List] 开始转换视频列表，视频数:', Object.keys(metaInfo.folders).length);

    // 转换为数组并分页
    const allVideos = Object.entries(metaInfo.folders).map(
      ([folderName, info]) => ({
        id: folderName,
        folder: folderName,
        title: info.title,
        poster: getTMDBImageUrl(info.poster_path),
        releaseDate: info.release_date,
        overview: info.overview,
        voteAverage: info.vote_average,
        mediaType: info.media_type,
        lastUpdated: info.last_updated,
      })
    );

    // 按更新时间倒序排序
    allVideos.sort((a, b) => b.lastUpdated - a.lastUpdated);

    const total = allVideos.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const list = allVideos.slice(start, end);

    return NextResponse.json({
      success: true,
      list,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('获取视频列表失败:', error);
    return NextResponse.json(
      { error: '获取失败', details: (error as Error).message, list: [], total: 0 },
      { status: 500 }
    );
  }
}
