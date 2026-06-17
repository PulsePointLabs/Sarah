import { useEffect, useRef, useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, List, PlusCircle, GitCompare, TrendingUp, Waves, ScanSearch, GitMerge, LineChart, Menu, X, UserCircle, Grid3x3, Clapperboard, Music, BarChart2, FlaskConical, BookOpen, Radio, Settings2, Activity, MessageCircle, Sparkles } from "lucide-react";
import InstallAppButton from "./InstallAppButton";
import BackgroundJobStatusTray from "./BackgroundJobStatusTray";

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
      { path: "/ai-annotation", icon: Sparkles, label: "AI Annotation" },
      { path: "/review-player", icon: Clapperboard, label: "Review Player" },
      { path: "/video", icon: Clapperboard, label: "Video Sync" },
      { path: "/profiler", icon: ScanSearch, label: "AI Profiler" },
      { path: "/profile-qa", icon: MessageCircle, label: "Profile Q&A" },
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
      { path: "/library", icon: Music, label: "Audio Library" },
      { path: "/profile", icon: UserCircle, label: "My Profile" },
      { path: "/settings", icon: Settings2, label: "Settings & Status" },
    ],
  },
];

const navItems = navGroups.flatMap((group) => group.items);

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
  const [open, setOpen] = useState(false);
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);
  const mainRef = useRef(null);
  const saveTimerRef = useRef(null);

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
        <span className="min-w-0 text-sm font-semibold text-foreground tracking-tight">
          <span className="text-primary">Sarah</span>
          <span className="text-muted-foreground"> / </span>
          <span>{navItems.find((n) => isPathActive(n.path, location.pathname))?.label ?? "App"}</span>
        </span>
      </header>}

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
        
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <span className="text-sm font-bold text-primary tracking-tight">Sarah</span>
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
