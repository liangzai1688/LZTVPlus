/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { OpenListClient } from '@/lib/openlist.client';
import {
  getCachedMetaInfo,
  invalidateMetaInfoCache,
  MetaInfo,
  setCachedMetaInfo,
} from '@/lib/openlist-cache';
import { searchTMDB } from '@/lib/tmdb.search';

export const runtime = 'nodejs';

/**
 * POST /api/openlist/refresh
 * 刷新私人影库元数据
 */
export async function POST(request: NextRequest) {
  try {
    // 权限检查
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    // 获取配置
    const config = await getConfig();
    const openListConfig = config.OpenListConfig;

    if (!openListConfig || !openListConfig.URL || !openListConfig.Token) {
      return NextResponse.json(
        { error: 'OpenList 未配置' },
        { status: 400 }
      );
    }

    const tmdbApiKey = config.SiteConfig.TMDBApiKey;
    const tmdbProxy = config.SiteConfig.TMDBProxy;

    if (!tmdbApiKey) {
      return NextResponse.json(
        { error: 'TMDB API Key 未配置' },
        { status: 400 }
      );
    }

    const rootPath = openListConfig.RootPath || '/';
    const client = new OpenListClient(openListConfig.URL, openListConfig.Token);

    console.log('[OpenList Refresh] 开始刷新:', {
      rootPath,
      url: openListConfig.URL,
      hasToken: !!openListConfig.Token,
    });

    // 1. 读取现有 metainfo.json (如果存在)
    let existingMetaInfo: MetaInfo | null = getCachedMetaInfo(rootPath);

    if (!existingMetaInfo) {
      try {
        const metainfoPath = `${rootPath}${rootPath.endsWith('/') ? '' : '/'}metainfo.json`;
        console.log('[OpenList Refresh] 尝试读取现有 metainfo.json:', metainfoPath);

        const fileResponse = await client.getFile(metainfoPath);
        console.log('[OpenList Refresh] getFile 完整响应:', JSON.stringify(fileResponse, null, 2));

        if (fileResponse.code === 200 && fileResponse.data.raw_url) {
          const downloadUrl = fileResponse.data.raw_url;
          console.log('[OpenList Refresh] 下载 URL:', downloadUrl);

          const contentResponse = await fetch(downloadUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
          });

          console.log('[OpenList Refresh] fetch 响应:', {
            status: contentResponse.status,
            ok: contentResponse.ok,
          });

          if (!contentResponse.ok) {
            throw new Error(`下载失败: ${contentResponse.status}`);
          }

          const content = await contentResponse.text();
          console.log('[OpenList Refresh] 文件内容:', {
            length: content.length,
            preview: content.substring(0, 300),
          });

          existingMetaInfo = JSON.parse(content);
          console.log('[OpenList Refresh] 读取到现有数据:', {
            hasfolders: !!existingMetaInfo?.folders,
            foldersType: typeof existingMetaInfo?.folders,
            videoCount: Object.keys(existingMetaInfo?.folders || {}).length,
          });
        }
      } catch (error) {
        console.error('[OpenList Refresh] 读取 metainfo.json 失败:', error);
        console.log('[OpenList Refresh] 将创建新文件');
      }
    } else {
      console.log('[OpenList Refresh] 使用缓存的 metainfo，视频数:', Object.keys(existingMetaInfo.folders).length);
    }

    const metaInfo: MetaInfo = existingMetaInfo || {
      folders: {},
      last_refresh: Date.now(),
    };

    // 确保 folders 对象存在
    if (!metaInfo.folders || typeof metaInfo.folders !== 'object') {
      console.warn('[OpenList Refresh] metaInfo.folders 无效，重新初始化');
      metaInfo.folders = {};
    }

    console.log('[OpenList Refresh] metaInfo 初始化完成:', {
      hasfolders: !!metaInfo.folders,
      foldersType: typeof metaInfo.folders,
      videoCount: Object.keys(metaInfo.folders).length,
    });

    // 2. 列出根目录下的所有文件夹
    const listResponse = await client.listDirectory(rootPath);

    if (listResponse.code !== 200) {
      return NextResponse.json(
        { error: 'OpenList 列表获取失败' },
        { status: 500 }
      );
    }

    const folders = listResponse.data.content.filter((item) => item.is_dir);

    console.log('[OpenList Refresh] 找到文件夹:', {
      total: folders.length,
      names: folders.map(f => f.name),
    });

    // 3. 遍历文件夹，搜索 TMDB
    let newCount = 0;
    let errorCount = 0;

    for (const folder of folders) {
      console.log('[OpenList Refresh] 处理文件夹:', folder.name);

      // 跳过已搜索过的文件夹
      if (metaInfo.folders[folder.name]) {
        console.log('[OpenList Refresh] 跳过已存在的文件夹:', folder.name);
        continue;
      }

      try {
        console.log('[OpenList Refresh] 搜索 TMDB:', folder.name);
        // 搜索 TMDB
        const searchResult = await searchTMDB(
          tmdbApiKey,
          folder.name,
          tmdbProxy
        );

        console.log('[OpenList Refresh] TMDB 搜索结果:', {
          folder: folder.name,
          code: searchResult.code,
          hasResult: !!searchResult.result,
        });

        if (searchResult.code === 200 && searchResult.result) {
          const result = searchResult.result;

          metaInfo.folders[folder.name] = {
            tmdb_id: result.id,
            title: result.title || result.name || folder.name,
            poster_path: result.poster_path,
            release_date: result.release_date || result.first_air_date || '',
            overview: result.overview,
            vote_average: result.vote_average,
            media_type: result.media_type,
            last_updated: Date.now(),
          };

          console.log('[OpenList Refresh] 添加成功:', {
            folder: folder.name,
            title: metaInfo.folders[folder.name].title,
          });

          newCount++;
        } else {
          console.warn(`[OpenList Refresh] TMDB 搜索失败: ${folder.name}`);
          errorCount++;
        }

        // 避免请求过快
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`[OpenList Refresh] 处理文件夹失败: ${folder.name}`, error);
        errorCount++;
      }
    }

    // 4. 更新 metainfo.json
    metaInfo.last_refresh = Date.now();

    const metainfoPath = `${rootPath}${rootPath.endsWith('/') ? '' : '/'}metainfo.json`;
    const metainfoContent = JSON.stringify(metaInfo, null, 2);
    console.log('[OpenList Refresh] 上传 metainfo.json:', {
      path: metainfoPath,
      videoCount: Object.keys(metaInfo.folders).length,
      contentLength: metainfoContent.length,
      contentPreview: metainfoContent.substring(0, 300),
    });

    await client.uploadFile(metainfoPath, metainfoContent);
    console.log('[OpenList Refresh] 上传成功');

    // 验证上传：立即读取文件
    try {
      console.log('[OpenList Refresh] 验证上传：读取文件');
      const verifyResponse = await client.getFile(metainfoPath);
      if (verifyResponse.code === 200 && verifyResponse.data.raw_url) {
        const downloadUrl = verifyResponse.data.raw_url;
        const verifyContentResponse = await fetch(downloadUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });
        const verifyContent = await verifyContentResponse.text();
        console.log('[OpenList Refresh] 验证读取成功:', {
          contentLength: verifyContent.length,
          contentPreview: verifyContent.substring(0, 300),
        });

        // 尝试解析
        const verifyParsed = JSON.parse(verifyContent);
        console.log('[OpenList Refresh] 验证解析成功:', {
          hasfolders: !!verifyParsed.folders,
          foldersType: typeof verifyParsed.folders,
          videoCount: Object.keys(verifyParsed.folders || {}).length,
        });
      }
    } catch (verifyError) {
      console.error('[OpenList Refresh] 验证失败:', verifyError);
    }

    // 5. 更新缓存
    invalidateMetaInfoCache(rootPath);
    setCachedMetaInfo(rootPath, metaInfo);
    console.log('[OpenList Refresh] 缓存已更新');

    // 6. 更新配置
    config.OpenListConfig!.LastRefreshTime = Date.now();
    config.OpenListConfig!.ResourceCount = Object.keys(metaInfo.folders).length;
    await db.saveAdminConfig(config);

    return NextResponse.json({
      success: true,
      total: folders.length,
      new: newCount,
      existing: Object.keys(metaInfo.folders).length - newCount,
      errors: errorCount,
      last_refresh: metaInfo.last_refresh,
    });
  } catch (error) {
    console.error('刷新私人影库失败:', error);
    return NextResponse.json(
      { error: '刷新失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
