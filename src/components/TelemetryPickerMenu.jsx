import { useCallback, useEffect, useRef, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';

// Render in the trigger's document, including the detached telemetry window.
export default function TelemetryPickerMenu({ label, summary, options, className = '', help, notice }) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState(null);
  const trigger = useRef(null), content = useRef(null);
  const triggerRef = useCallback(node => { trigger.current=node; setContainer(node?.ownerDocument.body || null); }, []);
  useEffect(() => {
    if (!open || !container) return;
    const owner=container.ownerDocument, win=owner.defaultView;
    // Full Telemetry is itself a dialog. Handle Escape before its capture-phase
    // listener can consume it, and dismiss on touch outside in the same document.
    const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}};
    const outside=event=>{if(!trigger.current?.contains(event.target)&&!content.current?.contains(event.target))setOpen(false);};
    win.addEventListener('keydown',key,true);owner.addEventListener('pointerdown',outside,true);
    return()=>{win.removeEventListener('keydown',key,true);owner.removeEventListener('pointerdown',outside,true);};
  },[open,container]);
  return <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
    <Menu.Trigger ref={triggerRef} aria-label={label} className={`flex shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-base font-semibold ${className}`}>
      {label}{summary && <span className="text-muted-foreground">{summary}</span>}<ChevronDown className="h-3 w-3" />
    </Menu.Trigger>
    <Menu.Portal container={container}>
      <Menu.Content ref={content} align="end" sideOffset={6} collisionPadding={10} aria-labelledby={undefined} aria-label={`${label} options`}
        onEscapeKeyDown={event => { event.stopPropagation(); setOpen(false); }}
        onPointerDownOutside={() => setOpen(false)} onFocusOutside={() => setOpen(false)}
        className="z-[16000] min-w-[200px] max-w-[calc(100vw-20px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none"
        style={{ maxHeight: 'min(420px, var(--radix-dropdown-menu-content-available-height))' }}>
        {help && <p className="max-w-72 px-3 py-2 text-xs text-muted-foreground">{help}</p>}
        {options.map(option => <Menu.CheckboxItem key={option.id} checked={option.checked} disabled={option.disabled}
          onCheckedChange={option.onChange} onSelect={() => setOpen(false)}
          className="relative flex min-h-10 cursor-pointer select-none items-center rounded px-3 py-2 pl-8 text-base outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50">
          <Menu.ItemIndicator className="absolute left-2"><Check className="h-4 w-4" /></Menu.ItemIndicator>{option.label}
        </Menu.CheckboxItem>)}
        {notice && <p role="status" className="max-w-72 px-3 py-2 text-xs">{notice}</p>}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
