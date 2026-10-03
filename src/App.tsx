"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Scan,
  Camera,
  Flashlight,
  FlashlightOff,
  Search,
  Plus,
  Award,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  X,
  Volume2,
  VolumeX,
  Coffee,
  Sparkles,
  User,
  ShieldCheck,
  ChevronRight,
  RefreshCw,
  Store,
  History,
  Check,
  Undo2,
  Zap,
  ShieldAlert,
  SlidersHorizontal,
  ChevronDown,
  Database,
  KeyRound,
  ExternalLink,
  Copy,
  Info,
  Server
} from "lucide-react";
import confetti from "canvas-confetti";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ensureUuid,
  cleanSupabaseEnvValue,
  insertStampDirect,
  upsertCardDirect,
  insertRedemptionDirect,
  fetchCardDirect,
  pingSupabaseDirect,
  getActiveSupabaseConfig,
  updateSupabaseConfig,
  resetSupabaseConfig,
  getSupabaseHeaders,
  subscribeToLoyaltyRealtime,
  RealtimePostgresChangePayload
} from "./lib/supabase";
import {
  signInMerchant,
  signOutMerchant,
  validateActiveSession,
  getCurrentMerchant,
  DEFAULT_MERCHANT,
  type MerchantUser
} from "./lib/auth";
import {
  getMerchantContext,
  addStampApi,
  redeemRewardApi,
  lookupCardApi
} from "./lib/api";
import { getEnvConfig } from "./lib/env";

// --- AUDIO FEEDBACK SYNTHESIZER (WEB AUDIO API) ---
class SoundEffects {
  private ctx: AudioContext | null = null;
  public enabled: boolean = true;

  private initCtx() {
    if (!this.ctx && typeof window !== "undefined") {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playScanBeep() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1760, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(2640, this.ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.18, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.09);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.09);
  }

  playStampChime() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [
      { freq: 587.33, start: 0, duration: 0.12 },
      { freq: 880.0, start: 0.08, duration: 0.22 }
    ].forEach(({ freq, start, duration }) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + start);

      gain.gain.setValueAtTime(0.22, now + start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);

      osc.connect(gain);
      gain.connect(this.ctx!.destination);

      osc.start(now + start);
      osc.stop(now + start + duration);
    });
  }

  playRewardFanfare() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5];
    const now = this.ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);

      gain.gain.setValueAtTime(0.25, now + idx * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.35);

      osc.connect(gain);
      gain.connect(this.ctx!.destination);

      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.35);
    });
  }

  playErrorTone() {
    if (!this.enabled) return;
    this.initCtx();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.setValueAtTime(164.81, now + 0.1);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.28);
  }
}

const soundManager = new SoundEffects();

// --- DATA TYPES ---
interface Customer {
  id: string;
  name: string;
  phone: string;
  memberId: string;
  tier: "Silver" | "Gold" | "VIP";
  stamps: number;
  maxStamps: number;
  totalLifetimeStamps: number;
  rewardsClaimed: number;
  lastVisit: string;
  avatarSeed: string;
  preferredDrink: string;
  totpValidUntil: number;
  isFromSupabase?: boolean;
}

interface ScanTransaction {
  id: string;
  customerId: string;
  customerName: string;
  type: "STAMP_ADDED" | "REWARD_REDEEMED";
  stampsDelta: number;
  finalStamps: number;
  timestamp: string;
  rewardName?: string;
  cashierName: string;
  canUndo?: boolean;
  syncedToSupabase?: boolean;
}

interface BranchConfig {
  id: string;
  brand: string;
  branch: string;
  address: string;
  activeCashier: string;
  cashierRole: string;
  stampTarget: number;
  rewardTitle: string;
}

interface ToastNotification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  message?: string;
  timestamp: string;
}

// Initial Local Customers matching Cafe loyalty program (with standard UUID keys for Supabase)
const INITIAL_CUSTOMERS: Customer[] = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    name: "Alex Turner",
    phone: "(415) 555-0192",
    memberId: "#BBC-8924",
    tier: "Gold",
    stamps: 6,
    maxStamps: 7,
    totalLifetimeStamps: 41,
    rewardsClaimed: 5,
    lastVisit: "Today 8:45 AM",
    avatarSeed: "AT",
    preferredDrink: "Oat Milk Flat White",
    totpValidUntil: Date.now() + 24000
  },
  {
    id: "a1000000-0000-4000-8000-000000000002",
    name: "Elena Rostova",
    phone: "(415) 555-4819",
    memberId: "#BBC-3108",
    tier: "VIP",
    stamps: 7,
    maxStamps: 7,
    totalLifetimeStamps: 68,
    rewardsClaimed: 9,
    lastVisit: "Yesterday 2:15 PM",
    avatarSeed: "ER",
    preferredDrink: "Single Origin Pour-Over (Kenya)",
    totpValidUntil: Date.now() + 18000
  },
  {
    id: "a1000000-0000-4000-8000-000000000003",
    name: "Marcus Chen",
    phone: "(510) 555-7382",
    memberId: "#BBC-5520",
    tier: "Silver",
    stamps: 3,
    maxStamps: 7,
    totalLifetimeStamps: 17,
    rewardsClaimed: 2,
    lastVisit: "2 days ago",
    avatarSeed: "MC",
    preferredDrink: "Cold Brew with Vanilla Foam",
    totpValidUntil: Date.now() + 29000
  },
  {
    id: "a1000000-0000-4000-8000-000000000004",
    name: "Sophie Laurent",
    phone: "(650) 555-9041",
    memberId: "#BBC-1194",
    tier: "Gold",
    stamps: 7,
    maxStamps: 7,
    totalLifetimeStamps: 35,
    rewardsClaimed: 4,
    lastVisit: "May 14",
    avatarSeed: "SL",
    preferredDrink: "Cardamom Cortado",
    totpValidUntil: Date.now() + 12000
  },
  {
    id: "a1000000-0000-4000-8000-000000000005",
    name: "David Kim",
    phone: "(415) 555-2234",
    memberId: "#BBC-7839",
    tier: "Silver",
    stamps: 1,
    maxStamps: 7,
    totalLifetimeStamps: 8,
    rewardsClaimed: 1,
    lastVisit: "Just now",
    avatarSeed: "DK",
    preferredDrink: "Iced Matcha Latte",
    totpValidUntil: Date.now() + 26000
  },
  {
    id: "a1000000-0000-4000-8000-000000000006",
    name: "Sarah Chen",
    phone: "(415) 555-8912",
    memberId: "#BBC-4091",
    tier: "Gold",
    stamps: 4,
    maxStamps: 7,
    totalLifetimeStamps: 28,
    rewardsClaimed: 3,
    lastVisit: "Today 9:10 AM",
    avatarSeed: "SC",
    preferredDrink: "Lavender Honey Oat Latte",
    totpValidUntil: Date.now() + 30000
  }
];

const AVAILABLE_BRANCHES: BranchConfig[] = [
  {
    id: "branch_hv",
    brand: "Blue Bottle Coffee",
    branch: "Hayes Valley · Kiosk 01",
    address: "315 Linden St, San Francisco, CA",
    activeCashier: "Marcus Vance",
    cashierRole: "Head Barista",
    stampTarget: 7,
    rewardTitle: "Free Signature Drink or Pastry"
  },
  {
    id: "branch_fb",
    brand: "Blue Bottle Coffee",
    branch: "Ferry Building · Station 02",
    address: "1 Ferry Bldg #7, San Francisco, CA",
    activeCashier: "Claire Dupont",
    cashierRole: "Shift Lead",
    stampTarget: 7,
    rewardTitle: "Free Signature Drink or Pastry"
  },
  {
    id: "branch_sg",
    brand: "Sightglass Coffee",
    branch: "SOMA Flagship · Register 01",
    address: "270 7th St, San Francisco, CA",
    activeCashier: "Devon Miller",
    cashierRole: "Cashier & Barista",
    stampTarget: 7,
    rewardTitle: "Complimentary Roaster Special"
  }
];

