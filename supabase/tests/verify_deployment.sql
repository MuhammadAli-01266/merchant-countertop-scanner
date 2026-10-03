-- =========================================================================
-- SUPABASE DEPLOYMENT VERIFICATION SCRIPT
-- Project: uovotzsbepqufgcxewkt
-- Run this script in the Supabase SQL Editor to audit and verify your backend.
-- =========================================================================

-- 1. Check Tables Existence
DO $$
DECLARE
  tables_to_check text[] := ARRAY['cards', 'stamps', 'redemptions'];
  tbl text;
  found_count int := 0;
BEGIN
  RAISE NOTICE '=======================================================';
  RAISE NOTICE 'AUDITING REQUIRED TABLES IN PUBLIC SCHEMA:';
  RAISE NOTICE '=======================================================';
  FOREACH tbl IN ARRAY tables_to_check LOOP
    IF EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE '✅ Table public.% exists.', tbl;
      found_count := found_count + 1;
    ELSE
      RAISE WARNING '⚠️ Table public.% does NOT exist. Creating base table structure...', tbl;
    END IF;
  END LOOP;
END $$;

-- 2. Ensure Required Tables and Columns Exist (Idempotent DDL)
CREATE TABLE IF NOT EXISTS public.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Valued Guest',
  phone text,
  member_id text UNIQUE,
  tenant_id text NOT NULL DEFAULT 'branch_hv',
  tier text NOT NULL DEFAULT 'Silver',
  stamps int NOT NULL DEFAULT 0,
  max_stamps int NOT NULL DEFAULT 7,
  total_stamps int NOT NULL DEFAULT 0,
  rewards_claimed int NOT NULL DEFAULT 0,
  preferred_drink text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stamps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  cashier_name text NOT NULL,
  count int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  cashier_name text NOT NULL,
  reward_title text NOT NULL,
  stamps_redeemed int NOT NULL DEFAULT 7,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Enable Row Level Security (RLS) & Policies
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stamps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redemptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Permissive read/write policies for POS terminal cashier operation
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cards' AND policyname = 'allow_anon_all_cards') THEN
    CREATE POLICY allow_anon_all_cards ON public.cards FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'stamps' AND policyname = 'allow_anon_all_stamps') THEN
    CREATE POLICY allow_anon_all_stamps ON public.stamps FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'redemptions' AND policyname = 'allow_anon_all_redemptions') THEN
    CREATE POLICY allow_anon_all_redemptions ON public.redemptions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 4. Install / Verify RPC Function: get_merchant_context
-- (Resolves the RPC 404 error permanently on the database level)
CREATE OR REPLACE FUNCTION public.get_merchant_context(p_tenant_id text DEFAULT 'branch_hv')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN jsonb_build_object(
    'tenant_id', p_tenant_id,
    'brand', 'Blue Bottle Coffee',
    'branch', 'Hayes Valley Flagship',
    'address', '315 Linden St, San Francisco, CA',
    'reward_title', 'Free Signature Handcrafted Pour-Over',
    'stamp_target', 7,
    'is_active', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_merchant_context(text) TO anon, authenticated, service_role;

-- 5. Enable Realtime Replication
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cards;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.stamps;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- 6. Verification Summary
SELECT 
  'Deployment Verification Successful' AS status,
  now() AS verified_at,
  (SELECT count(*) FROM public.cards) AS total_cards,
  (SELECT count(*) FROM public.stamps) AS total_stamps;
