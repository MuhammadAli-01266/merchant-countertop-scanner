/**
 * Environment configuration manager with Dual Environment Variable Support
 * Reads both Vite (VITE_*) and Next.js (NEXT_PUBLIC_*) prefixes,
 * stripping surrounding quotes, escapes, and whitespace.
 */

export const DEFAULT_SUPABASE_URL = "https://uovotzsbepqufgcxewkt.supabase.co";
export const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_h1MmJxWUkjndrmHiPr4ogQ_ba94P";

/**
 * Strips quotes (single, double, backtick), escape slashes, and surrounding whitespace
 */
export function cleanEnvValue(val?: string | null): string {
  if (!val || typeof val !== "string") return "";
  return val
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\\"/g, "")
    .trim();
}

/**
 * Retrieves environment variable value supporting both Vite and Next.js prefixes
 */
function getRawEnv(viteKey: string, nextKey: string, bareKey?: string): string {
  // Vite client import.meta.env
  if (typeof import.meta !== "undefined" && import.meta.env) {
    const val = import.meta.env[viteKey] || import.meta.env[nextKey] || (bareKey ? import.meta.env[bareKey] : undefined);
    if (val) return String(val);
  }

  // Node / Vercel process.env
  if (typeof process !== "undefined" && process.env) {
    const val = process.env[viteKey] || process.env[nextKey] || (bareKey ? process.env[bareKey] : undefined);
    if (val) return String(val);
  }

  return "";
}

export interface AppEnvConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  isCustomUrl: boolean;
  isCustomKey: boolean;
}

/**
 * Get active environment configuration with direct fallbacks
 */
export function getEnvConfig(): AppEnvConfig {
  // Check runtime localStorage override first
  if (typeof window !== "undefined") {
    const customUrl = cleanEnvValue(localStorage.getItem("merchant_supabase_url"));
    const customKey = cleanEnvValue(localStorage.getItem("merchant_supabase_anon_key"));
    if (customUrl && customKey) {
      return {
        supabaseUrl: customUrl,
        supabaseAnonKey: customKey,
        isCustomUrl: true,
        isCustomKey: true
      };
    }
  }

  const rawUrl = getRawEnv("VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const rawKey = getRawEnv("VITE_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY");

  const cleanUrl = cleanEnvValue(rawUrl);
  const cleanKey = cleanEnvValue(rawKey);

  const supabaseUrl =
    cleanUrl && cleanUrl.startsWith("http") && !cleanUrl.includes("undefined")
      ? cleanUrl
      : DEFAULT_SUPABASE_URL;

  const supabaseAnonKey =
    cleanKey && cleanKey.length > 10 && !cleanKey.includes("undefined") && !cleanKey.includes("MY_KEY")
      ? cleanKey
      : DEFAULT_SUPABASE_ANON_KEY;

  return {
    supabaseUrl,
    supabaseAnonKey,
    isCustomUrl: Boolean(cleanUrl && cleanUrl !== DEFAULT_SUPABASE_URL),
    isCustomKey: Boolean(cleanKey && cleanKey !== DEFAULT_SUPABASE_ANON_KEY)
  };
}

export const envConfig = getEnvConfig();
