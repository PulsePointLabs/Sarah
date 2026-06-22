import { BUILD_INFO } from "@/generated/buildInfo";

export default function AppVersionBadge({ className = "" }) {
  const version = BUILD_INFO?.version || "dev";
  const commit = BUILD_INFO?.commit || "unknown";
  const message = BUILD_INFO?.commitMessage || "Local build";

  return (
    <div className={`rounded-lg border border-border bg-card/80 px-3 py-2 text-left shadow-sm ${className}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Sarah v{version}</p>
      <p className="mt-0.5 max-w-[18rem] truncate text-xs text-muted-foreground">
        {commit} · {message}
      </p>
    </div>
  );
}
