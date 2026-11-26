import {createContext,useContext,useEffect,useRef,useState} from 'react';

export const VideoOverlayPreferenceScope=createContext(null);
const prefix='sarah.videoSync.overlayCardSettings.v1.';
const eventName='sarah:video-overlay-preference';
function read(key,fallback){try{const value=JSON.parse(localStorage.getItem(key));if(value==null||typeof value!==typeof fallback)return fallback;return typeof fallback==='object'?{...fallback,...value}:value;}catch{return fallback;}}
export function useOverlayCardSetting(name,initial,enabled) {
  const scope=useContext(VideoOverlayPreferenceScope),active=enabled??Boolean(scope),key=prefix+name;
  const [value,setValue]=useState(()=>active?read(key,initial):initial),ref=useRef(value);ref.current=value;
  useEffect(()=>{
    if(!active)return;
    const sync=event=>{if(event.key===key||event.detail?.key===key){const next=read(key,initial);ref.current=next;setValue(next);}};
    window.addEventListener('storage',sync);window.addEventListener(eventName,sync);
    return()=>{window.removeEventListener('storage',sync);window.removeEventListener(eventName,sync);};
  },[active,key]);
  return [value,next=>{
    const result=typeof next==='function'?next(ref.current):next;ref.current=result;setValue(result);
    if(active)try{localStorage.setItem(key,JSON.stringify(result));window.dispatchEvent(new CustomEvent(eventName,{detail:{key}}));}catch{/* Keep controls usable when storage is unavailable. */}
  }];
}
