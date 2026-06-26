import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, List, PlusCircle, GitCompare, TrendingUp, Waves, ScanSearch, GitMerge, LineChart, Menu, X, UserCircle, Grid3x3, Clapperboard, Music, BarChart2, FlaskConical, BookOpen, Radio, Settings2, Activity, HeartPulse, MessageCircle, Sparkles, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import pkg from "../../package.json";
import InstallAppButton from "./InstallAppButton";
import BackgroundJobStatusTray from "./BackgroundJobStatusTray";
import { SarahAvatar, SarahLogoMark, SarahPortrait } from "./SarahBrand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listBackgroundJobs } from "@/lib/backgroundJobs";
import { backgroundJobRoute } from "@/lib/backgroundJobRoutes";

// UI_OLD_MAN_ACCESSIBILITY_V1
const UI_PREFS_STORAGE_KEY = "pulsepoint-ui-preferences-v1";
const DEFAULT_UI_PREFS = { theme: "sarah-lavender", fontScale: "comfortable" };
const RESUME_STATE_KEY = "pulsepoint.resumeState.v1";
const SCROLL_STATE_KEY = "pulsepoint.scrollState.v1";

function readUiPreferences() {
  if (typeof window === "undefined") return DEFAULT_UI_PREFS;
  try {
    return { ...DEFAULT_UI_PREFS, ...(JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY) || "{}")) };
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

function uiPreferenceClasses(prefs) {
  return [
    `theme-${prefs.theme || DEFAULT_UI_PREFS.theme}`,
    `text-scale-${prefs.fontScale || DEFAULT_UI_PREFS.fontScale}`,
  ].join(" ");
}

function uiColorSchemeClass(prefs) {
  return prefs.theme === "sarah-lavender" ? "" : "dark";
}

const navGroups = [
  {
    label: "Today",
    items: [
      { path: "/", icon: LayoutDashboard, label: "Dashboard" },
      { path: "/vitals", icon: HeartPulse, label: "Vital Signs" },
      { path: "/sessions", icon: List, label: "Sessions" },
      { path: "/new", icon: PlusCircle, label: "New Session" },
      { path: "/journal", icon: BookOpen, label: "Journal" },
    ],
  },
  {
    label: "Capture",
    items: [
      { path: "/capture", icon: Radio, label: "Live Capture" },
      { path: "/exploration", icon: ScanSearch, label: "Body Exploration" },
      { path: "/motion-lab", icon: Activity, label: "Motion Lab" },
    ],
  },
  {
    label: "Review & AI",
    items: [
      { path: "/profiler", icon: ScanSearch, label: "AI Profiler" },
      { path: "/profile-qa", icon: MessageCircle, label: "Profiler QA" },
      { path: "/ai-annotation", icon: Sparkles, label: "AI Annotation" },
      { path: "/review-player", icon: Clapperboard, label: "Review Player" },
      { path: "/video", icon: Clapperboard, label: "Video Sync" },
    ],
  },
  {
    label: "Patterns",
    items: [
      { path: "/insights", icon: TrendingUp, label: "Insights" },
      { path: "/compare", icon: GitCompare, label: "Compare" },
      { path: "/cascade", icon: Waves, label: "Cascade" },
      { path: "/overlay", icon: GitMerge, label: "HR Overlay" },
      { path: "/trends", icon: LineChart, label: "Trends" },
      { path: "/correlations", icon: Grid3x3, label: "Correlations" },
      { path: "/analytics", icon: BarChart2, label: "Analytics" },
      { path: "/modeler", icon: FlaskConical, label: "Predictive Modeler" },
    ],
  },
  {
    label: "Library & System",
    items: [
      { path: "/library", icon: Music, label: "Multimedia Library" },
      { path: "/profile", icon: UserCircle, label: "My Profile" },
      { path: "/settings", icon: Settings2, label: "Settings & Status" },
    ],
  },
];

const navItems = navGroups.flatMap((group) => group.items);
const APP_VERSION = pkg.version || "0.0.0";

function isPathActive(path, pathname) {
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
}

function routeKey(location) {
  return `${location.pathname || "/"}${location.search || ""}${location.hash || ""}`;
}

