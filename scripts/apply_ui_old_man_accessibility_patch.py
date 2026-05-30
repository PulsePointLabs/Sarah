from pathlib import Path

layout_path = Path("src/components/Layout.jsx")
settings_path = Path("src/pages/SettingsStatus.jsx")
css_path = Path("src/index.css")

missing = [str(path) for path in [layout_path, settings_path, css_path] if not path.exists()]
if missing:
    raise SystemExit("Run this from the PulsePoint-Standalone repo root. Missing: " + ", ".join(missing))

layout = layout_path.read_text(encoding="utf-8")
settings = settings_path.read_text(encoding="utf-8")
css = css_path.read_text(encoding="utf-8")

if "UI_OLD_MAN_ACCESSIBILITY_V1" in layout or "UI_OLD_MAN_ACCESSIBILITY_V1" in settings or "UI_OLD_MAN_ACCESSIBILITY_V1" in css:
    print("UI old man accessibility v1 already appears to be applied. No changes made.")
    raise SystemExit(0)

layout_backup = layout_path.with_suffix(".jsx.bak-ui-old-man-accessibility-v1")
settings_backup = settings_path.with_suffix(".jsx.bak-ui-old-man-accessibility-v1")
css_backup = css_path.with_suffix(".css.bak-ui-old-man-accessibility-v1")
layout_backup.write_text(layout, encoding="utf-8")
settings_backup.write_text(settings, encoding="utf-8")
css_backup.write_text(css, encoding="utf-8")

# Layout: apply saved UI preference classes at the app shell root.
layout = layout.replace(
'''import { useState } from "react";
''',
'''import { useEffect, useState } from "react";
''',
1,
)

layout = layout.replace(
'''const navItems = [
''',
'''// UI_OLD_MAN_ACCESSIBILITY_V1
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
''',
1,
)

layout = layout.replace(
'''  const [open, setOpen] = useState(false);
  const isDisplayView = ["/capture", "/review-player"].includes(location.pathname)
''',
'''  const [open, setOpen] = useState(false);
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
''',
1,
)

layout = layout.replace(
'''    <div className="dark min-h-screen bg-background text-foreground flex flex-col">
''',
'''    <div className={`dark ${uiPreferenceClasses(uiPrefs)} min-h-screen bg-background text-foreground flex flex-col`}>
''',
1,
)

# Settings: add section and controls.
settings = settings.replace(
'''  Activity,
  BellRing,
  CircleDollarSign,
''',
'''  Activity,
  BellRing,
  CircleDollarSign,
  Palette,
  Type,
''',
1,
)

helper_anchor = '''function ProviderCard({ status }) {
'''
helper_insert = '''// UI_OLD_MAN_ACCESSIBILITY_V1
const UI_PREFS_STORAGE_KEY = "pulsepoint-ui-preferences-v1";
const DEFAULT_UI_PREFS = { theme: "teal", fontScale: "comfortable" };

const THEME_OPTIONS = [
  { value: "teal", label: "PulsePoint Teal", helper: "Default dark PulsePoint look." },
  { value: "blue", label: "Clinical Blue", helper: "Cooler blue accents with softer contrast." },
  { value: "warm", label: "Warm Amber", helper: "Warmer highlights for late-night reading." },
  { value: "high-contrast", label: "High Contrast", helper: "Bigger contrast, brighter borders, old-man approved." },
];

const FONT_SCALE_OPTIONS = [
  { value: "comfortable", label: "Comfortable", helper: "Current default sizing." },
  { value: "large", label: "Large", helper: "A little bigger everywhere." },
  { value: "xl", label: "Extra Large", helper: "Less squinting, more dignity." },
  { value: "old-man", label: "Old Man", helper: "Maximum readability. Buttons and tiny labels get boosted too." },
];

function readUiPreferences() {
  if (typeof window === "undefined") return DEFAULT_UI_PREFS;
  try {
    return { ...DEFAULT_UI_PREFS, ...(JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY) || "{}")) };
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

function saveUiPreferences(nextPrefs) {
  window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(nextPrefs));
  window.dispatchEvent(new CustomEvent("pulsepoint:ui-preferences-changed", { detail: nextPrefs }));
}

function ProviderCard({ status }) {
'''
if helper_anchor not in settings:
    raise SystemExit("Patch failed: could not find ProviderCard anchor in SettingsStatus.jsx")
settings = settings.replace(helper_anchor, helper_insert, 1)

settings = settings.replace(
'''  const [notificationBusy, setNotificationBusy] = useState(false);

  const loadProviders = async () => {
''',
'''  const [notificationBusy, setNotificationBusy] = useState(false);
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);

  const updateUiPrefs = (patch) => {
    setUiPrefs((previous) => {
      const next = { ...previous, ...patch };
      saveUiPreferences(next);
      return next;
    });
  };

  const loadProviders = async () => {
''',
1,
)