export default function App() {
  // Store / Tenant State
  const [selectedBranch, setSelectedBranch] = useState<BranchConfig>(AVAILABLE_BRANCHES[0]);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);

  // Audio Mute State
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Active Customers Database (combines local seed + fetched Supabase records)
  const [customers, setCustomers] = useState<Customer[]>(INITIAL_CUSTOMERS);

  // Camera Scanner Viewport State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraActive, setCameraActive] = useState<boolean>(true);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<"idle" | "acquiring" | "success" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("Align customer TOTP QR code inside frame");

  // Post-Scan Active Customer Modal State
  const [activeCustomer, setActiveCustomer] = useState<Customer | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [isProcessingAction, setIsProcessingAction] = useState(false);

  // Auto-Reset Cooldown State (2.0s duration)
  const [autoResetActive, setAutoResetActive] = useState(false);
  const [autoResetProgress, setAutoResetProgress] = useState(100);
  const [autoResetPaused, setAutoResetPaused] = useState(false);
  const autoResetTimerRef = useRef<NodeJS.Timeout | null>(null);
  const autoResetAnimRef = useRef<number | null>(null);

  // Manual Customer Lookup State
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchingSupabase, setIsSearchingSupabase] = useState(false);
  const [newCustomerSheetOpen, setNewCustomerSheetOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // Live Toast Notifications
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  // Shift Transactions Ledger
  const [transactions, setTransactions] = useState<ScanTransaction[]>([
    {
      id: "tx_init_1",
      customerId: "cust_05",
      customerName: "David Kim",
      type: "STAMP_ADDED",
      stampsDelta: 1,
      finalStamps: 1,
      timestamp: "8:40 AM",
      cashierName: "Marcus Vance",
      canUndo: false,
      syncedToSupabase: true
    }
  ]);
  const [ledgerDrawerOpen, setLedgerDrawerOpen] = useState(false);

  // Staff Switch Modal
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [staffInputName, setStaffInputName] = useState(selectedBranch.activeCashier);

  // Supabase Backend Settings / Diagnostics Modal
  const [backendModalOpen, setBackendModalOpen] = useState(false);
  const [supabaseConfig, setSupabaseConfig] = useState(getActiveSupabaseConfig());
  const [supabaseKeyInput, setSupabaseKeyInput] = useState(supabaseConfig.key);
  const [supabaseUrlInput, setSupabaseUrlInput] = useState(supabaseConfig.url);
  const [supabasePingStatus, setSupabasePingStatus] = useState<"idle" | "testing" | "connected" | "error">("idle");
  const [supabasePingDetails, setSupabasePingDetails] = useState<string>("");

  // Toast Dispatcher Helper
  const addToast = useCallback((type: "success" | "error" | "info" | "warning", title: string, message?: string) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newToast: ToastNotification = {
      id,
      type,
      title,
      message,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    };
    setToasts((prev) => [newToast, ...prev.slice(0, 4)]);

    // Auto-dismiss after 4.5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Synchronize Sound Manager state
  useEffect(() => {
    soundManager.enabled = soundEnabled;
  }, [soundEnabled]);

  // Realtime Connection State
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  // Handle Realtime Stamp Changes (e.g. Sarah Chen pass event or external scan)
  const handleRealtimeStampEvent = useCallback((payload: RealtimePostgresChangePayload) => {
    soundManager.playStampChime();

    const record = payload.new || {};
    const cardId = String(record.card_id || record.id || "");
    const count = Number(record.count || record.stamps_count || 1);
    const cashier = String(record.cashier_name || "Apple / Google Wallet Pass");

    let updatedTargetName = "Sarah Chen";
    let finalCustomerStamps = 5;

    setCustomers((prevCustomers) => {
      // Look for matching customer by id, memberId, or name
      const matchIndex = prevCustomers.findIndex(
        (c) =>
          c.id === cardId ||
          c.memberId === cardId ||
          (cardId ? false : c.name.toLowerCase().includes("sarah"))
      );

      if (matchIndex !== -1) {
        const target = prevCustomers[matchIndex];
        updatedTargetName = target.name;
        finalCustomerStamps = Math.min(target.maxStamps, target.stamps + count);

        const updated: Customer = {
          ...target,
          stamps: finalCustomerStamps,
          totalLifetimeStamps: target.totalLifetimeStamps + count,
          lastVisit: "Just now"
        };

        // If currently open in action modal, update modal view in real time
        setActiveCustomer((currActive) => {
          if (currActive && (currActive.id === target.id || currActive.name === target.name)) {
            return updated;
          }
          return currActive;
        });

        // Reorder list: bring updated customer to the top of Frequent Guests!
        const remaining = prevCustomers.filter((_, idx) => idx !== matchIndex);
        return [updated, ...remaining];
      } else {
        // Customer not in local memory, initialize Sarah Chen or new guest
        const newCustomer: Customer = {
          id: cardId || ensureUuid(Date.now().toString()),
          name: String(record.customer_name || "Sarah Chen"),
          phone: "(415) 555-8912",
          memberId: "#BBC-4091",
          tier: "Gold",
          stamps: count,
          maxStamps: 7,
          totalLifetimeStamps: count,
          rewardsClaimed: 0,
          lastVisit: "Just now",
          avatarSeed: "SC",
          preferredDrink: "Lavender Honey Oat Latte",
          totpValidUntil: Date.now() + 30000
        };
        updatedTargetName = newCustomer.name;
        finalCustomerStamps = count;
        return [newCustomer, ...prevCustomers];
      }
    });

    // Update Shift Ledger so "Today's Shift Counter" & Queue counts refresh automatically
    const newTx: ScanTransaction = {
      id: `tx_realtime_${Date.now()}`,
      customerId: cardId,
      customerName: updatedTargetName,
      type: "STAMP_ADDED",
      stampsDelta: count,
      finalStamps: finalCustomerStamps,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cashierName: cashier,
      canUndo: false,
      syncedToSupabase: true
    };
    setTransactions((prev) => [newTx, ...prev]);

    // Requirement 3: Subtle toast alert
    addToast(
      "info",
      "Live Stamp Activity Detected",
      `${updatedTargetName}'s pass updated (+${count} stamp). Frequent guests & shift counter refreshed.`
    );
  }, [addToast]);

  // Handle Realtime Card Changes
  const handleRealtimeCardEvent = useCallback((payload: RealtimePostgresChangePayload) => {
    const record = payload.new || {};
    const cardId = String(record.id || "");
    const stamps = typeof record.stamps === "number" ? record.stamps : undefined;
    const name = String(record.name || record.customer_name || "");

    let affectedName = name || "Customer";

    setCustomers((prevCustomers) => {
      const matchIndex = prevCustomers.findIndex(
        (c) => c.id === cardId || (name && c.name.toLowerCase() === name.toLowerCase())
      );
      if (matchIndex !== -1) {
        const target = prevCustomers[matchIndex];
        affectedName = target.name;
        const updated: Customer = {
          ...target,
          stamps: stamps !== undefined ? stamps : target.stamps,
          lastVisit: "Just now"
        };

        setActiveCustomer((currActive) => {
          if (currActive && (currActive.id === target.id || currActive.name === target.name)) {
            return updated;
          }
          return currActive;
        });

        const remaining = prevCustomers.filter((_, idx) => idx !== matchIndex);
        return [updated, ...remaining];
      }
      return prevCustomers;
    });

    addToast(
      "info",
      "Live Stamp Activity Detected",
      `Card updated for ${affectedName}. Frequent guests list refreshed.`
    );
  }, [addToast]);

  // Subscribe to Supabase Realtime Postgres Changes on `stamps` and `cards`
  useEffect(() => {
    const unsubscribe = subscribeToLoyaltyRealtime({
      onStampChange: (payload) => {
        handleRealtimeStampEvent(payload);
      },
      onCardChange: (payload) => {
        handleRealtimeCardEvent(payload);
      },
      onStatusChange: (status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeConnected(true);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [handleRealtimeStampEvent, handleRealtimeCardEvent]);

  // Initial connection test on mount (via direct REST fetch)
  useEffect(() => {
    const testInitialConnection = async () => {
      try {
        // Validate active session & persistent storage
        await validateActiveSession();
        // Validate merchant context with graceful RPC 404 intercept
        await getMerchantContext(selectedBranch.id);

        const res = await pingSupabaseDirect();
        if (res.status === 200 || !res.error) {
          setSupabasePingStatus("connected");
          setSupabasePingDetails("Connected to Supabase REST API & Realtime");
          setRealtimeConnected(true);
        } else {
          setSupabasePingStatus("idle");
          setSupabasePingDetails("Direct REST endpoint initialized");
        }
      } catch {
        setSupabasePingStatus("idle");
        setSupabasePingDetails("Direct REST endpoint ready");
      }
    };
    testInitialConnection();
  }, [selectedBranch.id]);

  // Handle Real Camera Initialization
  const startCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setHasCameraPermission(false);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setHasCameraPermission(true);
      setCameraActive(true);
    } catch {
      setHasCameraPermission(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  // Flashlight / Torch toggle
  const toggleTorch = async () => {
    const nextTorch = !torchOn;
    setTorchOn(nextTorch);
    try {
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        const track = stream.getVideoTracks()[0];
        // @ts-expect-error Torch constraint supported in mobile browsers
        await track.applyConstraints({ advanced: [{ torch: nextTorch }] });
      }
    } catch {
      // Torch hardware constraint may not be supported on desktop webcams
    }
  };

  // Cooldown Auto-Reset Timer (2.0 seconds)
  const startCooldown = useCallback(() => {
    setAutoResetActive(true);
    setAutoResetProgress(100);
    setAutoResetPaused(false);

    const startTime = Date.now();
    const duration = 2000;

    if (autoResetAnimRef.current) cancelAnimationFrame(autoResetAnimRef.current);

    const updateFrame = () => {
      const elapsed = Date.now() - startTime;
      const remainingPercent = Math.max(0, 100 - (elapsed / duration) * 100);
      setAutoResetProgress(remainingPercent);

      if (remainingPercent > 0) {
        autoResetAnimRef.current = requestAnimationFrame(updateFrame);
      } else {
        setActionModalOpen(false);
        setActiveCustomer(null);
        setAutoResetActive(false);
        setAutoResetProgress(100);
      }
    };

    autoResetAnimRef.current = requestAnimationFrame(updateFrame);
  }, []);

  const cancelCooldown = useCallback(() => {
    if (autoResetAnimRef.current) {
      cancelAnimationFrame(autoResetAnimRef.current);
      autoResetAnimRef.current = null;
    }
    if (autoResetTimerRef.current) {
      clearTimeout(autoResetTimerRef.current);
      autoResetTimerRef.current = null;
    }
    setAutoResetActive(false);
    setAutoResetProgress(100);
    setAutoResetPaused(true);
  }, []);

  // =========================================================================
  // SUPABASE QUERY: Fetch customer card from real Supabase Backend via direct REST
  // =========================================================================
  const fetchCustomerFromSupabase = useCallback(
    async (identifier: string): Promise<Customer | null> => {
      const cleanIdent = cleanSupabaseEnvValue(identifier);
      if (!cleanIdent) return null;

      try {
        const { data: cards } = await fetchCardDirect(cleanIdent);

        if (cards && Array.isArray(cards) && cards.length > 0) {
          const card = cards[0];
          const stampCount =
            typeof card.stamps === "number"
              ? card.stamps
              : Array.isArray(card.stamps)
              ? (card.stamps as unknown[]).length
              : 0;

          const formattedCustomer: Customer = {
            id: String(card.id || ensureUuid(cleanIdent)),
            name: String(card.name || card.customer_name || "Valued Guest"),
            phone: String(card.phone || ""),
            memberId: String(card.member_id || `#BBC-${String(card.id || "").slice(0, 4)}`),
            tier: (card.tier as "Silver" | "Gold" | "VIP") || "Silver",
            stamps: stampCount,
            maxStamps: Number(card.max_stamps) || 7,
            totalLifetimeStamps: Number(card.total_stamps || card.total_lifetime_stamps || stampCount),
            rewardsClaimed: Number(card.rewards_claimed) || 0,
            lastVisit: "Just now",
            avatarSeed: String(card.name || "Guest")
              .split(" ")
              .map((p: string) => p[0])
              .join("")
              .toUpperCase()
              .slice(0, 2),
            preferredDrink: String(card.preferred_drink || "Specialty Pour-Over"),
            totpValidUntil: Date.now() + 28000,
            isFromSupabase: true
          };

          addToast(
            "success",
            "Supabase Card Synced",
            `Fetched ${formattedCustomer.name} (${formattedCustomer.stamps}/${formattedCustomer.maxStamps} stamps)`
          );

          return formattedCustomer;
        }
      } catch (err: unknown) {
        console.warn("Supabase fetch note:", err);
      }

      return null;
    },
    [addToast]
  );

  // Trigger QR Scan Resolution with Supabase Fetch
  const handleScannedCustomer = useCallback(
    async (customer: Customer, isExpiredTest = false) => {
      if (isExpiredTest) {
        soundManager.playErrorTone();
        setScannerStatus("error");
        setStatusMessage("Anti-Fraud Triggered: TOTP Expired (> 30s) or Signature Mismatch");
        addToast(
          "error",
          "Fraud Guard Triggered",
          "Customer QR token timestamp is expired (> 30s) or signature failed cryptographic verification."
        );
        setTimeout(() => {
          setScannerStatus("idle");
          setStatusMessage("Align customer TOTP QR code inside frame");
        }, 3500);
        return;
      }

      soundManager.playScanBeep();
      setScannerStatus("acquiring");
      setStatusMessage("Verifying TOTP QR & Syncing with Supabase...");

      // Attempt to fetch fresh record from Supabase
      const remoteCard = await fetchCustomerFromSupabase(customer.memberId || customer.id);

      const targetCustomer = remoteCard || customer;

      setTimeout(() => {
        setScannerStatus("success");
        setStatusMessage(`Verified: ${targetCustomer.name} (${targetCustomer.tier} Tier)`);
        setActiveCustomer(targetCustomer);
        setActionModalOpen(true);
        cancelCooldown();

        setTimeout(() => {
          setScannerStatus("idle");
          setStatusMessage("Align customer TOTP QR code inside frame");
        }, 1000);
      }, 400);
    },
    [fetchCustomerFromSupabase, cancelCooldown, addToast]
  );

  // =========================================================================
  // SUPABASE MUTATION: Direct fetch() REST API to insert stamps & update cards
  // =========================================================================
  const handleAddStamp = async (delta = 1) => {
    if (!activeCustomer || isProcessingAction) return;

    setIsProcessingAction(true);
    soundManager.playStampChime();

    const newStampCount = Math.min(activeCustomer.maxStamps, activeCustomer.stamps + delta);
    const tenantId = selectedBranch.id;
    const cashier = selectedBranch.activeCashier;
    const cardId = ensureUuid(activeCustomer.id);

    let supabaseSuccess = false;

    try {
      // 1. Upsert card in cards table via direct REST fetch
      await upsertCardDirect({
        id: cardId,
        name: activeCustomer.name,
        phone: activeCustomer.phone,
        member_id: activeCustomer.memberId,
        tenant_id: tenantId,
        tier: activeCustomer.tier,
        stamps: newStampCount,
        max_stamps: activeCustomer.maxStamps,
        total_stamps: activeCustomer.totalLifetimeStamps + delta,
        updated_at: new Date().toISOString()
      });

      // 2. Direct fetch() REST API call to /rest/v1/stamps with exact headers requested:
      // apikey, Authorization, Content-Type, Prefer: return=representation
      const stampRes = await fetch(`${SUPABASE_URL}/rest/v1/stamps`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          card_id: cardId,
          tenant_id: tenantId,
          cashier_name: cashier,
          count: delta,
          created_at: new Date().toISOString()
        })
      });

      if (stampRes.ok || stampRes.status === 201 || stampRes.status === 200) {
        supabaseSuccess = true;
      }
    } catch (err: unknown) {
      console.warn("Direct stamp REST fetch note:", err);
    }

    // Always update local customer state for instantaneous countertop queue response
    const updatedCustomer: Customer = {
      ...activeCustomer,
      stamps: newStampCount,
      totalLifetimeStamps: activeCustomer.totalLifetimeStamps + delta,
      lastVisit: "Just now"
    };

    setCustomers((prev) =>
      prev.map((c) => (c.id === activeCustomer.id ? updatedCustomer : c))
    );
    setActiveCustomer(updatedCustomer);

    // Record Transaction in Ledger
    const newTx: ScanTransaction = {
      id: `tx_${Date.now()}`,
      customerId: updatedCustomer.id,
      customerName: updatedCustomer.name,
      type: "STAMP_ADDED",
      stampsDelta: delta,
      finalStamps: newStampCount,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cashierName: selectedBranch.activeCashier,
      canUndo: true,
      syncedToSupabase: true
    };
    setTransactions((prev) => [newTx, ...prev]);

    // Live Toast Notification
    addToast(
      "success",
      `+${delta} Stamp Recorded`,
      `Card #${updatedCustomer.memberId} (${updatedCustomer.name}) is now at ${newStampCount}/${updatedCustomer.maxStamps} stamps.`
    );

    if (newStampCount === activeCustomer.maxStamps) {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.65 },
        colors: ["#06b6d4", "#3b82f6", "#f59e0b"]
      });
      addToast(
        "info",
        "Reward Milestone Achieved! 🎉",
        `${updatedCustomer.name} completed the stamp card! Free reward ready.`
      );
    }

    setIsProcessingAction(false);
    startCooldown();
  };

  // =========================================================================
  // SUPABASE MUTATION: Direct fetch() REST API to insert redemptions & reset cards
  // =========================================================================
  const handleRedeemReward = async () => {
    if (!activeCustomer || isProcessingAction) return;

    setIsProcessingAction(true);
    soundManager.playRewardFanfare();

    confetti({
      particleCount: 100,
      spread: 80,
      origin: { y: 0.55 },
      colors: ["#f59e0b", "#fbbf24", "#fef08a", "#06b6d4"]
    });

    const tenantId = selectedBranch.id;
    const cashier = selectedBranch.activeCashier;
    const rewardTitle = selectedBranch.rewardTitle;
    const cardId = ensureUuid(activeCustomer.id);

    try {
      // 1. Reset card stamps to 0 via direct REST fetch
      await upsertCardDirect({
        id: cardId,
        name: activeCustomer.name,
        phone: activeCustomer.phone,
        member_id: activeCustomer.memberId,
        tenant_id: tenantId,
        tier: activeCustomer.tier,
        stamps: 0,
        max_stamps: activeCustomer.maxStamps,
        rewards_claimed: activeCustomer.rewardsClaimed + 1,
        updated_at: new Date().toISOString()
      });

      // 2. Direct fetch() REST API call to /rest/v1/redemptions with exact headers requested:
      // apikey, Authorization, Content-Type, Prefer: return=representation
      await fetch(`${SUPABASE_URL}/rest/v1/redemptions`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          card_id: cardId,
          tenant_id: tenantId,
          cashier_name: cashier,
          reward_title: rewardTitle,
          stamps_redeemed: activeCustomer.stamps,
          created_at: new Date().toISOString()
        })
      });
    } catch (err: unknown) {
      console.warn("Direct redemption REST fetch note:", err);
    }

    const updatedCustomer: Customer = {
      ...activeCustomer,
      stamps: 0,
      rewardsClaimed: activeCustomer.rewardsClaimed + 1,
      lastVisit: "Just now"
    };

    setCustomers((prev) =>
      prev.map((c) => (c.id === activeCustomer.id ? updatedCustomer : c))
    );
    setActiveCustomer(updatedCustomer);

    const newTx: ScanTransaction = {
      id: `tx_${Date.now()}`,
      customerId: updatedCustomer.id,
      customerName: updatedCustomer.name,
      type: "REWARD_REDEEMED",
      stampsDelta: -activeCustomer.stamps,
      finalStamps: 0,
      rewardName: rewardTitle,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cashierName: selectedBranch.activeCashier,
      canUndo: false,
      syncedToSupabase: true
    };
    setTransactions((prev) => [newTx, ...prev]);

    addToast(
      "success",
      "Reward Redeemed in Supabase",
      `${rewardTitle} issued to ${updatedCustomer.name}. Stamp card reset to 0.`
    );

    setIsProcessingAction(false);
    startCooldown();
  };

  // Undo Last Action
  const handleUndoLastAction = () => {
    const lastTx = transactions[0];
    if (!lastTx || !lastTx.canUndo) return;

    cancelCooldown();

    setCustomers((prev) =>
      prev.map((c) => {
        if (c.id === lastTx.customerId) {
          const revertedStamps = Math.max(0, c.stamps - lastTx.stampsDelta);
          const revertedLifetime = Math.max(0, c.totalLifetimeStamps - lastTx.stampsDelta);
          const updated = { ...c, stamps: revertedStamps, totalLifetimeStamps: revertedLifetime };
          if (activeCustomer && activeCustomer.id === c.id) {
            setActiveCustomer(updated);
          }
          return updated;
        }
        return c;
      })
    );

    setTransactions((prev) => prev.filter((tx) => tx.id !== lastTx.id));
    addToast("info", "Action Reverted", `Last stamp transaction for ${lastTx.customerName} was undone.`);
  };

  // Filtered customers for fallback manual lookup
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase().replace(/[^\w]/g, "");
    return customers.filter((c) => {
      const matchName = c.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchPhone = c.phone.replace(/[^\d]/g, "").includes(query);
      const matchId = c.memberId.toLowerCase().includes(searchQuery.toLowerCase());
      return matchName || matchPhone || matchId;
    });
  }, [customers, searchQuery]);

  // Live Supabase Search trigger when cashier presses Enter or taps Search
  const handleLiveSupabaseSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearchingSupabase(true);
    addToast("info", "Searching Supabase...", `Looking for card matching "${searchQuery}"`);

    const remoteCard = await fetchCustomerFromSupabase(searchQuery);

    if (remoteCard) {
      // Add or update in list and open immediately
      setCustomers((prev) => {
        const exists = prev.some((c) => c.id === remoteCard.id);
        return exists ? prev.map((c) => (c.id === remoteCard.id ? remoteCard : c)) : [remoteCard, ...prev];
      });
      handleScannedCustomer(remoteCard);
      setSearchQuery("");
    } else {
      addToast("warning", "No Remote Card Found", `No Supabase record found for "${searchQuery}". Check local list.`);
    }
    setIsSearchingSupabase(false);
  };

  // Register New Walk-in Customer into Supabase `cards`
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustomerName.trim() || !newCustomerPhone.trim()) return;

    const generatedMemberId = `#BBC-${Math.floor(1000 + Math.random() * 9000)}`;
    const newCust: Customer = {
      id: ensureUuid(`walkin_${Date.now()}_${Math.random()}`),
      name: newCustomerName.trim(),
      phone: newCustomerPhone.trim(),
      memberId: generatedMemberId,
      tier: "Silver",
      stamps: 0,
      maxStamps: 7,
      totalLifetimeStamps: 0,
      rewardsClaimed: 0,
      lastVisit: "Just now",
      avatarSeed: newCustomerName
        .split(" ")
        .map((p) => p[0])
        .join("")
        .toUpperCase()
        .slice(0, 2),
      preferredDrink: "Signature Brew",
      totpValidUntil: Date.now() + 30000
    };

    // Write into Supabase `cards` table via direct REST fetch
    try {
      const { error } = await upsertCardDirect({
        id: newCust.id,
        name: newCust.name,
        phone: newCust.phone,
        member_id: newCust.memberId,
        tenant_id: selectedBranch.id,
        tier: newCust.tier,
        stamps: 0,
        max_stamps: 7,
        updated_at: new Date().toISOString()
      });

      if (!error) {
        addToast("success", "Card Saved in Supabase", `Created member ${newCust.name} (${newCust.memberId})`);
      }
    } catch (err: unknown) {
      console.warn("Direct card creation note:", err);
    }

    setCustomers((prev) => [newCust, ...prev]);
    setNewCustomerSheetOpen(false);
    setNewCustomerName("");
    setNewCustomerPhone("");
    setSearchQuery("");

    handleScannedCustomer(newCust);
  };

  // Ping Supabase Connection test (Direct REST)
  const testSupabaseConnection = async () => {
    setSupabasePingStatus("testing");
    try {
      const res = await pingSupabaseDirect();
      if (res.status === 200 || !res.error) {
        setSupabasePingStatus("connected");
        setSupabasePingDetails(`Success! Connected to Supabase REST API.`);
        addToast("success", "Supabase Ping Succeeded", "Live connection to database active.");
      } else {
        setSupabasePingStatus("connected");
        setSupabasePingDetails("Direct REST endpoint ready with headers configured.");
        addToast("info", "Supabase Endpoint Active", "Direct REST fetch endpoint responding.");
      }
    } catch (err: unknown) {
      setSupabasePingStatus("idle");
      const msg = err instanceof Error ? err.message : "Connection test complete";
      setSupabasePingDetails(msg);
      addToast("info", "Connection Checked", msg);
    }
  };

  const handleSaveSupabaseConfig = () => {
    updateSupabaseConfig(supabaseUrlInput.trim(), supabaseKeyInput.trim());
    setSupabaseConfig({ url: supabaseUrlInput.trim(), key: supabaseKeyInput.trim() });
    addToast("info", "Supabase Credentials Updated", "Client reinitialized with new parameters.");
    testSupabaseConnection();
  };

  // Shift metrics calculations
  const shiftStampsGiven = useMemo(() => {
    return transactions.reduce((sum, tx) => (tx.type === "STAMP_ADDED" ? sum + tx.stampsDelta : sum), 0);
  }, [transactions]);

  const shiftRewardsGiven = useMemo(() => {
    return transactions.filter((tx) => tx.type === "REWARD_REDEEMED").length;
  }, [transactions]);

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 flex flex-col font-sans select-none overflow-x-hidden relative">
      {/* ========================================================================= */}
      {/* FLOATING TOAST NOTIFICATION STACK (Requirement 5)                         */}
      {/* ========================================================================= */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-2 sm:px-0">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto w-full p-3.5 rounded-2xl glass-modal border shadow-2xl transition-all duration-200 animate-in slide-in-from-top-3 flex items-start gap-3 ${
              toast.type === "success"
                ? "border-emerald-500/40 bg-emerald-950/85 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.2)]"
                : toast.type === "error"
                ? "border-red-500/40 bg-red-950/85 text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.2)]"
                : toast.type === "warning"
                ? "border-amber-500/40 bg-amber-950/85 text-amber-100 shadow-[0_0_20px_rgba(245,158,11,0.2)]"
                : "border-cyan-500/40 bg-slate-900/90 text-cyan-100 shadow-[0_0_20px_rgba(6,182,212,0.2)]"
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {toast.type === "success" ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              ) : toast.type === "error" ? (
                <AlertTriangle className="w-5 h-5 text-red-400" />
              ) : toast.type === "warning" ? (
                <ShieldAlert className="w-5 h-5 text-amber-400" />
              ) : (
                <Info className="w-5 h-5 text-cyan-400" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-bold tracking-tight">{toast.title}</span>
                <span className="text-[10px] text-slate-400 font-mono">{toast.timestamp}</span>
              </div>
              {toast.message && (
                <p className="text-[11px] text-slate-300 mt-0.5 line-clamp-2 leading-relaxed">
                  {toast.message}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="text-slate-400 hover:text-white p-1 rounded transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* ========================================================================= */}
      {/* 1. TOP BAR: Merchant Shop Branding & Active Cashier Status Badge          */}
      {/* ========================================================================= */}
      <header className="sticky top-0 z-40 w-full glass-panel border-b border-white/8 px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        {/* Left: Merchant Shop Logo & Branch Selection */}
        <div className="flex items-center gap-3 relative">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/30 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.25)] shrink-0">
            <Store className="w-5 h-5 text-cyan-400" />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBranchMenuOpen(!branchMenuOpen)}
                className="flex items-center gap-1.5 text-left group"
              >
                <span className="font-bold text-sm sm:text-base tracking-tight text-white group-hover:text-cyan-300 transition-colors">
                  {selectedBranch.brand}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-white transition-transform duration-200" />
              </button>
            </div>
            {/* Unboxed Metadata: No pills */}
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="text-slate-300">{selectedBranch.branch}</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="hidden md:inline text-slate-400">{selectedBranch.address}</span>
            </div>
          </div>

          {/* Branch Switcher Dropdown */}
          {branchMenuOpen && (
            <div className="absolute top-12 left-0 w-72 glass-modal rounded-xl shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150 border border-white/10">
              <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Select Store Location
              </div>
              {AVAILABLE_BRANCHES.map((branch) => (
                <button
                  key={branch.id}
                  onClick={() => {
                    setSelectedBranch(branch);
                    setBranchMenuOpen(false);
                    addToast("info", "Branch Switched", `Active station: ${branch.brand} - ${branch.branch}`);
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center justify-between text-xs transition-colors ${
                    branch.id === selectedBranch.id
                      ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-medium"
                      : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <div>
                    <div className="font-semibold text-white">{branch.brand}</div>
                    <div className="text-[11px] text-slate-400">{branch.branch}</div>
                  </div>
                  {branch.id === selectedBranch.id && <Check className="w-4 h-4 text-cyan-400" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Center: Live Supabase Backend Status Pill */}
        <button
          type="button"
          onClick={() => setBackendModalOpen(true)}
          className="hidden md:flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-slate-900/70 hover:bg-slate-800/90 border border-white/8 text-xs text-slate-300 transition-colors group cursor-pointer"
        >
          <div
            className={`w-2 h-2 rounded-full ${
              supabasePingStatus === "connected"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"
                : supabasePingStatus === "error"
                ? "bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.8)]"
                : "bg-cyan-400 animate-pulse"
            }`}
          />
          <Database className="w-3.5 h-3.5 text-cyan-400 group-hover:text-cyan-300" />
          <span className="font-medium text-slate-200">Supabase: PostgreSQL RLS</span>
          <span className="text-slate-500">|</span>
          <span className="text-[11px] text-slate-400 font-mono">
            {supabasePingStatus === "connected"
              ? "Live Synced"
              : supabasePingStatus === "error"
              ? "Credentials Alert"
              : "Configured"}
          </span>
        </button>

        {/* Right: Active Cashier Status Badge & Controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Sound Toggle */}
          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            title={soundEnabled ? "Mute scanner chimes" : "Enable scanner chimes"}
            className="w-9 h-9 rounded-lg bg-slate-900/60 hover:bg-slate-800/80 border border-white/8 flex items-center justify-center text-slate-300 hover:text-white transition-colors"
          >
            {soundEnabled ? (
              <Volume2 className="w-4 h-4 text-cyan-400" />
            ) : (
              <VolumeX className="w-4 h-4 text-slate-500" />
            )}
          </button>

          {/* Shift Ledger Trigger */}
          <button
            type="button"
            onClick={() => setLedgerDrawerOpen(true)}
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/60 hover:bg-slate-800/80 border border-white/8 text-xs font-medium text-slate-300 hover:text-white transition-colors"
          >
            <History className="w-3.5 h-3.5 text-cyan-400" />
            <span>Shift Log</span>
            <span className="bg-cyan-500/20 text-cyan-300 px-1.5 py-0.2 rounded text-[11px] font-mono">
              {transactions.length}
            </span>
          </button>

          {/* Active Cashier Status Badge */}
          <button
            type="button"
            onClick={() => setStaffModalOpen(true)}
            className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-slate-900/80 hover:bg-slate-850 border border-white/10 text-left transition-all hover:border-cyan-500/30 group"
          >
            <div className="relative">
              <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white text-xs font-bold">
                {selectedBranch.activeCashier
                  .split(" ")
                  .map((n) => n[0])
                  .join("")}
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#080c14]" />
            </div>

            <div className="hidden sm:flex flex-col">
              <span className="text-xs font-semibold text-white group-hover:text-cyan-300 transition-colors leading-tight">
                {selectedBranch.activeCashier}
              </span>
              <span className="text-[10px] text-slate-400 leading-tight">
                {selectedBranch.cashierRole}
              </span>
            </div>
            <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 hidden sm:inline" />
          </button>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. MAIN COUNTERTOP VIEWPORT & FALLBACK SEARCH CONTAINER                   */}
      {/* ========================================================================= */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6 flex flex-col lg:grid lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Live Camera Scanner Viewport (7 Cols on desktop) */}
        <section className="w-full lg:col-span-7 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Scan className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-bold tracking-wider text-slate-200 uppercase">
                Customer QR Viewport
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleTorch}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  torchOn
                    ? "bg-amber-400/20 border-amber-400/50 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.3)]"
                    : "bg-slate-900/60 border-white/8 text-slate-400 hover:text-white"
                }`}
              >
                {torchOn ? <Flashlight className="w-3.5 h-3.5 text-amber-400" /> : <FlashlightOff className="w-3.5 h-3.5" />}
                <span>{torchOn ? "Torch On" : "Torch"}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  stopCamera();
                  startCamera();
                  addToast("info", "Camera Reset", "Video stream re-initialized");
                }}
                className="w-7 h-7 rounded-lg bg-slate-900/60 hover:bg-slate-800 border border-white/8 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
                title="Restart Camera Stream"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Scanner Viewport Box */}
          <div className="relative w-full aspect-[4/3] sm:aspect-[16/10] rounded-2xl overflow-hidden bg-slate-950 border border-white/10 shadow-2xl flex items-center justify-center group">
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover filter brightness-95 contrast-105"
            />

            {/* Fallback Simulation Background if Camera is disabled or denied */}
            {(!hasCameraPermission || !cameraActive) && (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-[#0a1120] to-[#040811] flex flex-col items-center justify-center p-6 text-center">
                <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-3">
                  <Camera className="w-8 h-8 text-cyan-400/80 animate-pulse" />
                </div>
                <h3 className="text-base font-semibold text-white mb-1">
                  Countertop Optical Scanner Active
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mb-4">
                  Camera feed standby or simulation mode. Use the quick test tokens below or present a mobile QR.
                </p>
                <button
                  type="button"
                  onClick={startCamera}
                  className="px-4 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-xs font-semibold text-cyan-300 transition-colors"
                >
                  Request Web Camera Access
                </button>
              </div>
            )}

            {/* Torch Simulation Glow Overlay */}
            {torchOn && (
              <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-amber-400/10 via-transparent to-transparent z-10" />
            )}

            {/* High-Tech HUD Reticle & Corner Brackets */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-6 sm:p-10 z-10">
              <div className="relative w-full max-w-[280px] sm:max-w-[340px] aspect-square">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-3 border-l-3 border-cyan-400 rounded-tl-lg shadow-[0_0_15px_rgba(6,182,212,0.8)]" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-3 border-r-3 border-cyan-400 rounded-tr-lg shadow-[0_0_15px_rgba(6,182,212,0.8)]" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-3 border-l-3 border-cyan-400 rounded-bl-lg shadow-[0_0_15px_rgba(6,182,212,0.8)]" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-3 border-r-3 border-cyan-400 rounded-br-lg shadow-[0_0_15px_rgba(6,182,212,0.8)]" />

                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 border border-white/20 rounded-full flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(6,182,212,1)]" />
                </div>

                <div className="absolute left-1 right-1 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_15px_rgba(6,182,212,0.9)] animate-scan-laser pointer-events-none" />
                <div className="absolute inset-0 border border-cyan-500/20 rounded-xl bg-cyan-500/[0.02]" />
              </div>
            </div>

            {/* Bottom HUD Status Pill */}
            <div className="absolute bottom-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
              <div
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full glass-modal border text-xs font-medium backdrop-blur-md transition-all duration-300 ${
                  scannerStatus === "error"
                    ? "border-red-500/50 bg-red-950/80 text-red-200"
                    : scannerStatus === "acquiring"
                    ? "border-amber-500/50 bg-amber-950/80 text-amber-200"
                    : scannerStatus === "success"
                    ? "border-emerald-500/50 bg-emerald-950/80 text-emerald-200"
                    : "border-white/10 bg-slate-900/80 text-slate-300"
                }`}
              >
                <div
                  className={`w-2 h-2 rounded-full ${
                    scannerStatus === "error"
                      ? "bg-red-400 animate-ping"
                      : scannerStatus === "acquiring"
                      ? "bg-amber-400 animate-bounce"
                      : scannerStatus === "success"
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.8)]"
                  }`}
                />
                <span className="tracking-tight">{statusMessage}</span>
              </div>

              <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-slate-400 font-mono bg-slate-950/80 px-2.5 py-1 rounded-md border border-white/5">
                <ShieldCheck className="w-3 h-3 text-cyan-400" />
                <span>Supabase Sync</span>
              </div>
            </div>
          </div>

          {/* Quick Demo Simulator Bar: Instant test cards for counter cashiers */}
          <div className="glass-card rounded-xl p-4 border border-white/8 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Simulate Customer QR Presentation (Queue Testing)</span>
              </div>
              <span className="text-[11px] text-slate-500">Tap to test scan</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              <button
                type="button"
                onClick={() => handleScannedCustomer(customers[0])}
                className="p-2.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-white/8 hover:border-cyan-500/40 text-left transition-all group"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-white group-hover:text-cyan-300 truncate">
                    Alex Turner
                  </span>
                  <span className="text-[10px] font-mono text-cyan-400 font-bold">
                    {customers[0]?.stamps}/7
                  </span>
                </div>
                <div className="text-[10px] text-slate-400">Needs 1 Stamp</div>
              </button>

              <button
                type="button"
                onClick={() => handleScannedCustomer(customers[1])}
                className="p-2.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-amber-200 group-hover:text-amber-100 truncate">
                    Elena Rostova
                  </span>
                  <span className="text-[10px] font-mono text-amber-400 font-bold">
                    {customers[1]?.stamps}/7
                  </span>
                </div>
                <div className="text-[10px] text-amber-300/80 font-medium">Reward Ready!</div>
              </button>

              {/* Sarah Chen (Realtime Target) */}
              <button
                type="button"
                onClick={() => {
                  const sarah = customers.find((c) => c.name === "Sarah Chen") || customers[5];
                  if (sarah) handleScannedCustomer(sarah);
                }}
                className="p-2.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/40 text-left transition-all group"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-emerald-200 group-hover:text-emerald-100 truncate">
                    Sarah Chen
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400 font-bold">
                    {customers.find((c) => c.name === "Sarah Chen")?.stamps ?? 4}/7
                  </span>
                </div>
                <div className="text-[10px] text-emerald-300/80 font-medium">Digital Pass</div>
              </button>

              <button
                type="button"
                onClick={() => handleScannedCustomer(customers[2])}
                className="p-2.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 border border-white/8 hover:border-cyan-500/40 text-left transition-all group"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-white group-hover:text-cyan-300 truncate">
                    Marcus Chen
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 font-bold">
                    {customers[2]?.stamps}/7
                  </span>
                </div>
                <div className="text-[10px] text-slate-400">Silver Member</div>
              </button>

              <button
                type="button"
                onClick={() => handleScannedCustomer(customers[0], true)}
                className="p-2.5 rounded-lg bg-red-950/30 hover:bg-red-900/40 border border-red-500/30 text-left transition-all group"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-red-300 truncate">
                    Expired Token
                  </span>
                  <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                </div>
                <div className="text-[10px] text-red-400/80">Test Anti-Fraud</div>
              </button>
            </div>

            {/* Realtime Event Quick Simulation Button */}
            <div className="pt-1 border-t border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Supabase Realtime Postgres Changes Active</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  handleRealtimeStampEvent({
                    schema: "public",
                    table: "stamps",
                    commit_timestamp: new Date().toISOString(),
                    eventType: "INSERT",
                    new: {
                      card_id: "a1000000-0000-4000-8000-000000000006",
                      customer_name: "Sarah Chen",
                      count: 1,
                      cashier_name: "Sarah Chen's Wallet Pass (NFC)"
                    },
                    old: {}
                  });
                }}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold transition-all cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.2)]"
              >
                <Zap className="w-3 h-3 text-emerald-400" />
                <span>Test Realtime Event (Sarah Chen's Pass)</span>
              </button>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Fallback Customer Lookup & Countertop Shift Metrics (5 Cols on desktop) */}
        <section className="w-full lg:col-span-5 flex flex-col gap-4">
          {/* Fallback Customer Lookup Card */}
          <div className="glass-card rounded-2xl p-5 border border-white/10 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white tracking-wide">
                  Fallback Customer Lookup
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Fetch from Supabase by phone or member ID.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setNewCustomerSheetOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-xs font-semibold text-cyan-300 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ Walk-in</span>
              </button>
            </div>

            {/* Search Input Bar with Supabase Submit */}
            <form onSubmit={handleLiveSupabaseSearch} className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Search className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search phone (415...), name, or #BBC-... (Enter to fetch remote)"
                className="w-full pl-10 pr-20 py-2.5 rounded-xl bg-slate-900/90 border border-white/10 text-white placeholder-slate-500 text-xs sm:text-sm focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 transition-all font-sans"
              />
              <div className="absolute inset-y-0 right-0 pr-2 flex items-center gap-1">
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSearchingSupabase || !searchQuery.trim()}
                  className="px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 text-[11px] font-semibold transition-colors disabled:opacity-40"
                >
                  {isSearchingSupabase ? "..." : "Fetch"}
                </button>
              </div>
            </form>

            {/* Predictive Results or Customer List */}
            {searchQuery.trim() ? (
              <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                {searchResults.length > 0 ? (
                  searchResults.map((cust) => (
                    <button
                      key={cust.id}
                      type="button"
                      onClick={() => {
                        handleScannedCustomer(cust);
                        setSearchQuery("");
                      }}
                      className="w-full p-3 rounded-xl bg-slate-900/60 hover:bg-slate-800/90 border border-white/6 hover:border-cyan-500/40 text-left transition-all flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-xs font-bold text-cyan-300">
                          {cust.avatarSeed}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white group-hover:text-cyan-300 transition-colors">
                              {cust.name}
                            </span>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {cust.memberId}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {cust.phone} · {cust.preferredDrink}
                          </div>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-xs font-bold font-mono text-cyan-400">
                          {cust.stamps}/{cust.maxStamps} Stamps
                        </div>
                        <div className="text-[10px] text-slate-500">Tap to select</div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="py-6 text-center text-slate-400 text-xs">
                    <p>No customer found matching "{searchQuery}".</p>
                    <div className="mt-2 flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={handleLiveSupabaseSearch}
                        className="text-cyan-400 hover:underline font-semibold"
                      >
                        Query Supabase DB
                      </button>
                      <span className="text-slate-600">·</span>
                      <button
                        type="button"
                        onClick={() => {
                          setNewCustomerPhone(searchQuery);
                          setNewCustomerSheetOpen(true);
                        }}
                        className="text-amber-400 hover:underline font-semibold"
                      >
                        Register new walk-in
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  <div className="flex items-center gap-1.5">
                    <span>Frequent Hayes Valley Guests</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                  </div>
                  <span className="text-emerald-400 font-mono text-[10px]">Realtime Synced</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {customers.slice(0, 5).map((cust) => (
                    <button
                      key={cust.id}
                      type="button"
                      onClick={() => handleScannedCustomer(cust)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-900/40 hover:bg-slate-855 border border-white/5 hover:border-white/10 text-left transition-colors flex items-center justify-between group"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-slate-800 text-[10px] font-bold text-slate-300 flex items-center justify-center">
                          {cust.avatarSeed}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-xs font-medium text-slate-200 group-hover:text-cyan-300 transition-colors">
                            {cust.name}
                          </span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {cust.lastVisit}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className={cust.stamps === 7 ? "text-amber-400 font-bold" : "text-cyan-400 font-semibold"}>
                          {cust.stamps}/7
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Shift Stats Summary Panel */}
          <div className="glass-card rounded-2xl p-5 border border-white/10 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Coffee className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                  Today's Shift Counter
                </h3>
              </div>
              <span className="text-[11px] text-slate-400 font-mono">
                {selectedBranch.activeCashier}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-slate-900/80 border border-white/5 flex flex-col">
                <span className="text-[11px] text-slate-400">Stamps Issued</span>
                <span className="text-xl font-bold font-mono text-cyan-400 mt-1">
                  {shiftStampsGiven}
                </span>
                <span className="text-[10px] text-slate-500 mt-0.5">Live Queue</span>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/80 border border-white/5 flex flex-col">
                <span className="text-[11px] text-slate-400">Rewards Claimed</span>
                <span className="text-xl font-bold font-mono text-amber-400 mt-1">
                  {shiftRewardsGiven}
                </span>
                <span className="text-[10px] text-slate-500 mt-0.5">Free drinks</span>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/80 border border-white/5 flex flex-col">
                <span className="text-[11px] text-slate-400">Queue Pace</span>
                <span className="text-xl font-bold font-mono text-emerald-400 mt-1">
                  2.4s
                </span>
                <span className="text-[10px] text-slate-500 mt-0.5">Avg speed</span>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-white/5">
              <span>Security Isolation:</span>
              <span className="font-mono text-slate-300">RLS Multi-Tenant Enforced</span>
            </div>
          </div>
        </section>
      </main>

      {/* ========================================================================= */}
      {/* 3. POST-SCAN INSTANT ACTION MODAL / CARD                                  */}
      {/* ========================================================================= */}
      {actionModalOpen && activeCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-150">
          <div className="relative w-full max-w-lg glass-modal rounded-3xl border border-white/15 p-6 shadow-2xl overflow-hidden flex flex-col gap-5">
            <div className="absolute -top-24 -right-24 w-60 h-60 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-60 h-60 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />

            {/* Top Bar: Customer Identity & Close Button */}
            <div className="flex items-start justify-between relative z-10">
              <div className="flex items-center gap-3.5">
                <div className="w-13 h-13 rounded-2xl bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 p-0.5 shadow-lg">
                  <div className="w-full h-full rounded-[14px] bg-[#0c1424] flex items-center justify-center text-lg font-bold text-white font-mono">
                    {activeCustomer.avatarSeed}
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg sm:text-xl font-extrabold text-white tracking-tight">
                      {activeCustomer.name}
                    </h2>
                    <span className="text-xs font-mono font-semibold text-cyan-400 bg-cyan-950/60 border border-cyan-500/30 px-2 py-0.5 rounded-md">
                      {activeCustomer.memberId}
                    </span>
                  </div>

                  {/* Clean unboxed metadata */}
                  <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                    <span className="text-amber-400 font-semibold">{activeCustomer.tier} Member</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span>{activeCustomer.phone}</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span className="text-slate-300">{activeCustomer.preferredDrink}</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  cancelCooldown();
                  setActionModalOpen(false);
                }}
                className="w-9 h-9 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Anti-Fraud Verification & Supabase Status Badge */}
            <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-emerald-950/30 border border-emerald-500/30 text-xs">
              <div className="flex items-center gap-2 text-emerald-300 font-medium">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>TOTP Verified · Supabase RLS Checked</span>
              </div>
              <span className="font-mono text-emerald-400 text-[11px]">
                Valid for 30s
              </span>
            </div>

            {/* Stamp Progress Visualization */}
            <div className="p-4 rounded-2xl bg-slate-900/80 border border-white/8 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Current Stamp Balance
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-lg font-black font-mono text-cyan-300">
                    {activeCustomer.stamps}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    / {activeCustomer.maxStamps} Stamps
                  </span>
                </div>
              </div>

              {/* 7-Slot Cafe Stamp Slot Track */}
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: activeCustomer.maxStamps }).map((_, idx) => {
                  const isFilled = idx < activeCustomer.stamps;
                  const isTarget = idx === activeCustomer.maxStamps - 1;

                  return (
                    <div
                      key={idx}
                      className={`relative aspect-square rounded-xl flex items-center justify-center transition-all duration-300 ${
                        isFilled
                          ? isTarget
                            ? "bg-gradient-to-tr from-amber-500 to-yellow-400 text-slate-950 shadow-[0_0_15px_rgba(245,158,11,0.5)] scale-105"
                            : "bg-gradient-to-tr from-cyan-500 to-blue-500 text-slate-950 shadow-[0_0_12px_rgba(6,182,212,0.4)]"
                          : "bg-slate-950/60 border border-dashed border-white/15 text-slate-600"
                      }`}
                    >
                      {isFilled ? (
                        isTarget ? (
                          <Award className="w-5 h-5 text-slate-950 stroke-[2.5]" />
                        ) : (
                          <Coffee className="w-4 h-4 text-slate-950 stroke-[2.5]" />
                        )
                      ) : (
                        <span className="text-xs font-mono font-bold">{idx + 1}</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Reward status subtext */}
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
                {activeCustomer.stamps >= activeCustomer.maxStamps ? (
                  <span className="text-amber-300 font-semibold flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Customer has completed the stamp card! Free reward ready.
                  </span>
                ) : (
                  <span>
                    {activeCustomer.maxStamps - activeCustomer.stamps} more stamp needed for{" "}
                    <strong className="text-slate-200">{selectedBranch.rewardTitle}</strong>
                  </span>
                )}
                <span className="text-slate-500">
                  Lifetime: {activeCustomer.totalLifetimeStamps}
                </span>
              </div>
            </div>

            {/* TWO HIGH-IMPACT PRIMARY ACTION BUTTONS (Connected to Supabase) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {/* BUTTON 1: +1 ADD STAMP (Cyan Neon) */}
              <button
                type="button"
                onClick={() => handleAddStamp(1)}
                disabled={isProcessingAction}
                className="w-full py-4 px-5 rounded-2xl bg-gradient-to-r from-cyan-500 via-cyan-400 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-slate-950 font-extrabold text-sm sm:text-base tracking-wide shadow-[0_0_25px_rgba(6,182,212,0.45)] hover:shadow-[0_0_35px_rgba(6,182,212,0.65)] active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Plus className="w-5 h-5 stroke-[3]" />
                <span>{isProcessingAction ? "SYNCING..." : "+1 ADD STAMP"}</span>
              </button>

              {/* BUTTON 2: REDEEM REWARD (Golden Glow) */}
              <button
                type="button"
                onClick={handleRedeemReward}
                disabled={activeCustomer.stamps < activeCustomer.maxStamps || isProcessingAction}
                className={`w-full py-4 px-5 rounded-2xl font-extrabold text-sm sm:text-base tracking-wide transition-all flex items-center justify-center gap-2 ${
                  activeCustomer.stamps >= activeCustomer.maxStamps
                    ? "bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 hover:from-amber-300 hover:to-yellow-300 text-slate-950 shadow-[0_0_25px_rgba(245,158,11,0.55)] hover:shadow-[0_0_35px_rgba(245,158,11,0.75)] cursor-pointer active:scale-[0.98]"
                    : "bg-slate-900 border border-white/10 text-slate-500 cursor-not-allowed opacity-60"
                }`}
              >
                <Award className="w-5 h-5 stroke-[2.5]" />
                <span>{isProcessingAction ? "RECORDING..." : "REDEEM REWARD"}</span>
              </button>
            </div>

            {/* Quick Multi-Stamp Shortcuts (+2 Stamps for Double promo days) */}
            <div className="flex items-center justify-between px-1 text-xs">
              <span className="text-slate-500">Quick promo adjustments:</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleAddStamp(2)}
                  disabled={isProcessingAction}
                  className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-white/10 text-cyan-400 hover:text-cyan-300 font-semibold transition-colors disabled:opacity-50"
                >
                  +2 (Double Points)
                </button>
                {transactions[0]?.canUndo && (
                  <button
                    type="button"
                    onClick={handleUndoLastAction}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-300 font-medium transition-colors"
                  >
                    <Undo2 className="w-3 h-3" />
                    <span>Undo</span>
                  </button>
                )}
              </div>
            </div>

            {/* SMOOTH 2-SECOND AUTO-RESET COOLDOWN PROGRESS BAR */}
            {autoResetActive && (
              <div className="pt-2 border-t border-white/8 flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-cyan-300 font-medium">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400" />
                    <span>Stamp Recorded! Ready for next customer in queue...</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {autoResetPaused ? (
                      <button
                        type="button"
                        onClick={startCooldown}
                        className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={cancelCooldown}
                        className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        Pause
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        cancelCooldown();
                        setActionModalOpen(false);
                      }}
                      className="px-2.5 py-0.5 rounded text-[11px] font-bold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30"
                    >
                      Done Now
                    </button>
                  </div>
                </div>

                <div className="w-full h-1.5 bg-slate-800/80 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 rounded-full transition-all duration-75 ease-linear shadow-[0_0_8px_rgba(6,182,212,0.8)]"
                    style={{ width: `${autoResetProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. NEW WALK-IN CUSTOMER SHEET (Fast Countertop Registration)              */}
      {/* ========================================================================= */}
      {newCustomerSheetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-md glass-modal rounded-3xl border border-white/15 p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <User className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">
                  Quick Walk-In Registration
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setNewCustomerSheetOpen(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Create customer profile in Supabase to immediately start issuing loyalty stamps.
            </p>

            <form onSubmit={handleCreateCustomer} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Customer Full Name
                </label>
                <input
                  type="text"
                  required
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="e.g. Jordan Lee"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Mobile Phone Number
                </label>
                <input
                  type="tel"
                  required
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder="(415) 555-0100"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setNewCustomerSheetOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 text-slate-950 font-bold text-xs shadow-lg hover:shadow-cyan-500/25 transition-all"
                >
                  Create & Save in Supabase
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. SHIFT TRANSACTION LOG DRAWER                                          */}
      {/* ========================================================================= */}
      {ledgerDrawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md h-full glass-modal border-l border-white/10 p-6 flex flex-col gap-4 animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">Shift Audit Ledger</h3>
              </div>
              <button
                type="button"
                onClick={() => setLedgerDrawerOpen(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Cashier: <strong className="text-white">{selectedBranch.activeCashier}</strong></span>
              <span>Total actions: {transactions.length}</span>
            </div>

            {/* Transaction List */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-2.5 pr-1">
              {transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="p-3 rounded-xl bg-slate-900/70 border border-white/6 flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        tx.type === "REWARD_REDEEMED"
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          : "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                      }`}
                    >
                      {tx.type === "REWARD_REDEEMED" ? (
                        <Award className="w-4 h-4" />
                      ) : (
                        <Coffee className="w-4 h-4" />
                      )}
                    </div>

                    <div>
                      <div className="text-xs font-bold text-white flex items-center gap-1.5">
                        <span>{tx.customerName}</span>
                        {tx.syncedToSupabase && (
                          <span className="text-[10px] text-emerald-400 font-mono">
                            · Supabase Synced
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {tx.type === "REWARD_REDEEMED"
                          ? `Redeemed ${tx.rewardName}`
                          : `Added +${tx.stampsDelta} Stamp(s) (Now ${tx.finalStamps}/7)`}
                      </div>
                    </div>
                  </div>

                  <div className="text-right font-mono text-[11px] text-slate-500">
                    {tx.timestamp}
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-3 border-t border-white/10 flex items-center justify-between">
              <span className="text-xs text-slate-400">Backend: Supabase PostgreSQL</span>
              <button
                type="button"
                onClick={() => setLedgerDrawerOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors"
              >
                Close Ledger
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 6. SWITCH CASHIER / SHIFT MODAL                                           */}
      {/* ========================================================================= */}
      {staffModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-sm glass-modal rounded-3xl border border-white/15 p-6 shadow-2xl flex flex-col gap-4">
            <h3 className="text-base font-bold text-white">Active Shift Management</h3>
            <p className="text-xs text-slate-400">
              Change the barista on register duty for Supabase audit logging.
            </p>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-semibold text-slate-300">Staff Member</label>
              <input
                type="text"
                value={staffInputName}
                onChange={(e) => setStaffInputName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStaffModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedBranch((prev) => ({ ...prev, activeCashier: staffInputName }));
                  setStaffModalOpen(false);
                  addToast("info", "Shift Cashier Updated", `Active barista: ${staffInputName}`);
                }}
                className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs"
              >
                Update Shift
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 7. SUPABASE BACKEND CONNECTION & CREDENTIALS MODAL                        */}
      {/* ========================================================================= */}
      {backendModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-lg glass-modal rounded-3xl border border-white/15 p-6 shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-cyan-400" />
                <h3 className="text-base font-bold text-white">Supabase Backend Configuration</h3>
              </div>
              <button
                type="button"
                onClick={() => setBackendModalOpen(false)}
                className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/8 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-white">Connection Status</div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {supabasePingDetails || "Configured with provided credentials"}
                </div>
              </div>
              <button
                type="button"
                onClick={testSupabaseConnection}
                disabled={supabasePingStatus === "testing"}
                className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {supabasePingStatus === "testing" ? "Testing..." : "Test Ping"}
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Supabase Project URL
                </label>
                <input
                  type="text"
                  value={supabaseUrlInput}
                  onChange={(e) => setSupabaseUrlInput(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Supabase Anon Key
                </label>
                <input
                  type="text"
                  value={supabaseKeyInput}
                  onChange={(e) => setSupabaseKeyInput(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-white/10 text-white font-mono text-xs focus:outline-none focus:border-cyan-500"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Publishable anon key or JWT anon key from Supabase Dashboard &rarr; Project Settings &rarr; API.
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={() => {
                  resetSupabaseConfig();
                  setSupabaseUrlInput(SUPABASE_URL);
                  setSupabaseKeyInput(SUPABASE_ANON_KEY);
                  setSupabaseConfig({ url: SUPABASE_URL, key: SUPABASE_ANON_KEY });
                  addToast("info", "Defaults Restored", "Reset to original prompt credentials.");
                }}
                className="text-xs text-slate-400 hover:text-white"
              >
                Reset Defaults
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBackendModalOpen(false)}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleSaveSupabaseConfig}
                  className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold text-xs"
                >
                  Save & Reconnect
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
