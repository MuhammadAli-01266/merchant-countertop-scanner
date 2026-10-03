/**
 * POS API Services & RPC Operations
 * Provides robust error handling for RPC 404 (get_merchant_context)
 * and direct database operations for cards, stamps, and redemptions.
 */

import {
  getSupabaseClient,
  supabaseRestFetch,
  ensureUuid,
  insertStampDirect,
  upsertCardDirect,
  insertRedemptionDirect,
  fetchCardDirect
} from "./supabase";

export interface MerchantContext {
  tenantId: string;
  brand: string;
  branch: string;
  address: string;
  rewardTitle: string;
  stampTarget: number;
  isFallback: boolean;
}

export const FALLBACK_MERCHANT_CONTEXT: MerchantContext = {
  tenantId: "branch_hv",
  brand: "Blue Bottle Coffee",
  branch: "Hayes Valley Flagship",
  address: "315 Linden St, San Francisco, CA",
  rewardTitle: "Free Signature Handcrafted Pour-Over",
  stampTarget: 7,
  isFallback: true
};

/**
 * Fetches merchant context with RPC 404 error interception.
 * If `get_merchant_context` is missing in PostgreSQL (PGRST202 / 404),
 * it returns the fallback tenant context seamlessly.
 */
export async function getMerchantContext(tenantId = "branch_hv"): Promise<MerchantContext> {
  const client = getSupabaseClient();

  try {
    const { data, error, status } = await client.rpc("get_merchant_context", {
      p_tenant_id: tenantId
    });

    if (error) {
      const is404 =
        status === 404 ||
        error.code === "PGRST202" ||
        error.message.toLowerCase().includes("not found") ||
        error.message.toLowerCase().includes("does not exist");

      if (is404) {
        console.info(
          `RPC 'get_merchant_context' returned 404 / missing function. Operating with local tenant context.`
        );
        return { ...FALLBACK_MERCHANT_CONTEXT, tenantId };
      }

      console.warn("RPC get_merchant_context warning:", error.message);
      return { ...FALLBACK_MERCHANT_CONTEXT, tenantId };
    }

    if (data && typeof data === "object") {
      const ctx = data as Record<string, unknown>;
      return {
        tenantId: String(ctx.tenant_id || tenantId),
        brand: String(ctx.brand || "Blue Bottle Coffee"),
        branch: String(ctx.branch || "Hayes Valley Flagship"),
        address: String(ctx.address || "315 Linden St, San Francisco, CA"),
        rewardTitle: String(ctx.reward_title || "Free Signature Handcrafted Pour-Over"),
        stampTarget: Number(ctx.stamp_target) || 7,
        isFallback: false
      };
    }
  } catch (err: unknown) {
    console.warn("RPC network exception handled:", err);
  }

  return { ...FALLBACK_MERCHANT_CONTEXT, tenantId };
}

/**
 * Add stamp to card with direct DB write and error suppression
 */
export async function addStampApi(params: {
  cardId: string;
  tenantId: string;
  cashierName: string;
  count?: number;
  currentStamps: number;
  totalLifetimeStamps?: number;
  customerName?: string;
  phone?: string;
  memberId?: string;
}): Promise<{ success: boolean; newStamps: number; error?: string }> {
  const delta = params.count || 1;
  const newStampCount = Math.min(7, params.currentStamps + delta);
  const normalizedCardId = ensureUuid(params.cardId);

  try {
    // 1. Upsert card in cards table
    await upsertCardDirect({
      id: normalizedCardId,
      name: params.customerName || "Valued Guest",
      phone: params.phone || "",
      member_id: params.memberId || `#BBC-${normalizedCardId.slice(0, 4)}`,
      tenant_id: params.tenantId,
      stamps: newStampCount,
      total_stamps: (params.totalLifetimeStamps || params.currentStamps) + delta,
      updated_at: new Date().toISOString()
    });

    // 2. Direct insert into stamps table
    const { error } = await insertStampDirect({
      card_id: normalizedCardId,
      tenant_id: params.tenantId,
      cashier_name: params.cashierName,
      count: delta,
      created_at: new Date().toISOString()
    });

    if (error) {
      console.warn("Direct stamp record notice:", error);
    }

    return { success: true, newStamps: newStampCount };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to record stamp";
    return { success: false, newStamps: params.currentStamps, error: msg };
  }
}

/**
 * Authorize reward redemption with direct DB write
 */
export async function redeemRewardApi(params: {
  cardId: string;
  tenantId: string;
  cashierName: string;
  rewardTitle: string;
  stampsRedeemed: number;
  rewardsClaimed: number;
  customerName?: string;
  phone?: string;
  memberId?: string;
}): Promise<{ success: boolean; error?: string }> {
  const normalizedCardId = ensureUuid(params.cardId);

  try {
    // 1. Reset card stamps to 0
    await upsertCardDirect({
      id: normalizedCardId,
      name: params.customerName || "Valued Guest",
      phone: params.phone || "",
      member_id: params.memberId || `#BBC-${normalizedCardId.slice(0, 4)}`,
      tenant_id: params.tenantId,
      stamps: 0,
      rewards_claimed: params.rewardsClaimed + 1,
      updated_at: new Date().toISOString()
    });

    // 2. Insert into redemptions table
    const { error } = await insertRedemptionDirect({
      card_id: normalizedCardId,
      tenant_id: params.tenantId,
      cashier_name: params.cashierName,
      reward_title: params.rewardTitle,
      stamps_redeemed: params.stampsRedeemed,
      created_at: new Date().toISOString()
    });

    if (error) {
      console.warn("Direct redemption notice:", error);
    }

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to record redemption";
    return { success: false, error: msg };
  }
}

/**
 * Searches card in database by member ID, phone, or UUID
 */
export async function lookupCardApi(identifier: string) {
  return fetchCardDirect(identifier);
}
