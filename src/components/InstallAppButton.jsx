import { useEffect, useMemo, useState } from "react";
import { Download, CheckCircle2, Info } from "lucide-react";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

function isStandaloneDisplay() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent || "");
}

export default function InstallAppButton() {
  const nativeShell = useMemo(() => isSarahNativeShell(), []);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installed, setInstalled] = useState(() => isStandaloneDisplay());
  const [showHelp, setShowHelp] = useState(false);

  const platform = useMemo(() => {
    if (typeof window === "undefined") return { ios: false, secure: false };
    return {
      ios: isIOSDevice(),
      secure: window.isSecureContext,
      local: ["localhost", "127.0.0.1"].includes(window.location.hostname),
    };
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setShowHelp(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (installed) return;
    if (!installPrompt) {
      setShowHelp((value) => !value);
      return;
    }

    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === "accepted") {
      setInstalled(true);
      setShowHelp(false);
    } else {
      setShowHelp(true);
    }
    setInstallPrompt(null);
  };

  const helpText = (() => {
    if (installed) return "Sarah is already running as an installed app.";
    if (!platform.secure && !platform.local) {
      return "Use the HTTPS Tailscale address, not an HTTP address. Install support only appears on secure pages.";
    }
    if (platform.ios) {
      return "On iPhone or iPad, open this in Safari, tap Share, then Add to Home Screen.";
    }
    if (installPrompt) {
      return "Tap Install App to add Sarah to your home screen.";
    }
    return "If Chrome does not show the install option yet, reload once on the HTTPS Tailscale page, then open the menu and choose Install app or Add to Home screen.";
  })();

  if (nativeShell) return null;

  return (
    <div className="border-t border-border p-2">
      <button
        type="button"
        onClick={handleInstall}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        {installed ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : <Download className="h-4 w-4 shrink-0 text-primary" />}
        <span className="flex-1">{installed ? "Installed" : "Install App"}</span>
      </button>

      {(showHelp || installPrompt || installed) && (
        <div className="mt-1 flex gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{helpText}</span>
        </div>
      )}
    </div>
  );
}
