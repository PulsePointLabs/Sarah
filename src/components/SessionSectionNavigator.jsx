import { useEffect, useRef, useState } from "react";
import { Bookmark, MapPinned } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

function groupSections(sections) {
  return sections.reduce((groups, section) => {
    const group = section.group || "Sections";
    const existing = groups.find((item) => item.label === group);
    if (existing) existing.sections.push(section);
    else groups.push({ label: group, sections: [section] });
    return groups;
  }, []);
}

function SectionButtons({ sections, onSelect, closeOnSelect = false }) {
  return (
    <div className="space-y-3">
      {groupSections(sections).map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          {group.sections.map((section) => {
            const button = (
              <button
                key={section.id}
                type="button"
                onClick={() => onSelect(section)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  section.id === "session-summary"
                    ? "border-primary/35 bg-primary/10 text-foreground"
                    : "border-transparent bg-muted/35 text-muted-foreground hover:border-primary/25 hover:bg-muted/55 hover:text-foreground"
                }`}
              >
                <span className="block text-sm font-medium">{section.label}</span>
              </button>
            );

            return closeOnSelect ? (
              <SheetClose key={section.id} asChild>
                {button}
              </SheetClose>
            ) : button;
          })}
        </div>
      ))}
    </div>
  );
}

export default function SessionSectionNavigator({ sections, onSelect }) {
  const defaultTop = 420;
  const [mobileTop, setMobileTop] = useState(defaultTop);
  const dragStateRef = useRef({ active: false, offset: 0 });

  const clampTop = (value) => {
    if (typeof window === "undefined") return value;
    const min = 96;
    const max = Math.max(min, window.innerHeight - 120);
    return Math.min(max, Math.max(min, value));
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = Number(window.localStorage.getItem("session-section-nav-top"));
    if (Number.isFinite(saved)) setMobileTop(clampTop(saved));
  }, []);

  const persistTop = (value) => {
    const clamped = clampTop(value);
    setMobileTop(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("session-section-nav-top", String(clamped));
    }
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!dragStateRef.current.active) return;
      persistTop(event.clientY - dragStateRef.current.offset);
    };
    const handlePointerUp = () => {
      dragStateRef.current.active = false;
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setMobileTop((current) => clampTop(current));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleDragStart = (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      active: true,
      offset: event.clientY - mobileTop,
    };
  };

  return (
    <>
      <aside className="fixed right-4 top-28 z-30 hidden w-52 rounded-xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur xl:block">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
          <Bookmark className="h-3.5 w-3.5" />
          Session Sections
        </div>
        <SectionButtons sections={sections} onSelect={onSelect} />
      </aside>

      <div className="fixed left-2 z-40 xl:hidden" style={{ top: `${mobileTop}px` }}>
        <Sheet>
          <SheetTrigger asChild>
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                aria-label="Move jump button"
                onPointerDown={handleDragStart}
                className="ml-3 inline-flex h-5 w-10 items-center justify-center rounded-full border border-border bg-card/95 text-muted-foreground shadow-md backdrop-blur touch-none"
                style={{ touchAction: "none" }}
              >
                <span className="h-1 w-4 rounded-full bg-muted-foreground/50" />
              </button>
              <Button className="h-11 rounded-full px-4 shadow-lg">
                <MapPinned className="h-4 w-4" />
                Jump
              </Button>
            </div>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[78vh] overflow-y-auto rounded-t-2xl px-4 pb-6 pt-5">
            <SheetHeader className="pr-8 text-left">
              <SheetTitle>Jump to section</SheetTitle>
              <SheetDescription>Move through this session without losing the thread.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              <SectionButtons sections={sections} onSelect={onSelect} closeOnSelect />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
