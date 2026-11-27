import { Capacitor } from '@capacitor/core';
import {
  cacheGet,
  cacheSet,
  enqueueMutation,
  getQueuedMutations,
  removeMutation,
  updateMutation,
} from './offlineDb';

const TOKEN_KEY = 'sonagrain_jwt';
const USER_KEY = 'sonagrain_user';
const DEVICE_ID_KEY = 'sonagrain_device_id';
const API_BASE_KEY = 'sonagrain_api_base_url';
const DEFAULT_NATIVE_API_URL =
  import.meta.env.VITE_API_BASE_URL ||
  'https://ais-pre-mo63cvfhkzdcjpxy7fomyh-548793849029.asia-east1.run.app';

export function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function getClientType(): 'ANDROID_APK' | 'WEB_PWA' {
  return isNativeAndroid() ? 'ANDROID_APK' : 'WEB_PWA';
}

export function getApiBaseUrl(): string {
  const saved = localStorage.getItem(API_BASE_KEY)?.trim() || '';
  if (saved) {
    return saved.replace(/\/+$/, '');
  }
  if (isNativeAndroid()) {
    return DEFAULT_NATIVE_API_URL.replace(/\/+$/, '');
  }
  return '';
}

export function setApiBaseUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '');
  if (!cleaned) {
    localStorage.removeItem(API_BASE_KEY);
    return getApiBaseUrl();
  }
  const normalized = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  localStorage.setItem(API_BASE_KEY, normalized);
  return normalized;
}

export function resolveApiUrl(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const base = getApiBaseUrl();
  if (!base) return endpoint;
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    const prefix = isNativeAndroid() ? 'AND' : 'WEB';
    id = `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser<T>(): T | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function apiGet<T>(endpoint: string, cacheKey?: string): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'X-Client-Type': getClientType(),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(resolveApiUrl(endpoint), { headers });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new ApiError(errBody.error || `HTTP ${res.status}`, res.status);
    }
    const data = (await res.json()) as T;
    if (cacheKey) {
      await cacheSet(cacheKey, data);
    }
    return data;
  } catch (err) {
    // If network failed and offline cache exists, serve cached read data seamlessly across mobile & web
    if (cacheKey && (!navigator.onLine || err instanceof TypeError || !(err instanceof ApiError))) {
      const cached = await cacheGet<T>(cacheKey);
      if (cached) return cached;
    }
    throw err;
  }
}

export interface MutationResult<T> {
  offlineQueued: boolean;
  data?: T;
  client_uuid: string;
}

export async function apiMutate<T>(params: {
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: Record<string, unknown>;
  module: string;
  summary: string;
}): Promise<MutationResult<T>> {
  const client_uuid = (params.payload.client_uuid as string) || crypto.randomUUID();
  const clientType = getClientType();
  const bodyPayload = {
    ...params.payload,
    client_uuid,
    device_id: getDeviceId(),
    client_type: clientType,
  };

  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Type': clientType,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (!navigator.onLine) {
    await enqueueMutation({
      client_uuid,
      endpoint: params.endpoint,
      method: params.method || 'POST',
      payload: bodyPayload,
      module: params.module,
      summary: params.summary,
      created_at: new Date().toISOString(),
      status: 'PENDING',
      retries: 0,
    });
    return { offlineQueued: true, client_uuid };
  }

  try {
    const res = await fetch(resolveApiUrl(params.endpoint), {
      method: params.method || 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new ApiError(errBody.error || `Request failed (${res.status})`, res.status);
    }
    const data = (await res.json()) as T;
    return { offlineQueued: false, data, client_uuid };
  } catch (err) {
    if (err instanceof TypeError) {
      await enqueueMutation({
        client_uuid,
        endpoint: params.endpoint,
        method: params.method || 'POST',
        payload: bodyPayload,
        module: params.module,
        summary: params.summary,
        created_at: new Date().toISOString(),
        status: 'PENDING',
        retries: 0,
      });
      return { offlineQueued: true, client_uuid };
    }
    throw err;
  }
}

export async function syncPendingMutations(): Promise<{ synced: number; conflicts: number; failed: number }> {
  if (!navigator.onLine) return { synced: 0, conflicts: 0, failed: 0 };
  const token = getStoredToken();
  if (!token) return { synced: 0, conflicts: 0, failed: 0 };

  const queue = await getQueuedMutations();
  let synced = 0;
  let conflicts = 0;
  let failed = 0;

  for (const item of queue) {
    if (item.status === 'CONFLICT') continue; // Do not blindly overwrite conflicted stock/accounting entries
    await updateMutation({ ...item, status: 'SYNCING' });

    try {
      const res = await fetch(resolveApiUrl(item.endpoint), {
        method: item.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify(item.payload),
      });

      if (res.ok) {
        await removeMutation(item.client_uuid);
        synced++;
      } else if (res.status === 409) {
        const errBody = await res.json().catch(() => ({ error: 'Conflict detected' }));
        await updateMutation({
          ...item,
          status: 'CONFLICT',
          error_message: errBody.error || 'Stock or version conflict detected on server.',
          retries: item.retries + 1,
        });
        conflicts++;
      } else {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        await updateMutation({
          ...item,
          status: 'FAILED',
          error_message: errBody.error || `Server rejected (${res.status})`,
          retries: item.retries + 1,
        });
        failed++;
      }
    } catch (err) {
      await updateMutation({
        ...item,
        status: 'PENDING',
        error_message: (err as Error).message,
        retries: item.retries + 1,
      });
      failed++;
    }
  }

  return { synced, conflicts, failed };
}

