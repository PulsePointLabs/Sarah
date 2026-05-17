export default function StatCard({ label, value, icon: Icon, color = "primary" }) {
  return (
    <div className="bg-card rounded-xl p-4 border border-border">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className={`w-10 h-10 rounded-lg bg-${color}/10 flex items-center justify-center`}>
            <Icon className={`w-5 h-5 text-${color}`} />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
          <p className="text-xl font-bold font-mono mt-0.5 truncate">{value}</p>
        </div>
      </div>
    </div>
  );
}