/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenListFile {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  sign?: string; // 临时下载签名
  raw_url?: string; // 完整下载链接
  thumb?: string;
  type: number;
  path?: string;
}

export interface OpenListListResponse {
  code: number;
  message: string;
  data: {
    content: OpenListFile[];
    total: number;
    readme: string;
    write: boolean;
  };
}

export interface OpenListGetResponse {
  code: number;
  message: string;
  data: OpenListFile;
}

export class OpenListClient {
  constructor(
    private baseURL: string,
    private token: string
  ) {}

  private getHeaders() {
    return {
      Authorization: this.token, // 不带 bearer
      'Content-Type': 'application/json',
    };
  }

  // 列出目录
  async listDirectory(
    path: string,
    page = 1,
    perPage = 100
  ): Promise<OpenListListResponse> {
    const response = await fetch(`${this.baseURL}/api/fs/list`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        path,
        password: '',
        refresh: false,
        page,
        per_page: perPage,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList API 错误: ${response.status}`);
    }

    return response.json();
  }

  // 获取文件信息
  async getFile(path: string): Promise<OpenListGetResponse> {
    const response = await fetch(`${this.baseURL}/api/fs/get`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        path,
        password: '',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList API 错误: ${response.status}`);
    }

    return response.json();
  }

  // 上传文件
  async uploadFile(path: string, content: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/fs/put`, {
      method: 'PUT',
      headers: {
        Authorization: this.token,
        'Content-Type': 'text/plain; charset=utf-8',
        'File-Path': encodeURIComponent(path),
        'As-Task': 'false',
      },
      body: content,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenList 上传失败: ${response.status} - ${errorText}`);
    }
  }

  // 删除文件
  async deleteFile(path: string): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf('/')) || '/';
    const fileName = path.substring(path.lastIndexOf('/') + 1);

    const response = await fetch(`${this.baseURL}/api/fs/remove`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        names: [fileName],
        dir: dir,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenList 删除失败: ${response.status}`);
    }
  }
}
