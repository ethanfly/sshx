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

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * WebDAV Provider (compatible with Jianguoyun, Nextcloud, ownCloud, Synology, Alist, etc.)
 */
export class WebDavProvider implements SyncProvider {
  public name = 'webdav';
  private baseUrl: string;
  private authHeader: string;
  private filename: string;

  constructor(private config: WebDavConfig, private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.filename = config.filename || 'hosts.enc';
    const authString = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    this.authHeader = `Basic ${authString}`;
  }

  private get fileUrl(): string {
    return `${this.baseUrl}/${this.filename}`;
  }

  private request(input: string | URL, init?: RequestInit): Promise<Response> {
    return fetchWithTimeout(input, init, this.requestTimeoutMs);
  }

  public async test(): Promise<{ ok: boolean; message: string }> {
    try {
      // Test base directory access (PROPFIND or HEAD or GET)
      const res = await this.request(this.baseUrl, {
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
      const getRes = await this.request(this.baseUrl, {
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
    await this.request(this.baseUrl, {
      method: 'MKCOL',
      headers: { Authorization: this.authHeader }
    });
  }

  public async pull(): Promise<string> {
    const res = await this.request(this.fileUrl, {
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

    const res = await this.request(this.fileUrl, {
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

  constructor(private config: GistConfig, private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {}

  private request(input: string | URL, init?: RequestInit): Promise<Response> {
    return fetchWithTimeout(input, init, this.requestTimeoutMs);
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sshx-client'
    };
  }

  public async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.request('https://api.github.com/user', {
        headers: this.headers
      });

      if (res.status === 200) {
        const user = await res.json() as { login?: string };
        const scopes = res.headers.get('x-oauth-scopes');
        if (scopes !== null && !scopes.split(',').map(s => s.trim()).includes('gist')) {
          return {
            ok: false,
            message: `Authenticated as @${user.login || 'user'}, but token is missing the required 'gist' scope.`
          };
        }

        if (this.config.gistId) {
          const gistRes = await this.request(`https://api.github.com/gists/${this.config.gistId}`, {
            headers: this.headers
          });
          if (gistRes.status === 404) {
            return {
              ok: true,
              message: `Authenticated as @${user.login || 'user'} (Note: specified Gist ID '${this.config.gistId}' not found; a new secret Gist will be auto-created on first push)`
            };
          }
        }

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

    let res = await this.request(`https://api.github.com/gists/${gistId}`, {
      headers: this.headers
    });

    if (res.status === 404) {
      // If configured gistId was not found, attempt to find by filename
      const autoFound = await this.findSshxGistId();
      if (autoFound && autoFound !== gistId) {
        gistId = autoFound;
        this.config.gistId = gistId;
        res = await this.request(`https://api.github.com/gists/${gistId}`, {
          headers: this.headers
        });
      }
    }

    if (res.status === 404) {
      throw new Error(`Gist ${gistId} not found. Please verify your gistId or push again.`);
    }

    if (!res.ok) {
      throw new Error(`Gist pull failed (${res.status} ${res.statusText})`);
    }

    const data: unknown = await res.json();
    const files = data && typeof data === 'object' ? (data as { files?: unknown }).files : undefined;
    const file = files && typeof files === 'object'
      ? (files as Record<string, unknown>)[GistProvider.GIST_FILENAME] : undefined;
    const content = file && typeof file === 'object' ? (file as { content?: unknown }).content : undefined;
    if (typeof content !== 'string') {
      throw new Error(`Gist does not contain '${GistProvider.GIST_FILENAME}'.`);
    }

    return content;
  }

  public async push(encryptedBlob: string): Promise<{ remoteId?: string }> {
    let gistId = this.config.gistId;

    if (!gistId) {
      gistId = await this.findSshxGistId();
    }

    const description = this.config.description || 'sshx encrypted host profiles backup (E2EE)';

    if (gistId) {
      // Update existing Gist
      const res = await this.request(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({
          description,
          files: {
            [GistProvider.GIST_FILENAME]: { content: encryptedBlob }
          }
        })
      });

      if (res.ok) {
        this.config.gistId = gistId;
        return { remoteId: gistId };
      }

      if (res.status === 404) {
        // Gist was not found (invalid ID or deleted). Auto-fallback to create a new secret Gist below.
        gistId = undefined;
      } else {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const errData = await res.json() as any;
          if (errData?.message) msg += `: ${errData.message}`;
        } catch {}
        if (res.status === 403) {
          throw new Error(`GitHub token lacks Gist write permission (${msg}). Please ensure your token has 'gist' (Classic) or Account -> Gists write access (Fine-grained).`);
        }
        throw new Error(`Failed to update Gist ${gistId} (${msg})`);
      }
    }

    // Create new secret Gist
    const res = await this.request('https://api.github.com/gists', {
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
      let msg = `${res.status} ${res.statusText}`;
      try {
        const errData = await res.json() as any;
        if (errData?.message) msg += `: ${errData.message}`;
      } catch {}
      if (res.status === 403) {
        throw new Error(`GitHub token lacks Gist write permission (${msg}). Please ensure your token has 'gist' (Classic) or Account -> Gists write access (Fine-grained).`);
      }
      throw new Error(`Failed to create secret Gist (${msg})`);
    }

    const created: unknown = await res.json();
    const id = created && typeof created === 'object' ? (created as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !id) throw new Error('GitHub created a Gist but returned no ID. Check your Gists before retrying to avoid creating duplicates.');
    this.config.gistId = id;
    return { remoteId: id };
  }

  private async findSshxGistId(): Promise<string | undefined> {
    let url = 'https://api.github.com/gists?per_page=100';
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url) || seen.size >= 100) {
        throw new Error('GitHub Gist lookup exceeded the page limit; refusing to create a duplicate backup.');
      }
      seen.add(url);
      const res = await this.request(url, { headers: this.headers });
      if (!res.ok) throw new Error(`GitHub Gist lookup failed (${res.status} ${res.statusText})`);

      const payload: unknown = await res.json();
      if (!Array.isArray(payload)) throw new Error('GitHub Gist lookup returned an invalid response.');
      for (const gist of payload) {
        if (!gist || typeof gist !== 'object') continue;
        const files = (gist as { files?: unknown }).files;
        if (!files || typeof files !== 'object' || !(GistProvider.GIST_FILENAME in files)) continue;
        const id = (gist as { id?: unknown }).id;
        if (typeof id === 'string' && id.length > 0) return id;
      }

      const next = res.headers.get('link')?.split(',').map(part => part.trim())
        .find(part => /;\s*rel="next"$/.test(part))?.match(/^<([^>]+)>;/)?.[1];
      if (next) {
        const candidate = new URL(next);
        if (candidate.origin !== 'https://api.github.com' || candidate.pathname !== '/gists') {
          throw new Error('GitHub Gist lookup returned an unsafe pagination URL.');
        }
        url = candidate.href;
      } else {
        url = '';
      }
    }
    return undefined;
  }
}

function fetchWithTimeout(input: string | URL, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}
