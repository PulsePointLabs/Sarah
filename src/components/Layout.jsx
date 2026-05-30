import { useEffect, useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, List, PlusCircle, GitCompare, TrendingUp, Waves, ScanSearch, GitMerge, LineChart, Menu, X, UserCircle, Grid3x3, Clapperboard, Music, BarChart2, FlaskConical, BookOpen, Radio, Settings2, Activity } from "lucide-react";
import InstallAppButton from "./InstallAppButton";
import BackgroundJobStatusTray from "./BackgroundJobStatusTray";

// UI_OLD_MAN_ACCESSIBILITY_V1
const UI_PREFS_STORAGE_KEY = "pulsepoint-ui-preferences-v1";
const DEFAULT_UI_PREFS = { theme: "teal", fontScale: "comfortable" };

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

const navItems = [
{ path: "/", icon: LayoutDashboard, label: "Dashboard" },
{ path: "/sessions", icon: List, label: "Sessions" },
{ path: "/new", icon: PlusCircle, label: "New Session" },
{ path: "/exploration", icon: ScanSearch, label: "Body Exploration" },
{ path: "/journal", icon: BookOpen, label: "Journal" },
{ path: "/capture", icon: Radio, label: "Live Capture" },
{ path: "/compare", icon: GitCompare, label: "Compare" },
{ path: "/insights", icon: TrendingUp, label: "Insights" },
{ path: "/cascade", icon: Waves, label: "Cascade" },
{ path: "/profiler", icon: ScanSearch, label: "AI Profiler" },
{ path: "/overlay", icon: GitMerge, label: "HR Overlay" },
{ path: "/trends", icon: LineChart, label: "Trends" },
{ path: "/correlations", icon: Grid3x3, label: "Correlations" },
{ path: "/video", icon: Clapperboard, label: "Video Sync" },
{ path: "/review-player", icon: Clapperboard, label: "Review Player" },
{ path: "/motion-lab", icon: Activity, label: "Motion Lab" },
{ path: "/library", icon: Music, label: "Audio Library" },
{ path: "/analytics", icon: BarChart2, label: "Analytics" },
{ path: "/modeler", icon: FlaskConical, label: "Predictive Modeler" },
{ path: "/settings", icon: Settings2, label: "Settings & Status" },
{ path: "/profile", icon: UserCircle, label: "My Profile" }];


export default function Layout() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);

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

  return (
    <div className={`dark ${uiPreferenceClasses(uiPrefs)} min-h-screen bg-background text-foreground flex flex-col`}>
      {/* Top bar */}
      {!isDisplayView && <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-card border-b border-border flex items-center px-2 gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-center w-12 h-12 rounded-xl hover:bg-muted active:bg-muted transition-colors text-foreground"
          style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}>
          
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
        <span className="text-sm font-semibold text-foreground tracking-tight">
          {navItems.find((n) => n.path === "/" ? location.pathname === "/" : location.pathname.startsWith(n.path))?.label ?? "App"}
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
        className={`fixed top-0 left-0 h-full z-50 w-64 bg-card border-r border-border flex flex-col transition-transform duration-200 ease-in-out ${
        open ? "translate-x-0" : "-translate-x-full"}`
        }>
        
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <span className="text-sm font-bold text-primary tracking-tight">Menu</span>
          <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                onClick={() => setOpen(false)}
                className={`text-[#ffffff] px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-3 transition-colors hover:bg-muted hover:text-foreground ${isActive ? "bg-muted text-foreground" : ""}`}>





                
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>);

            })}
        </nav>
        <InstallAppButton />
      </aside>}

      <main className={`flex-1 ${isDisplayView ? "overflow-hidden" : "pt-14 overflow-auto"}`}>
        <Outlet />
      </main>
      {!isDisplayView && <BackgroundJobStatusTray />}
    </div>);

}
