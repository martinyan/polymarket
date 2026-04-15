import { lookup as dnsLookup } from 'dns/promises';
import http from 'http';
import https from 'https';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1_000;
const DNS_CACHE_TTL_MS = 5 * 60_000;

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
};

type RequestResult = {
  status: number;
  bodyText: string;
};

type DnsCacheEntry = {
  address: string;
  family: number;
  expiresAt: number;
};

const dnsCache = new Map<string, DnsCacheEntry>();

export async function fetchJson<T>(url: string, options: Omit<RequestOptions, 'body' | 'method'> = {}): Promise<T> {
  const result = await request(url, {
    ...options,
    method: 'GET',
  });
  return JSON.parse(result.bodyText) as T;
}

export async function postJson<T>(url: string, body: unknown, options: Omit<RequestOptions, 'body' | 'method'> = {}): Promise<T> {
  const result = await request(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  return JSON.parse(result.bodyText) as T;
}

export async function fetchText(url: string, options: Omit<RequestOptions, 'body' | 'method'> = {}): Promise<string> {
  const result = await request(url, {
    ...options,
    method: 'GET',
  });
  return result.bodyText;
}

async function request(url: string, options: RequestOptions): Promise<RequestResult> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await requestOnce(url, options, timeoutMs);
      if (!isRetryableStatus(result.status)) {
        if (result.status < 200 || result.status >= 300) {
          throw new Error(`Request failed ${result.status} for ${url}`);
        }
        return result;
      }

      lastError = new Error(`Request failed ${result.status} for ${url}`);
      if (attempt === retries) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === retries) {
        throw decorateError(url, attempt, retries, error);
      }
    }

    await sleep(backoffMs * (attempt + 1) + jitterMs(250));
  }

  throw decorateError(url, retries, retries, lastError);
}

async function requestOnce(url: string, options: RequestOptions, timeoutMs: number): Promise<RequestResult> {
  try {
    return await requestViaFetch(url, options, timeoutMs);
  } catch (error) {
    if (!isDnsLikeError(error)) {
      throw error;
    }
    return await requestViaResolvedDns(url, options, timeoutMs);
  }
}

async function requestViaFetch(url: string, options: RequestOptions, timeoutMs: number): Promise<RequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': 'clean-polymarket-copy-bot/0.1',
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: controller.signal,
    });
    return {
      status: response.status,
      bodyText: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestViaResolvedDns(url: string, options: RequestOptions, timeoutMs: number): Promise<RequestResult> {
  const parsedUrl = new URL(url);
  const resolved = await resolveHostname(parsedUrl.hostname);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  return await new Promise<RequestResult>((resolve, reject) => {
    const request = client.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
      method: options.method ?? 'GET',
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: {
        'User-Agent': 'clean-polymarket-copy-bot/0.1',
        ...(options.headers ?? {}),
        Host: parsedUrl.host,
      },
      servername: parsedUrl.hostname,
      family: resolved.family,
      lookup: (_hostname, _lookupOptions, callback) => {
        callback(null, resolved.address, resolved.family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

async function resolveHostname(hostname: string): Promise<{ address: string; family: number }> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return { address: cached.address, family: cached.family };
  }

  const resolved = await dnsLookup(hostname, { family: 4 });
  dnsCache.set(hostname, {
    address: resolved.address,
    family: resolved.family,
    expiresAt: Date.now() + DNS_CACHE_TTL_MS,
  });
  return resolved;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('socket') ||
    message.includes('aborted')
  );
}

function isDnsLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('eai_again') ||
    message.includes('enotfound') ||
    message.includes('getaddrinfo')
  );
}

function decorateError(url: string, attempt: number, retries: number, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Request error after ${attempt + 1}/${retries + 1} attempt(s) for ${url}: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitterMs(max: number): number {
  return Math.floor(Math.random() * max);
}
