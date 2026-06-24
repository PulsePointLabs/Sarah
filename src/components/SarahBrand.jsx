import { useEffect, useState } from "react";
import {
  getSarahImageOption,
  getCachedSarahImageSrc,
  readSarahBrandSettings,
  resolveSarahImageSrc,
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
      src="/icons/sarah-192.png"
      alt="Sarah"
      className={`rounded-[22%] ${className}`}
      draggable="false"
    />
  );
}

export function SarahPortrait({
  className = "",
  imageClassName = "",
  label = "Sarah",
  preferCached = false,
}) {
  const { image } = useSarahBrand();
  const cachedSrc = getCachedSarahImageSrc(image.id);
  const resolvedSrc = preferCached && cachedSrc ? cachedSrc : resolveSarahImageSrc(image.src, image.id);
  const fallbackSrc = "/brand/sarah-lab.jpg";
  return (
    <div
      className={`overflow-hidden bg-muted ${className}`}
      style={{
        backgroundImage: `url(${resolvedSrc || fallbackSrc})`,
        backgroundSize: "cover",
        backgroundPosition: image.position || "50% 42%",
      }}
    >
      <img
        src={resolvedSrc || fallbackSrc}
        alt={label}
        className={`h-full w-full object-cover ${imageClassName}`}
        style={{ objectPosition: image.position }}
        loading="eager"
        decoding="sync"
        fetchPriority="high"
        onError={(event) => {
          event.currentTarget.onerror = null;
          event.currentTarget.src = fallbackSrc;
        }}
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

export function SarahSplash({
  message = "Starting local cockpit...",
  detail = "",
  error = false,
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-5 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <SarahPortrait
          className="h-36 w-36 rounded-[2rem] shadow-2xl shadow-primary/20 ring-1 ring-border"
          preferCached
          label="Sarah splash portrait"
        />
        <div className="mt-5 flex items-center gap-2">
          <SarahLogoMark className="h-9 w-9" />
          <h1 className="text-3xl font-black tracking-tight">Sarah</h1>
        </div>
        <p className={`mt-2 text-sm font-medium ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </p>
        {detail ? (
          <p className="mt-2 max-w-xs break-words text-xs leading-relaxed text-muted-foreground">
            {detail}
          </p>
        ) : null}
        {!error ? (
          <div className="mt-5 h-1.5 w-36 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-full border border-border px-4 py-2 text-sm font-semibold text-foreground shadow-sm"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
