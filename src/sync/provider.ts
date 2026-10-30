export interface SyncProvider {
  name: string;
  test(): Promise<{ ok: boolean; message: string }>;
  pull(): Promise<string>;
  push(encryptedBlob: string): Promise<{ remoteId?: string }>;
}

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  filename?: string;
}

export interface GistConfig {
  token: string;
  gistId?: string;
  description?: string;
}

/**
 * WebDAV Provider (compatible with Jianguoyun, Nextcloud, ownCloud, Synology, Alist, etc.)
 */
export class WebDavProvider implements SyncProvider {
  public name = 'webdav';
  private baseUrl: string;
  private authHeader: string;
  private filename: string;

  constructor(private config: WebDavConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.filename = config.filename || 'hosts.enc';
    const authString = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    this.authHeader = `Basic ${authString}`;
  }

  private get fileUrl(): string {
    return `${this.baseUrl}/${this.filename}`;
  }

  public async test(): Promise<{ ok: boolean; message: string }> {
    try {
      // Test base directory access (PROPFIND or HEAD or GET)
      const res = await fetch(this.baseUrl, {
        method: 'PROPFIND',
        headers: {
          Authorization: this.authHeader,
          Depth: '0'
        }
      });

      if (res.status === 207 || res.status === 200 || res.status === 404) {
        return { ok: true, message: `Connected to WebDAV server (${res.status})` };
      }

      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `WebDAV authentication failed (${res.status} Unauthorized/Forbidden)` };
      }

      // Try GET as fallback if PROPFIND is disallowed
      const getRes = await fetch(this.baseUrl, {
        method: 'GET',
        headers: { Authorization: this.authHeader }
      });
      if (getRes.status < 400 || getRes.status === 404) {
        return { ok: true, message: `Connected to WebDAV endpoint (${getRes.status})` };
      }

      return { ok: false, message: `WebDAV returned status ${res.status} ${res.statusText}` };
    } catch (err: any) {
      return { ok: false, message: `WebDAV connection error: ${err.message || String(err)}` };
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await fetch(this.baseUrl, {
        method: 'MKCOL',
        headers: { Authorization: this.authHeader }
      });
    } catch {
      // Ignore MKCOL error if directory already exists
    }
  }

  public async pull(): Promise<string> {
    const res = await fetch(this.fileUrl, {
      method: 'GET',
      headers: { Authorization: this.authHeader }
    });

    if (res.status === 404) {
      throw new Error(`Remote file not found at ${this.fileUrl}. Please push your hosts first.`);
    }

    if (!res.ok) {
      throw new Error(`WebDAV pull failed with status ${res.status}: ${res.statusText}`);
    }

    return await res.text();
  }

  public async push(encryptedBlob: string): Promise<{ remoteId?: string }> {
    await this.ensureDirectory();

    const res = await fetch(this.fileUrl, {
      method: 'PUT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: encryptedBlob
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV push failed with status ${res.status}: ${res.statusText}`);
    }

    return { remoteId: this.fileUrl };
  }
}

/**
 * GitHub Secret Gist Provider
 */
export class GistProvider implements SyncProvider {
  public name = 'gist';
  private static GIST_FILENAME = 'sshx-hosts.enc';

  constructor(private config: GistConfig) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sshx-client'
    };
  }

  public async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: this.headers
      });

      if (res.status === 200) {
        const user = await res.json() as { login?: string };
        return { ok: true, message: `Authenticated as GitHub user @${user.login || 'user'}` };
      }

      if (res.status === 401) {
        return { ok: false, message: 'GitHub token is invalid or expired (401 Unauthorized)' };
      }

      return { ok: false, message: `GitHub API error: ${res.status} ${res.statusText}` };
    } catch (err: any) {
      return { ok: false, message: `GitHub connection failed: ${err.message || String(err)}` };
    }
  }

  public async pull(): Promise<string> {
    let gistId = this.config.gistId;

    if (!gistId) {
      // Look up existing secret gist created by sshx
      gistId = await this.findSshxGistId();
      if (!gistId) {
        throw new Error('No sshx sync Gist found on your GitHub account. Please push first to create one.');
      }
      this.config.gistId = gistId;
    }

    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: this.headers
    });

    if (res.status === 404) {
      throw new Error(`Gist ${gistId} not found. Please verify your gistId or push again.`);
    }

    if (!res.ok) {
      throw new Error(`Gist pull failed (${res.status} ${res.statusText})`);
    }

    const data = await res.json() as any;
    const file = data.files?.[GistProvider.GIST_FILENAME];
    if (!file || !file.content) {
      throw new Error(`Gist does not contain '${GistProvider.GIST_FILENAME}'.`);
    }

    return file.content;
  }

  public async push(encryptedBlob: string): Promise<{ remoteId?: string }> {
    let gistId = this.config.gistId;

    if (!gistId) {
      gistId = await this.findSshxGistId();
    }

    const description = this.config.description || 'sshx encrypted host profiles backup (E2EE)';

    if (gistId) {
      // Update existing Gist
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({
          description,
          files: {
            [GistProvider.GIST_FILENAME]: { content: encryptedBlob }
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to update Gist ${gistId} (${res.status} ${res.statusText})`);
      }

      this.config.gistId = gistId;
      return { remoteId: gistId };
    } else {
      // Create new secret Gist
      const res = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          description,
          public: false,
          files: {
            [GistProvider.GIST_FILENAME]: { content: encryptedBlob }
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Failed to create secret Gist (${res.status} ${res.statusText})`);
      }

      const created = await res.json() as any;
      this.config.gistId = created.id;
      return { remoteId: created.id };
    }
  }

  private async findSshxGistId(): Promise<string | undefined> {
    try {
      const res = await fetch('https://api.github.com/gists?per_page=50', {
        headers: this.headers
      });
      if (!res.ok) return undefined;

      const gists = await res.json() as any[];
      for (const g of gists) {
        if (g.files && g.files[GistProvider.GIST_FILENAME]) {
          return g.id;
        }
      }
    } catch {
      // fallback
    }
    return undefined;
  }
}
