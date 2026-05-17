import { useState } from "react";
import { Settings, GripVertical, Eye, EyeOff, X } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { ALL_WIDGETS } from "@/hooks/useDashboardWidgets";

export default function DashboardCustomizer({ config, onToggle, onReorder }) {
  const [open, setOpen] = useState(false);

  const handleDragEnd = (result) => {
    if (!result.destination) return;
    onReorder(result.source.index, result.destination.index);
  };

  const labelFor = (id) => ALL_WIDGETS.find((w) => w.id === id)?.label ?? id;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
        title="Customize dashboard"
      >
        <Settings className="w-3.5 h-3.5" /> Customize
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 mb-4 sm:mb-0 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="font-semibold text-sm">Customize Dashboard</h2>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Hint */}
            <p className="text-[11px] text-muted-foreground px-4 pt-3 pb-1">
              Drag to reorder · tap eye to show/hide
            </p>

            {/* Widget list */}
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="widgets">
                {(provided) => (
                  <ul
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="px-3 pb-4 space-y-1 max-h-[60vh] overflow-y-auto"
                  >
                    {config.map((w, idx) => (
                      <Draggable key={w.id} draggableId={w.id} index={idx}>
                        {(provided, snapshot) => (
                          <li
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors ${
                              snapshot.isDragging
                                ? "border-primary bg-primary/10 shadow-lg"
                                : "border-border bg-muted/30"
                            }`}
                          >
                            <span
                              {...provided.dragHandleProps}
                              className="text-muted-foreground cursor-grab active:cursor-grabbing"
                            >
                              <GripVertical className="w-4 h-4" />
                            </span>
                            <span className={`flex-1 text-xs ${w.visible ? "text-foreground" : "text-muted-foreground line-through"}`}>
                              {labelFor(w.id)}
                            </span>
                            <button
                              onClick={() => onToggle(w.id)}
                              className={`p-1 rounded transition-colors ${w.visible ? "text-primary hover:bg-primary/10" : "text-muted-foreground hover:bg-muted"}`}
                            >
                              {w.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                            </button>
                          </li>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </ul>
                )}
              </Droppable>
            </DragDropContext>
          </div>
        </div>
      )}
    </>
  );
}