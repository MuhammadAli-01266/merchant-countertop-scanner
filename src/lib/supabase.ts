import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { getEnvConfig, cleanEnvValue, DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from "./env";

export { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY };

export const SUPABASE_URL = getEnvConfig().supabaseUrl;
export const SUPABASE_ANON_KEY = getEnvConfig().supabaseAnonKey;

const STORAGE_URL_KEY = "merchant_supabase_url";
const STORAGE_KEY_KEY = "merchant_supabase_anon_key";

export function cleanSupabaseEnvValue(val?: string | null): string {
  return cleanEnvValue(val);
}

/**
 * Ensures valid UUIDv4 format for PostgreSQL columns to prevent 22P02 syntax errors
 */
export function ensureUuid(id?: string | null): string {
  if (!id) return "00000000-0000-0000-0000-000000000001";
  const trimmed = id.trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash << 5) - hash + trimmed.charCodeAt(i);
    hash |= 0;
  }
  const hexPart = Math.abs(hash).toString(16).padStart(12, "0").slice(0, 12);
  return `00000000-0000-4000-8000-${hexPart}`;
}

export function getActiveSupabaseConfig() {
  const config = getEnvConfig();
  return {
    url: config.supabaseUrl,
    key: config.supabaseAnonKey
  };
}

let supabaseInstance: SupabaseClient | null = null;

/**
 * Initializes or returns cached Supabase client with persistent storage and auto refresh
 */
export function getSupabaseClient(): SupabaseClient {
  const config = getActiveSupabaseConfig();
  if (!supabaseInstance) {
    supabaseInstance = createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        storage: typeof window !== "undefined" ? window.localStorage : undefined,
        autoRefreshToken: true,
        detectSessionInUrl: false
      },
      global: {
        headers: {
          "x-client-info": "merchant-countertop-scanner-pwa"
        }
      }
    });
  }
  return supabaseInstance;
}

export function updateSupabaseConfig(url: string, key: string) {
  const cleanUrl = cleanEnvValue(url) || DEFAULT_SUPABASE_URL;
  const cleanKey = cleanEnvValue(key) || DEFAULT_SUPABASE_ANON_KEY;

  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_URL_KEY, cleanUrl);
    localStorage.setItem(STORAGE_KEY_KEY, cleanKey);
  }

  supabaseInstance = createClient(cleanUrl, cleanKey, {
    auth: {
      persistSession: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });
}

export function resetSupabaseConfig() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORAGE_URL_KEY);
    localStorage.removeItem(STORAGE_KEY_KEY);
  }
  supabaseInstance = createClient(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });
}

export const supabase = getSupabaseClient();

/**
 * Standard Supabase PostgREST Headers
 */
export function getSupabaseHeaders(): Record<string, string> {
  const config = getActiveSupabaseConfig();
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
}

/**
 * Direct REST API fetch to Supabase (bypasses SDK serialization errors)
 */
export async function supabaseRestFetch<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: string | null; status: number }> {
  const config = getActiveSupabaseConfig();
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const fullUrl = `${config.url}${path}`;

  const headers = {
    ...getSupabaseHeaders(),
    ...(options.headers as Record<string, string> || {})
  };

  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers
    });

    const status = response.status;
    let data: T | null = null;
    let error: string | null = null;

    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        if (!response.ok) {
          error = json.message || json.error || `HTTP ${response.status}`;
        } else {
          data = json as T;
        }
      } catch {
        if (!response.ok) {
          error = text || `HTTP ${response.status}`;
        }
      }
    } else if (!response.ok) {
      error = `HTTP ${response.status}`;
    }

    return { data, error, status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Network request failed";
    return { data: null, error: msg, status: 0 };
  }
}

/**
 * Direct REST API: Insert into `stamps` table
 */
export async function insertStampDirect(stampRecord: {
  card_id: string;
  tenant_id: string;
  cashier_name: string;
  count: number;
  created_at?: string;
}) {
  return supabaseRestFetch<unknown[]>("/rest/v1/stamps", {
    method: "POST",
    body: JSON.stringify({
      card_id: stampRecord.card_id,
      tenant_id: stampRecord.tenant_id,
      cashier_name: stampRecord.cashier_name,
      count: stampRecord.count,
      created_at: stampRecord.created_at || new Date().toISOString()
    })
  });
}

