import { useEffect, useState } from "react";
import {
  getSarahImageOption,
  readSarahBrandSettings,
  SARAH_BRAND_EVENT,
} from "@/lib/sarahBrand";

export function useSarahBrand() {
  const [settings, setSettings] = useState(readSarahBrandSettings);

  useEffect(() => {
    const sync = () => setSettings(readSarahBrandSettings());
    window.addEventListener(SARAH_BRAND_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SARAH_BRAND_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return {
    settings,
    image: getSarahImageOption(settings.imageId),
  };
}

export function SarahLogoMark({ className = "h-8 w-8" }) {
  return (
    <img
      src="/icons/sarah-icon.svg"
      alt="Sarah"
      className={className}
      draggable="false"
    />
  );
}

export function SarahPortrait({
  className = "",
  imageClassName = "",
  label = "Sarah",
}) {
  const { image } = useSarahBrand();
  return (
    <div className={`overflow-hidden bg-muted ${className}`}>
      <img
        src={image.src}
        alt={label}
        className={`h-full w-full object-cover ${imageClassName}`}
        style={{ objectPosition: image.position }}
        draggable="false"
      />
    </div>
  );
}

export function SarahAvatar({ className = "h-8 w-8", ring = true }) {
  return (
    <SarahPortrait
      className={`${className} shrink-0 rounded-full ${ring ? "ring-2 ring-primary/25" : ""}`}
      imageClassName="scale-110"
      label="Sarah avatar"
    />
  );
}

export function SarahSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-5 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <SarahPortrait className="h-36 w-36 rounded-[2rem] shadow-2xl shadow-primary/20 ring-1 ring-border" />
        <div className="mt-5 flex items-center gap-2">
          <SarahLogoMark className="h-9 w-9" />
          <h1 className="text-3xl font-black tracking-tight">Sarah</h1>
        </div>
        <p className="mt-2 text-sm font-medium text-muted-foreground">Starting local cockpit...</p>
        <div className="mt-5 h-1.5 w-36 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}
