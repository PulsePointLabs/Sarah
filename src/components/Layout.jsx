import { useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, List, PlusCircle, GitCompare, TrendingUp, Waves, ScanSearch, GitMerge, LineChart, Menu, X, UserCircle, Grid3x3, Clapperboard, Music, BarChart2, FlaskConical, BookOpen } from "lucide-react";

const navItems = [
{ path: "/", icon: LayoutDashboard, label: "Dashboard" },
{ path: "/sessions", icon: List, label: "Sessions" },
{ path: "/new", icon: PlusCircle, label: "New Session" },
{ path: "/journal", icon: BookOpen, label: "Journal" },
{ path: "/compare", icon: GitCompare, label: "Compare" },
{ path: "/insights", icon: TrendingUp, label: "Insights" },
{ path: "/cascade", icon: Waves, label: "Cascade" },
{ path: "/profiler", icon: ScanSearch, label: "AI Profiler" },
{ path: "/overlay", icon: GitMerge, label: "HR Overlay" },
{ path: "/trends", icon: LineChart, label: "Trends" },
{ path: "/correlations", icon: Grid3x3, label: "Correlations" },
{ path: "/video", icon: Clapperboard, label: "Video Sync" },
{ path: "/library", icon: Music, label: "Audio Library" },
{ path: "/analytics", icon: BarChart2, label: "Analytics" },
{ path: "/modeler", icon: FlaskConical, label: "Predictive Modeler" },
{ path: "/profile", icon: UserCircle, label: "My Profile" }];


export default function Layout() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  return (
    <div className="dark min-h-screen bg-background text-foreground flex flex-col">
      {/* Top bar */}
      <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-card border-b border-border flex items-center px-2 gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-center w-12 h-12 rounded-xl hover:bg-muted active:bg-muted transition-colors text-foreground"
          style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}>
          
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
        <span className="text-sm font-semibold text-foreground tracking-tight">
          {navItems.find((n) => n.path === "/" ? location.pathname === "/" : location.pathname.startsWith(n.path))?.label ?? "App"}
        </span>
      </header>

      {/* Backdrop */}
      {open &&
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={() => setOpen(false)} />

      }

      {/* Side panel */}
      <aside
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
                onClick={() => setOpen(false)} className="text-[#ffffff] px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-3 transition-colors hover:bg-muted hover:text-foreground">





                
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>);

          })}
        </nav>
      </aside>

      <main className="flex-1 pt-14 overflow-auto">
        <Outlet />
      </main>
    </div>);

}