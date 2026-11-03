import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { anatomySections, evidenceFramesFor } from '../lib/anatomyReview.js';
import { formatSessionClock } from '../lib/manualAnnotationReviewText.js';
import { serverUrl } from '../lib/mobileApiBase';

export default function AnatomyEvidenceReview({ findings = [], frames = [], role = 'main', onSeek }) {
  const trigger=useRef(null);
  const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[image,setImage]=useState(null);
  const sections=useMemo(()=>anatomySections(findings,role),[findings,role]);
  const section=sections.find(item=>item.id===selected) || sections.find(item=>item.findings.length) || sections[0];
  const close=()=>{setOpen(false);setImage(null);trigger.current?.focus();};
  return <><button ref={trigger} type="button" onClick={()=>setOpen(true)} className="mt-3 min-h-11 rounded-lg border border-primary/30 px-3 py-2 text-sm font-semibold text-primary">Anatomy &amp; images</button>
    {open && createPortal(<div className="fixed inset-0 z-[19000] flex items-center justify-center bg-black/65 p-3" onPointerDown={e=>{if(e.target===e.currentTarget)close();}}>
      <section data-anatomy-dialog role="dialog" aria-modal="true" aria-label="Anatomy and visual evidence" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}} className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background text-base text-foreground shadow-xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4"><div><h3 className="text-xl font-semibold">Anatomy &amp; evidence</h3><p className="text-sm text-muted-foreground">{['feet','lower_body','lower-body'].includes(role)?'Feet / lower-body camera':'Main camera'} · saved observations</p></div><button autoFocus type="button" onClick={close} className="min-h-11 rounded-lg border border-border px-4">Close</button></header>
        <div className="grid min-h-0 overflow-y-auto md:grid-cols-[220px_minmax(0,1fr)]"><nav aria-label="Anatomical areas" className="flex flex-wrap gap-2 border-b border-border p-3 md:flex-col md:border-b-0 md:border-r">{sections.map(item=><button key={item.id} type="button" aria-pressed={section.id===item.id} onClick={()=>{setSelected(item.id);setImage(null);}} className={`min-h-11 rounded-lg px-3 py-2 text-left text-base ${section.id===item.id?'bg-primary/15 text-primary':'bg-muted/30'}`}>{item.label}</button>)}</nav>
          <main className="min-w-0 p-4"><h4 className="mb-3 text-lg font-semibold">{section.label}</h4>{!section.findings.length && <p className="text-muted-foreground">Not covered in this saved review. No observation has been inferred.</p>}
            {section.findings.map((finding,index)=>{const evidence=evidenceFramesFor(finding,frames);const time=finding.evidence_time_s ?? finding.time_s;return <article key={index} className="mb-5 border-b border-border pb-4"><p className="leading-relaxed">{finding.visibility==='not_visible'?'Not visible in this camera view.':finding.observation}</p>{finding.progression && <p className="mt-2 leading-relaxed">{finding.progression}</p>}{(finding.confidence==='low' || finding.evidence_status==='candidate') && <p className="mt-2 text-sm text-amber-500">Possible finding · uncertain</p>}
              {Number.isFinite(Number(time)) && time!=null && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm"><span>{formatSessionClock(time)} · {['feet','lower_body','lower-body','foot'].includes(role)?'Feet / lower body':'Main'}</span>{onSeek && <button type="button" onClick={()=>{onSeek(Number(time));close();}} className="min-h-11 rounded-lg border border-border px-3">View in video</button>}</div>}
              <div className="mt-3 flex flex-wrap gap-3">{evidence.map((frame,i)=><button key={i} type="button" onClick={()=>setImage(frame)} className="max-w-48 rounded-lg border border-border p-1"><img src={serverUrl(frame.url)} alt={`Saved ${section.label} evidence at ${formatSessionClock(frame.recordTimeSeconds ?? frame.time_s)}`} className="max-h-36 w-full object-contain" loading="lazy"/><span className="block px-2 py-1 text-sm">{formatSessionClock(frame.recordTimeSeconds ?? frame.time_s)} · Open image</span></button>)}</div>
              {!evidence.length && finding.visibility!=='not_visible' && <p className="mt-2 text-sm text-muted-foreground">No matching image was saved for this observation.</p>}
            </article>;})}
            {image && <div className="mt-3"><button type="button" onClick={()=>setImage(null)} className="mb-2 min-h-11 rounded-lg border border-border px-3">Close image</button><img src={serverUrl(image.url)} alt={`Full saved evidence at ${formatSessionClock(image.recordTimeSeconds ?? image.time_s)}`} className="max-h-[60dvh] w-full object-contain"/></div>}
          </main>
        </div>
      </section>
    </div>,trigger.current.ownerDocument.body)}
  </>;
}