section_anchor = '''      <TTSSettingsPanel />

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
'''
section_insert = '''      <TTSSettingsPanel />

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Palette className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Display & Readability</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Old man version controls: pick a color theme and bump the app-wide font size without touching browser zoom.
            </p>
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold uppercase text-primary">
            Local only
          </span>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-foreground">
              <Palette className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Color theme</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => updateUiPrefs({ theme: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${uiPrefs.theme === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-foreground">
              <Type className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Font size</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {FONT_SCALE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => updateUiPrefs({ fontScale: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${uiPrefs.fontScale === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
'''
if section_anchor not in settings:
    raise SystemExit("Patch failed: could not find TTSSettingsPanel insertion anchor in SettingsStatus.jsx")
settings = settings.replace(section_anchor, section_insert, 1)

css_append = '''

/* UI_OLD_MAN_ACCESSIBILITY_V1 */
@layer base {
  .dark.theme-blue {
    --primary: 205 82% 62%;
    --primary-foreground: 220 20% 7%;
    --accent: 230 72% 68%;
    --ring: 205 82% 62%;
    --chart-1: 205 82% 62%;
    --chart-2: 230 72% 68%;
    --chart-4: 46 90% 62%;
    --sidebar-primary: 205 82% 62%;
    --sidebar-ring: 205 82% 62%;
  }

  .dark.theme-warm {
    --background: 225 18% 7%;
    --foreground: 43 20% 94%;
    --card: 225 16% 10%;
    --card-foreground: 43 20% 94%;
    --primary: 39 92% 58%;
    --primary-foreground: 225 20% 8%;
    --accent: 20 78% 58%;
    --accent-foreground: 225 20% 8%;
    --muted: 225 14% 15%;
    --muted-foreground: 43 16% 76%;
    --border: 39 20% 24%;
    --input: 39 20% 24%;
    --ring: 39 92% 58%;
    --chart-1: 39 92% 58%;
    --chart-2: 20 78% 58%;
    --chart-4: 52 95% 62%;
    --sidebar-background: 225 16% 10%;
    --sidebar-primary: 39 92% 58%;
    --sidebar-border: 39 20% 24%;
  }

  .dark.theme-high-contrast {
    --background: 220 18% 3%;
    --foreground: 0 0% 98%;
    --card: 220 18% 7%;
    --card-foreground: 0 0% 98%;
    --popover: 220 18% 7%;
    --popover-foreground: 0 0% 98%;
    --primary: 170 95% 55%;
    --primary-foreground: 220 18% 3%;
    --secondary: 220 16% 14%;
    --secondary-foreground: 0 0% 98%;
    --muted: 220 16% 13%;
    --muted-foreground: 0 0% 86%;
    --accent: 48 100% 62%;
    --accent-foreground: 220 18% 3%;
    --border: 0 0% 32%;
    --input: 0 0% 32%;
    --ring: 170 95% 55%;
    --chart-1: 170 95% 55%;
    --chart-2: 48 100% 62%;
    --chart-3: 330 100% 70%;
    --chart-4: 205 100% 68%;
    --chart-5: 120 90% 60%;
    --sidebar-background: 220 18% 7%;
    --sidebar-foreground: 0 0% 98%;
    --sidebar-primary: 170 95% 55%;
    --sidebar-border: 0 0% 32%;
  }

  .text-scale-large {
    font-size: 1.0625rem;
  }

  .text-scale-xl {
    font-size: 1.14rem;
  }

  .text-scale-old-man {
    font-size: 1.22rem;
  }

  .text-scale-large .text-\[9px\],
  .text-scale-large .text-\[10px\],
  .text-scale-large .text-xs {
    font-size: 0.86rem;
    line-height: 1.18rem;
  }

  .text-scale-xl .text-\[9px\],
  .text-scale-xl .text-\[10px\],
  .text-scale-xl .text-xs {
    font-size: 0.93rem;
    line-height: 1.26rem;
  }

  .text-scale-old-man .text-\[9px\],
  .text-scale-old-man .text-\[10px\],
  .text-scale-old-man .text-xs {
    font-size: 1rem;
    line-height: 1.35rem;
  }

  .text-scale-old-man button,
  .text-scale-old-man [role="button"],
  .text-scale-old-man input,
  .text-scale-old-man select,
  .text-scale-old-man textarea {
    min-height: 2.7rem;
  }
}
'''
css = css + css_append

layout_path.write_text(layout, encoding="utf-8")
settings_path.write_text(settings, encoding="utf-8")
css_path.write_text(css, encoding="utf-8")

print("Applied UI old man accessibility v1.")
print("Changed:")
print("- App shell reads local UI preferences and applies theme/font classes")
print("- Settings & Status gets Display & Readability controls")
print("- Added PulsePoint Teal, Clinical Blue, Warm Amber, High Contrast themes")
print("- Added Comfortable, Large, Extra Large, Old Man font sizes")
print("- Preferences are localStorage-only and update live without reload")
print(f"Backups written to {layout_backup}, {settings_backup}, and {css_backup}")
