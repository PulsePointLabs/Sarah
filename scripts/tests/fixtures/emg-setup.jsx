import React from 'react';
import { createRoot } from 'react-dom/client';
import EmgSetup from '../../../src/components/EmgSetup.jsx';
import '../../../src/index.css';
window.emgTest={installed:true,running:true,receiving:true,channels:2,port:'COM7',profile:{names:['Foot','Perineal'],notes:['',''],channels:2},setup:{fresh:true,values:[100,110],history:[{values:[100,110]},{values:[102,108]}],calibration:{phase:'idle',reference:[null,null],rest:null}}};
window.emgCommands=[];
window.fetch=async(url,options)=>{const path=String(url).split('/emg/')[1];let result={};if(path==='helper')result=window.emgTest;if(path==='ports')result={ports:[{port:'COM7',label:'Arduino'}]};if(path==='profile'){window.emgTest.profile=JSON.parse(options.body);result=window.emgTest.profile;}if(path==='calibration-command'){const command=JSON.parse(options.body);window.emgCommands.push(command);window.emgTest.setup.calibration={...window.emgTest.setup.calibration,phase:'preparing',remaining_s:3};result={id:'test'};}return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});};
createRoot(document.getElementById('root')).render(<EmgSetup onClose={()=>{}} onProfileChange={names=>{window.lastNames=names;}}/>);
