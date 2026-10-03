/**
 * Merchant Authentication & Session Management
 * Handles persistent storage, active session validation,
 * and graceful handling of Auth 400 (grant_type=password) errors.
 */

import { getSupabaseClient } from "./supabase";
import type { Session, User } from "@supabase/supabase-js";

export interface MerchantUser {
  id: string;
  email: string;
  name: string;
  role: "cashier" | "manager" | "owner";
  tenantId: string;
  branchName: string;
}

export interface AuthResult {
  success: boolean;
  user?: MerchantUser;
  session?: Session;
  error?: string;
  code?: string;
}

const LOCAL_MERCHANT_KEY = "merchant_countertop_user";

// Default fallback merchant context for uninterrupted countertop service
export const DEFAULT_MERCHANT: MerchantUser = {
  id: "usr_marcus_vance",
  email: "marcus@bluebottlecoffee.com",
  name: "Marcus Vance",
  role: "cashier",
  tenantId: "branch_hv",
  branchName: "Hayes Valley Flagship"
};

/**
 * Validates whether an active session exists in storage
 */
export async function validateActiveSession(): Promise<{ isValid: boolean; user: MerchantUser | null }> {
  try {
    const client = getSupabaseClient();
    const { data: { session }, error } = await client.auth.getSession();

    if (error) {
      console.warn("Session retrieval note:", error.message);
    }

    if (session && session.user) {
      const merchant: MerchantUser = {
        id: session.user.id,
        email: session.user.email || "",
        name: session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "Cashier",
        role: (session.user.user_metadata?.role as MerchantUser["role"]) || "cashier",
        tenantId: session.user.user_metadata?.tenant_id || "branch_hv",
        branchName: session.user.user_metadata?.branch_name || "Hayes Valley Flagship"
      };

      if (typeof window !== "undefined") {
        localStorage.setItem(LOCAL_MERCHANT_KEY, JSON.stringify(merchant));
      }
      return { isValid: true, user: merchant };
    }

    // Check cached merchant user in localStorage
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(LOCAL_MERCHANT_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as MerchantUser;
          return { isValid: true, user: parsed };
        } catch {
          // invalid json
        }
      }
    }

    return { isValid: false, user: null };
  } catch (err: unknown) {
    console.warn("Session validation exception:", err);
    return { isValid: false, user: null };
  }
}

/**
 * Sign in merchant with email & password
 * Gracefully captures Auth 400 (grant_type=password) without crashing POS interface
 */
export async function signInMerchant(email: string, password: string): Promise<AuthResult> {
  const cleanEmail = email.trim();
  const cleanPassword = password.trim();

  if (!cleanEmail || !cleanPassword) {
    return {
      success: false,
      error: "Please enter both cashier email and password."
    };
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword
    });

    if (error) {
      // Handle Supabase Auth 400 (Invalid login credentials) cleanly
      const isAuth400 =
        error.status === 400 ||
        error.message.toLowerCase().includes("invalid login credentials") ||
        error.message.toLowerCase().includes("grant_type");

      const errorMessage = isAuth400
        ? "Invalid cashier credentials. Please check your email or password."
        : error.message;

      return {
        success: false,
        error: errorMessage,
        code: String(error.status || 400)
      };
    }

    if (data.session && data.user) {
      const user: MerchantUser = {
        id: data.user.id,
        email: data.user.email || cleanEmail,
        name: data.user.user_metadata?.full_name || cleanEmail.split("@")[0],
        role: (data.user.user_metadata?.role as MerchantUser["role"]) || "cashier",
        tenantId: data.user.user_metadata?.tenant_id || "branch_hv",
        branchName: data.user.user_metadata?.branch_name || "Hayes Valley Flagship"
      };

      if (typeof window !== "undefined") {
        localStorage.setItem(LOCAL_MERCHANT_KEY, JSON.stringify(user));
      }

      return {
        success: true,
        user,
        session: data.session
      };
    }

    return {
      success: false,
      error: "Authentication succeeded but no active session was returned."
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Authentication request failed";
    return {
      success: false,
      error: msg,
      code: "NETWORK_ERROR"
    };
  }
}

/**
 * Signs out current cashier / merchant
 */
export async function signOutMerchant(): Promise<void> {
  try {
    const client = getSupabaseClient();
    await client.auth.signOut();
  } catch {
    // ignore
  }

  if (typeof window !== "undefined") {
    localStorage.removeItem(LOCAL_MERCHANT_KEY);
  }
}

/**
 * Retrieve current merchant from storage or fallback to default
 */
export function getCurrentMerchant(): MerchantUser {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(LOCAL_MERCHANT_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as MerchantUser;
      } catch {
        // fallback
      }
    }
  }
  return DEFAULT_MERCHANT;
}
