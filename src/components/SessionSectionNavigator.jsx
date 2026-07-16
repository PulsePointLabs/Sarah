import { useState } from "react";
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

function SectionButtons({ sections, onSelect, closeOnSelect = false, activeSectionId = "" }) {
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
                  section.id === activeSectionId
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

export default function SessionSectionNavigator({ sections, onSelect, activeSectionId = "" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <aside className="fixed right-4 top-28 z-30 hidden w-52 rounded-xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur xl:block">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
          <Bookmark className="h-3.5 w-3.5" />
          Session Sections
        </div>
        <SectionButtons sections={sections} onSelect={onSelect} activeSectionId={activeSectionId} />
      </aside>

      <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] left-3 z-40 xl:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button className="h-11 rounded-full px-4 shadow-lg">
              <MapPinned className="h-4 w-4" />
              Jump
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[78vh] overflow-y-auto rounded-t-2xl px-4 pb-6 pt-5">
            <SheetHeader className="pr-8 text-left">
              <SheetTitle>Jump to section</SheetTitle>
              <SheetDescription>Move through this session without losing the thread.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              <SectionButtons sections={sections} onSelect={(section) => {
                setOpen(false);
                onSelect(section);
              }} closeOnSelect activeSectionId={activeSectionId} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