function readJsonStorage(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    return JSON.parse(window.sessionStorage.getItem(key) || window.localStorage.getItem(key) || "null") || fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  if (typeof window === "undefined") return;
  const json = JSON.stringify(value);
  try { window.sessionStorage.setItem(key, json); } catch {}
  try { window.localStorage.setItem(key, json); } catch {}
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sarahOpen, setSarahOpen] = useState(false);
  const [statusJobs, setStatusJobs] = useState([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);
  const mainRef = useRef(null);
  const saveTimerRef = useRef(null);
  const currentNavLabel = useMemo(
    () => navItems.find((n) => isPathActive(n.path, location.pathname))?.label ?? "App",
    [location.pathname],
  );

  useEffect(() => {
    const syncPrefs = () => setUiPrefs(readUiPreferences());
    window.addEventListener("pulsepoint:ui-preferences-changed", syncPrefs);
    window.addEventListener("storage", syncPrefs);
    return () => {
      window.removeEventListener("pulsepoint:ui-preferences-changed", syncPrefs);
      window.removeEventListener("storage", syncPrefs);
    };
  }, []);

  const isDisplayView = ["/capture", "/review-player"].includes(location.pathname)
    && new URLSearchParams(location.search).get("display") === "focus";

  useEffect(() => {
    const key = routeKey(location);
    const saveResumeState = () => {
      const main = mainRef.current;
      const scrollTop = main?.scrollTop ?? window.scrollY ?? document.documentElement?.scrollTop ?? 0;
      const scrollLeft = main?.scrollLeft ?? window.scrollX ?? document.documentElement?.scrollLeft ?? 0;
      const allScroll = readJsonStorage(SCROLL_STATE_KEY, {});
      const nextScroll = {
        ...allScroll,
        [key]: {
          scrollTop,
          scrollLeft,
          savedAt: Date.now(),
        },
      };
      writeJsonStorage(SCROLL_STATE_KEY, nextScroll);
      writeJsonStorage(RESUME_STATE_KEY, {
        route: key,
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        scrollTop,
        scrollLeft,
        savedAt: Date.now(),
      });
    };

    const throttledSave = () => {
      if (saveTimerRef.current) return;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        saveResumeState();
      }, 250);
    };

    const main = mainRef.current;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") saveResumeState();
    };
    main?.addEventListener("scroll", throttledSave, { passive: true });
    window.addEventListener("pagehide", saveResumeState);
    window.addEventListener("beforeunload", saveResumeState);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    saveResumeState();

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveResumeState();
      main?.removeEventListener("scroll", throttledSave);
      window.removeEventListener("pagehide", saveResumeState);
      window.removeEventListener("beforeunload", saveResumeState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    const key = routeKey(location);
    if (location.hash) return undefined;
    const scroll = readJsonStorage(SCROLL_STATE_KEY, {})?.[key];
    if (!scroll) return;
    const restore = () => {
      const main = mainRef.current;
      if (!main) return;
      main.scrollTo({
        top: Math.max(0, Number(scroll.scrollTop || 0)),
        left: Math.max(0, Number(scroll.scrollLeft || 0)),
        behavior: "auto",
      });
    };
    const frame = window.requestAnimationFrame(() => {
      restore();
      window.setTimeout(restore, 150);
      window.setTimeout(restore, 600);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!location.hash) return undefined;
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return undefined;
    const scrollToHash = () => {
      const target = document.getElementById(hash) || document.querySelector(`[name="${CSS.escape(hash)}"]`);
      const main = mainRef.current;
      if (!target || !main) return false;
      const mainRect = main.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      main.scrollTo({
        top: main.scrollTop + targetRect.top - mainRect.top - 14,
        behavior: "smooth",
      });
      return true;
    };
    const frame = window.requestAnimationFrame(() => {
      if (scrollToHash()) return;
      window.setTimeout(scrollToHash, 180);
      window.setTimeout(scrollToHash, 650);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!sarahOpen) return undefined;
    let cancelled = false;
    const loadStatus = async () => {
      setStatusLoading(true);
      setStatusError("");
      try {
        const [active, recent] = await Promise.all([
          listBackgroundJobs({ status: "queued,running", limit: 6 }),
          listBackgroundJobs({ status: "complete,error,cancelled", limit: 4 }),
        ]);
        if (cancelled) return;
        const merged = new Map();
        [
          ...(active.jobs || []).slice(0, 4),
          ...(recent.jobs || []).slice(0, 3),
        ].forEach((job) => {
          if (job?.id) merged.set(job.id, job);
        });
        setStatusJobs([...merged.values()].slice(0, 5));
      } catch (error) {
        if (!cancelled) setStatusError(error?.message || "Could not load system status.");
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sarahOpen]);

  const openJobRoute = (job) => {
    const route = backgroundJobRoute(job);
    if (!route) return;
    setSarahOpen(false);
    navigate(route);
  };

  return (
    <div className={`${uiColorSchemeClass(uiPrefs)} ${uiPreferenceClasses(uiPrefs)} min-h-screen min-w-0 overflow-x-hidden bg-background text-foreground flex flex-col`}>
      {/* Top bar */}
      {!isDisplayView && <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-card border-b border-border flex items-center px-2 gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-center w-12 h-12 rounded-xl hover:bg-muted active:bg-muted transition-colors text-foreground"
          style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}>
          
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-tight">
          <button
            type="button"
            onClick={() => setSarahOpen(true)}
            className="inline-flex min-w-0 shrink-0 items-center gap-2 rounded-full px-1.5 py-1 text-primary transition-colors hover:bg-primary/10"
            title="Open Sarah status"
          >
            <SarahAvatar className="h-7 w-7" ring={false} />
            <span className="max-w-[5.2rem] truncate sm:max-w-none">Sarah</span>
          </button>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{currentNavLabel}</span>
        </div>
      </header>}

      <Dialog open={sarahOpen} onOpenChange={setSarahOpen}>
        <DialogContent className="bottom-0 top-auto max-h-[calc(100dvh-0.75rem)] w-[calc(100vw-0.75rem)] max-w-md translate-y-0 overflow-hidden rounded-t-2xl p-0 sm:bottom-auto sm:top-[50%] sm:max-h-[min(42rem,calc(100dvh-2rem))] sm:translate-y-[-50%] sm:rounded-lg">
          <div className="border-b border-border bg-card px-4 pb-4 pt-5 text-center">
            <SarahPortrait className="mx-auto h-48 w-48 rounded-2xl shadow-lg shadow-primary/10 ring-1 ring-border sm:h-56 sm:w-56" imageClassName="scale-100" label="Sarah portrait" />
            <DialogHeader className="mt-4 text-center">
              <DialogTitle className="truncate text-2xl">Sarah</DialogTitle>
              <DialogDescription>Version {APP_VERSION}</DialogDescription>
            </DialogHeader>
          </div>
          <div className="max-h-[calc(100dvh-20rem)] space-y-3 overflow-y-auto px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:max-h-[24rem] sm:px-5 sm:pb-5">
            <div className="rounded-lg border border-border bg-muted/20">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">System Status</p>
                {statusLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
              {statusError ? (
                <p className="px-3 pb-3 text-sm text-destructive">{statusError}</p>
              ) : statusJobs.length ? (
                <div className="divide-y divide-border">
                  {statusJobs.map((job) => {
                    const route = backgroundJobRoute(job);
                    const active = job.status === "queued" || job.status === "running";
                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => openJobRoute(job)}
                        disabled={!route}
                        className="flex w-full items-center justify-between gap-3 bg-card/50 px-3 py-2.5 text-left text-sm transition-colors hover:bg-card disabled:cursor-default disabled:opacity-70"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{job.meta?.title || job.meta?.label || job.type || "Background task"}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {active ? (job.progress?.message || job.status) : job.status}
                          </span>
                        </span>
                        {active ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" /> : route ? <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 pb-3 text-sm text-muted-foreground">No background tasks are running.</p>
              )}
            </div>
            <Button type="button" variant="outline" className="w-full" onClick={() => navigate("/settings")}>
              Open Settings & Status
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Backdrop */}
      {!isDisplayView && open &&
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={() => setOpen(false)} />

      }

      {/* Side panel */}
      {!isDisplayView && <aside
        className={`fixed top-0 left-0 h-full z-50 w-[18rem] max-w-[86vw] bg-card border-r border-border flex flex-col transition-transform duration-200 ease-in-out ${
        open ? "translate-x-0" : "-translate-x-full"}`
        }>
        
        <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
          <span className="flex items-center gap-2 text-sm font-bold text-primary tracking-tight">
            <SarahLogoMark className="h-8 w-8" />
            Sarah
          </span>
          <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {navGroups.map((group) => (
            <section key={group.label} className="mb-3 last:mb-1">
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map(({ path, icon: Icon, label }) => {
                  const isActive = isPathActive(path, location.pathname);
                  return (
                    <Link
                      key={path}
                      to={path}
                      onClick={() => setOpen(false)}
                      className={`flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-foreground/90 transition-colors hover:bg-muted hover:text-foreground ${isActive ? "bg-muted text-foreground shadow-sm" : ""}`}>
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{label}</span>
                    </Link>);
                })}
              </div>
            </section>
          ))}
        </nav>
        <InstallAppButton />
      </aside>}

      <main ref={mainRef} className={`min-w-0 flex-1 ${isDisplayView ? "overflow-hidden" : "pt-14 overflow-y-auto overflow-x-hidden"}`}>
        <Outlet />
      </main>
      {!isDisplayView && <BackgroundJobStatusTray />}
    </div>);

}
