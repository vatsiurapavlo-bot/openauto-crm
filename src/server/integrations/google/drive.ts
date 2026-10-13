/**
 * Google Drive przez oficjalne REST API (bez dodatkowych bibliotek).
 * Zakres uprawnień: drive.file — aplikacja widzi WYŁĄCZNIE pliki i foldery, które sama utworzyła,
 * nie ma dostępu do reszty Dysku właściciela.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = [DRIVE_SCOPE, 'openid', 'email'];

/** Struktura folderów z p. 10 założeń */
export const ROOT_FOLDER = 'OpenAuto CRM';
export const SUBFOLDERS = ['Backups', 'Excel', 'Samochody', 'Faktury', 'Dokumenty', 'Zdjęcia'] as const;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  oauthBase: string; // https://oauth2.googleapis.com (podmieniane w testach)
  authBase: string; // https://accounts.google.com
  apiBase: string; // https://www.googleapis.com
}

export function googleConfig(publicUrl: string | null, env = process.env): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !publicUrl) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${publicUrl.replace(/\/$/, '')}/api/integrations/google/callback`,
    oauthBase: env.GOOGLE_OAUTH_BASE ?? 'https://oauth2.googleapis.com',
    authBase: env.GOOGLE_AUTH_BASE ?? 'https://accounts.google.com',
    apiBase: env.GOOGLE_API_BASE ?? 'https://www.googleapis.com',
  };
}

export function authorizationUrl(cfg: GoogleConfig, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // zawsze zwraca refresh_token
    include_granted_scopes: 'true',
    state,
  });
  return `${cfg.authBase}/o/oauth2/v2/auth?${p}`;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function readJson(res: Response, what: string) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* odpowiedź nie-JSON */
  }
  if (!res.ok) {
    const msg = data?.error_description ?? data?.error?.message ?? data?.error ?? text.slice(0, 200);
    throw new GoogleError(`Google (${what}): ${msg}`, res.status);
  }
  return data;
}

export async function exchangeCode(cfg: GoogleConfig, code: string): Promise<{ refreshToken: string; email: string | null }> {
  const res = await fetch(`${cfg.oauthBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await readJson(res, 'wymiana kodu');
  if (!data.refresh_token) throw new GoogleError('Google nie zwrócił tokenu odświeżania — spróbuj połączyć ponownie');
  if (typeof data.scope === 'string' && !data.scope.split(' ').includes(DRIVE_SCOPE)) {
    throw new GoogleError('Nie udzielono dostępu do Google Drive — zaznacz zgodę na Dysk przy łączeniu');
  }
  let email: string | null = null;
  if (data.id_token) {
    // id_token otrzymany bezpośrednio z Google przez HTTPS — odczytujemy tylko adres e-mail
    try {
      email = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8')).email ?? null;
    } catch {
      email = null;
    }
  }
  return { refreshToken: data.refresh_token, email };
}

export async function revokeToken(cfg: GoogleConfig, token: string) {
  await fetch(`${cfg.oauthBase}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

export interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  size?: string;
}

export class DriveClient {
  private access: { token: string; until: number } | null = null;

  constructor(
    private cfg: GoogleConfig,
    private refreshToken: string,
  ) {}

  private async token(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const res = await fetch(`${this.cfg.oauthBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await readJson(res, 'odświeżenie dostępu');
    this.access = { token: data.access_token, until: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  private async api(path: string, init: RequestInit = {}, what = 'Drive') {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(init.headers ?? {}) },
    });
    if (res.status === 204) return null;
    return readJson(res, what);
  }

  async findFolder(name: string, parentId: string | null): Promise<string | null> {
    const q = [
      `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
      parentId ? `'${parentId}' in parents` : `'root' in parents`,
    ].join(' and ');
    const data = await this.api(`/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '10' })}`, {}, 'wyszukiwanie folderu');
    return data.files?.[0]?.id ?? null;
  }

  async createFolder(name: string, parentId: string | null): Promise<string> {
    const data = await this.api(
      '/drive/v3/files?fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
      },
      'tworzenie folderu',
    );
    return data.id;
  }

  async ensureFolder(name: string, parentId: string | null): Promise<string> {
    return (await this.findFolder(name, parentId)) ?? (await this.createFolder(name, parentId));
  }

  /** Tworzy "OpenAuto CRM/{Backups, Excel, Samochody, Faktury, Dokumenty, Zdjęcia}" i zwraca ich identyfikatory. */
  async ensureStructure(): Promise<Record<string, string>> {
    const root = await this.ensureFolder(ROOT_FOLDER, null);
    const out: Record<string, string> = { root };
    for (const sub of SUBFOLDERS) out[sub] = await this.ensureFolder(sub, root);
    return out;
  }

  /** Wysyłanie pliku (upload wznawialny — działa także dla większych kopii). */
  async upload(name: string, parentId: string, mimeType: string, data: Buffer): Promise<string> {
    const init = await fetch(`${this.cfg.apiBase}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(data.length),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    if (!init.ok) await readJson(init, 'rozpoczęcie wysyłania');
    const location = init.headers.get('location');
    if (!location) throw new GoogleError('Google nie zwrócił adresu wysyłania');
    const put = await fetch(location, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'Content-Length': String(data.length) },
      body: new Uint8Array(data),
    });
    const res = await readJson(put, 'wysyłanie pliku');
    return res.id;
  }

  async list(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({
        q: `'${parentId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,createdTime,size)',
        orderBy: 'createdTime desc',
        pageSize: '200',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const data = await this.api(`/drive/v3/files?${p}`, {}, 'lista plików');
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return files;
  }

  async download(fileId: string): Promise<Buffer> {
    const res = await fetch(`${this.cfg.apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) await readJson(res, 'pobieranie pliku');
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(fileId: string) {
    await this.api(`/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, 'usuwanie pliku');
  }
}