/**
 * Direct REST API: Upsert / Update `cards` table
 */
export async function upsertCardDirect(cardRecord: {
  id: string;
  name: string;
  phone: string;
  member_id: string;
  tenant_id: string;
  tier?: string;
  stamps: number;
  max_stamps?: number;
  total_stamps?: number;
  rewards_claimed?: number;
  updated_at?: string;
}) {
  return supabaseRestFetch<unknown[]>("/rest/v1/cards", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify({
      id: cardRecord.id,
      name: cardRecord.name,
      phone: cardRecord.phone,
      member_id: cardRecord.member_id,
      tenant_id: cardRecord.tenant_id,
      tier: cardRecord.tier || "Silver",
      stamps: cardRecord.stamps,
      max_stamps: cardRecord.max_stamps || 7,
      total_stamps: cardRecord.total_stamps || cardRecord.stamps,
      rewards_claimed: cardRecord.rewards_claimed || 0,
      updated_at: cardRecord.updated_at || new Date().toISOString()
    })
  });
}

/**
 * Direct REST API: Insert into `redemptions` table
 */
export async function insertRedemptionDirect(redemptionRecord: {
  card_id: string;
  tenant_id: string;
  cashier_name: string;
  reward_title: string;
  stamps_redeemed: number;
  created_at?: string;
}) {
  return supabaseRestFetch<unknown[]>("/rest/v1/redemptions", {
    method: "POST",
    body: JSON.stringify({
      card_id: redemptionRecord.card_id,
      tenant_id: redemptionRecord.tenant_id,
      cashier_name: redemptionRecord.cashier_name,
      reward_title: redemptionRecord.reward_title,
      stamps_redeemed: redemptionRecord.stamps_redeemed,
      created_at: redemptionRecord.created_at || new Date().toISOString()
    })
  });
}

/**
 * Direct REST API: Fetch Card from `cards` table
 */
export async function fetchCardDirect(identifier: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const query = isUuid
    ? `or=(id.eq.${identifier},member_id.eq.${identifier},phone.eq.${identifier})`
    : `or=(member_id.eq.${identifier},phone.eq.${identifier})`;

  return supabaseRestFetch<Record<string, unknown>[]>(
    `/rest/v1/cards?select=*,stamps(*)&${query}&limit=1`,
    {
      method: "GET"
    }
  );
}

/**
 * Direct REST API: Ping / Test connection
 */
export async function pingSupabaseDirect() {
  return supabaseRestFetch("/rest/v1/cards?select=id&limit=1", {
    method: "GET"
  });
}

export interface RealtimePostgresChangePayload {
  schema: string;
  table: string;
  commit_timestamp: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown>;
  old: Record<string, unknown>;
  errors?: unknown;
}

/**
 * Subscribes to Supabase Realtime Postgres Changes on `stamps` and `cards` tables.
 */
export function subscribeToLoyaltyRealtime(callbacks: {
  onStampChange: (payload: RealtimePostgresChangePayload) => void;
  onCardChange: (payload: RealtimePostgresChangePayload) => void;
  onStatusChange?: (status: string) => void;
}): () => void {
  const config = getActiveSupabaseConfig();
  let client: ReturnType<typeof createClient> | null = null;
  let channel: RealtimeChannel | null = null;

  try {
    client = createClient(config.url, config.key, {
      realtime: {
        params: {
          eventsPerSecond: 10
        }
      }
    });

    channel = client
      .channel("merchant-loyalty-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stamps" },
        (payload: unknown) => {
          callbacks.onStampChange(payload as RealtimePostgresChangePayload);
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cards" },
        (payload: unknown) => {
          callbacks.onCardChange(payload as RealtimePostgresChangePayload);
        }
      )
      .subscribe((status: string) => {
        if (callbacks.onStatusChange) {
          callbacks.onStatusChange(status);
        }
      });
  } catch (err: unknown) {
    console.warn("Realtime initialization note:", err);
  }

  return () => {
    try {
      if (client && channel) {
        client.removeChannel(channel);
      }
    } catch {
      // Clean up
    }
  };
}
