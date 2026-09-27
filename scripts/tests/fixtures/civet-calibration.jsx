import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import CivetSetup from '/src/components/CivetSetup.jsx';
import {createCivetProcessor} from '/src/lib/civet.js';
import '/src/index.css';
const processor=createCivetProcessor();let t=0,pressure=2,latest=null,history=[];
window.fetch=async(url,options)=>{const body=JSON.parse(options?.body||'{}');if(String(url).endsWith('/calibrate'))processor.calibrate(body.kind,{prepareS:body.prepare_s||0});if(String(url).endsWith('/zero')){window.zeroCalls=(window.zeroCalls||0)+1;processor.invalidate();}return {ok:true,json:async()=>({})};};
function Fixture(){const [live,setLive]=useState({state:'connected',history:[],latest:null});useEffect(()=>{const timer=setInterval(()=>{t+=.1;latest=processor.ingest(pressure,t);history.push(latest);history=history.slice(-100);setLive({state:'connected',latest,history:[...history]});},100);window.setPressure=v=>{pressure=v;};return()=>clearInterval(timer);},[]);return <CivetSetup live={live} onClose={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
