import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus, Check, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

const DEFAULT_METHODS = [
  "Manual",
  "Silicone Sleeve",
  "Coyote E-Stim",
  "TENS",
  "Foley Catheter",
];

export default function MultiSelect({ selected = [], onChange, options = DEFAULT_METHODS }) {
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [savedCustomMethods, setSavedCustomMethods] = useState([]);

  useEffect(() => {
    base44.entities.CustomMethod.list().then((items) => {
      setSavedCustomMethods(items.map((i) => ({ id: i.id, name: i.name })));
    });
  }, []);

  // Include any selected items not yet in the saved list (legacy session-only customs)
  const allOptions = [
    ...options,
    ...savedCustomMethods.map((m) => m.name).filter((n) => !options.includes(n)),
    ...selected.filter((s) => !options.includes(s) && !savedCustomMethods.find((m) => m.name === s)),
  ];

  const toggle = (item) => {
    if (selected.includes(item)) {
      onChange(selected.filter((s) => s !== item));
    } else {
      onChange([...selected, item]);
    }
  };

  const addCustom = async () => {
    const name = customValue.trim();
    if (!name) return;
    // Save permanently
    const created = await base44.entities.CustomMethod.create({ name });
    setSavedCustomMethods((prev) => [...prev, { id: created.id, name }]);
    // Also select it
    if (!selected.includes(name)) onChange([...selected, name]);
    setCustomValue("");
    setShowCustom(false);
  };

  const deleteCustomMethod = async (id, name) => {
    await base44.entities.CustomMethod.delete(id);
    setSavedCustomMethods((prev) => prev.filter((m) => m.id !== id));
    // Deselect if currently selected
    if (selected.includes(name)) onChange(selected.filter((s) => s !== name));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {allOptions.map((opt) => {
          const savedEntry = savedCustomMethods.find((m) => m.name === opt);
          const isCustom = !!savedEntry;
          return (
            <div key={opt} className="relative group">
              <button
                type="button"
                onClick={() => toggle(opt)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all border ${
                  selected.includes(opt)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-foreground border-border hover:border-primary/50"
                }`}
              >
                {selected.includes(opt) && <Check className="w-3.5 h-3.5" />}
                {opt}
              </button>
              {isCustom && (
                <button
                  type="button"
                  title="Remove permanently"
                  onClick={() => deleteCustomMethod(savedEntry.id, opt)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground hidden group-hover:flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {showCustom ? (
        <div className="flex gap-2">
          <Input
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="New method name..."
            className="h-10"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())}
          />
          <Button type="button" size="sm" onClick={addCustom} className="h-10">Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowCustom(false)} className="h-10">
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowCustom(true)}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <Plus className="w-3.5 h-3.5" /> Add method permanently
        </button>
      )}
    </div>
  );
}