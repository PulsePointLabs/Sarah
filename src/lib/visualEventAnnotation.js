export const VISUAL_ANNOTATION_VERSION = 1;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.max(0, Math.min(1, value));
export const visualClock = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
export const visualAnnotationSignature=annotation=>JSON.stringify({camera:annotation.camera,frame_time:annotation.frame.session_time_s,shapes:annotation.shapes.map(({id,type,label,color,points})=>({id,type,label,color,points})),calibration:annotation.calibration||null,reference_id:annotation.reference?.event_id||'',reference_revision:annotation.reference?.updated_at||''});

// Map pointer input to the actual contained image, not its letterboxed SVG element.
export function imagePoint(rect, width, height, clientX, clientY) {
  if(!width||!height||!rect.width||!rect.height)return null;
  const scale=Math.min(rect.width/width,rect.height/height);
  const x=(clientX-rect.left-(rect.width-width*scale)/2)/(width*scale);
  const y=(clientY-rect.top-(rect.height-height*scale)/2)/(height*scale);
  return x<0||y<0||x>1||y>1?null:{x:clamp(x),y:clamp(y)};
}

export function pixelDistance(a,b,width,height) {
  return Math.hypot((b.x-a.x)*width,(b.y-a.y)*height);
}
export function pointAngle([a,b,c],width,height) {
  if(!a||!b||!c)return null;
  const u={x:(a.x-b.x)*width,y:(a.y-b.y)*height},v={x:(c.x-b.x)*width,y:(c.y-b.y)*height};
  const norm=Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y);
  return norm>0?Math.acos(Math.max(-1,Math.min(1,(u.x*v.x+u.y*v.y)/norm)))*180/Math.PI:null;
}
export function rgbToHsv([r,g,b]) {
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  let hue=0;
  if(d)hue=max===r?60*((g-b)/d%6):max===g?60*((b-r)/d+2):60*((r-g)/d+4);
  return {hue_deg:(hue+360)%360,saturation:max?d/max:0,value:max};
}
export function sampleColor(imageData,points) {
  const {width,height,data}=imageData;
  if(points.length<2)return null;
  const left=Math.max(0,Math.floor(Math.min(points[0].x,points[1].x)*width));
  const right=Math.min(width,Math.ceil(Math.max(points[0].x,points[1].x)*width));
  const top=Math.max(0,Math.floor(Math.min(points[0].y,points[1].y)*height));
  const bottom=Math.min(height,Math.ceil(Math.max(points[0].y,points[1].y)*height));
  if(right<=left||bottom<=top)return null;
  const step=Math.max(1,Math.ceil(Math.sqrt((right-left)*(bottom-top)/50000)));
  let n=0,r=0,g=0,b=0;
  for(let y=top;y<bottom;y+=step)for(let x=left;x<right;x+=step){const i=(y*width+x)*4;if(data[i+3]<128)continue;r+=data[i];g+=data[i+1];b+=data[i+2];n++;}
  if(!n)return null;
  const rgb=[r/n,g/n,b/n],hsv=rgbToHsv(rgb);
  return {rgb:rgb.map(v=>Math.round(v)),...hsv,hue_deg:hsv.saturation>=.08?hsv.hue_deg:null,sample_count:n};
}

export function sameVisualCamera(a,b) {
  if(!a||!b||a.key!==b.key)return false;
  const identity=c=>c.fingerprint||c.path||c.source_name;
  return Boolean(identity(a)&&identity(a)===identity(b));
}

export function measureVisualShapes(annotation,imageData) {
  const {frame,shapes,calibration}=annotation;
  const width=frame.source_width||frame.width,height=frame.source_height||frame.height;
  const scaleShape=shapes.find(s=>s.id===calibration?.shape_id&&s.type==='scale');
  const scalePixels=scaleShape?.points.length===2?pixelDistance(...scaleShape.points,width,height):0;
  const unitsPerPixel=scalePixels>0&&Number(calibration?.length)>0?Number(calibration.length)/scalePixels:null;
  return shapes.map(shape=>{
    const metrics={};
    if(['distance','scale','arrow'].includes(shape.type)&&shape.points.length===2){
      metrics.distance_px=pixelDistance(...shape.points,width,height);
      if(unitsPerPixel&&shape.type==='distance'){metrics.distance=metrics.distance_px*unitsPerPixel;metrics.unit=calibration.unit;}
    }
    if(shape.type==='angle')metrics.angle_deg=pointAngle(shape.points,width,height);
    if(shape.type==='color'&&imageData)metrics.color=sampleColor(imageData,shape.points);
    return {...shape,metrics};
  });
}

export function compareVisualAnnotations(current,reference) {
  if(!reference||!sameVisualCamera(current.camera,reference.camera))return [];
  const sameResolution=(current.frame.source_width||current.frame.width)===(reference.frame.source_width||reference.frame.width)
    &&(current.frame.source_height||current.frame.height)===(reference.frame.source_height||reference.frame.height);
  return current.shapes.flatMap(shape=>{
    const matches=reference.shapes.filter(s=>s.type===shape.type&&s.label.trim().toLowerCase()===shape.label.trim().toLowerCase());
    if(matches.length!==1||current.shapes.filter(s=>s.type===shape.type&&s.label.trim().toLowerCase()===shape.label.trim().toLowerCase()).length!==1)return [];
    const previous=matches[0],m=shape.metrics||{},p=previous.metrics||{},delta={};
    if(sameResolution&&finite(m.distance_px)&&finite(p.distance_px)&&p.distance_px>0){delta.distance_px=m.distance_px-p.distance_px;delta.distance_percent=(m.distance_px/p.distance_px-1)*100;}
    if(m.unit&&m.unit===p.unit&&finite(m.distance)&&finite(p.distance))delta.distance=m.distance-p.distance;
    if(finite(m.angle_deg)&&finite(p.angle_deg))delta.angle_deg=m.angle_deg-p.angle_deg;
    if(m.color&&p.color){
      if(finite(m.color.hue_deg)&&finite(p.color.hue_deg))delta.hue_deg=(m.color.hue_deg-p.color.hue_deg+540)%360-180;
      delta.saturation_pp=(m.color.saturation-p.color.saturation)*100;
      delta.brightness_pp=(m.color.value-p.color.value)*100;
      delta.rgb=m.color.rgb.map((v,i)=>v-p.color.rgb[i]);
    }
    return Object.keys(delta).length?[{shape_id:shape.id,reference_shape_id:previous.id,label:shape.label,delta,reference_metrics:p}]:[];
  });
}

const signed=(value,digits=1)=>`${value>=0?'+':''}${value.toFixed(digits)}`;
export function visualMetricLines(annotation) {
  if(!annotation?.shapes)return [];
  return annotation.shapes.map(shape=>{
    const m=shape.metrics||{},parts=[];
    if(finite(m.distance_px))parts.push(`${m.distance_px.toFixed(1)} px${finite(m.distance)?` · ${m.distance.toFixed(2)} ${m.unit}`:''}`);
    if(finite(m.angle_deg))parts.push(`${m.angle_deg.toFixed(1)}°`);
    if(m.color)parts.push(`RGB ${m.color.rgb.join('/')} · H ${finite(m.color.hue_deg)?m.color.hue_deg.toFixed(1)+'°':'— (low saturation)'} · S ${(m.color.saturation*100).toFixed(0)}% · V ${(m.color.value*100).toFixed(0)}%`);
    const delta=annotation.comparisons?.find(c=>c.shape_id===shape.id)?.delta;
    if(delta){
      if(finite(delta.distance_percent))parts.push(`Δ ${signed(delta.distance_px)} px (${signed(delta.distance_percent)}%)`);
      if(finite(delta.angle_deg))parts.push(`Δ ${signed(delta.angle_deg)}°`);
      if(finite(delta.hue_deg))parts.push(`Δ hue ${signed(delta.hue_deg)}°`);
      if(finite(delta.brightness_pp))parts.push(`Δ V ${signed(delta.brightness_pp)} pp`);
    }
    return `${shape.label}: ${parts.join(' · ')||shape.type}`;
  });
}

export async function captureVisualFrame(video,camera,sessionTimeS) {
  if(!video||video.readyState<2||!video.videoWidth)throw Error('Load this camera video before marking a frame.');
  const target=sessionTimeS-(Number(camera.timelineOffsetSeconds)||0);
  if(target<0||Number.isFinite(video.duration)&&target>video.duration)throw Error('This event time is outside the selected camera video.');
  video.pause();
  if(Math.abs(video.currentTime-target)>.025)await new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);video.removeEventListener('seeked',onSeek);error?reject(error):resolve();};
    const onSeek=()=>finish();const timer=setTimeout(()=>finish(Error('The camera did not finish seeking. Try again.')),8000);
    video.addEventListener('seeked',onSeek,{once:true});video.currentTime=target;
  });
  const ratio=Math.min(1,1280/video.videoWidth,1280/video.videoHeight),canvas=document.createElement('canvas');
  canvas.width=Math.round(video.videoWidth*ratio);canvas.height=Math.round(video.videoHeight*ratio);
  const context=canvas.getContext('2d');context.drawImage(video,0,0,canvas.width,canvas.height);
  // All subsequent measurements sample this saved frame, so reopening is reproducible.
  return {width:canvas.width,height:canvas.height,source_width:video.videoWidth,source_height:video.videoHeight,video_time_s:video.currentTime,session_time_s:video.currentTime+(Number(camera.timelineOffsetSeconds)||0),data_url:canvas.toDataURL('image/jpeg',.84)};
}

export function drawVisualShapes(context,annotation,{labels=true}={}) {
  const {width,height}=annotation.frame,weight=Math.max(2,width/450);
  context.lineWidth=weight;context.lineJoin='round';context.lineCap='round';
  for(const [index,shape]of annotation.shapes.entries()){
    const points=shape.points.map(p=>({x:p.x*width,y:p.y*height}));if(!points.length)continue;
    context.strokeStyle=shape.color||'#22d3ee';context.fillStyle=context.strokeStyle;context.beginPath();
    if(['rectangle','color','ellipse'].includes(shape.type)&&points.length>1){
      const [a,b]=points,l=Math.min(a.x,b.x),t=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
      if(shape.type==='ellipse')context.ellipse(l+w/2,t+h/2,w/2,h/2,0,0,Math.PI*2);else context.rect(l,t,w,h);
    }else{context.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>context.lineTo(p.x,p.y));}
    if(shape.type==='highlight'){context.lineWidth=weight*6;context.globalAlpha=.4;}context.stroke();context.lineWidth=weight;context.globalAlpha=1;
    if(['distance','angle','scale'].includes(shape.type))for(const p of points){context.beginPath();context.arc(p.x,p.y,weight*2,0,Math.PI*2);context.fill();}
    if(labels){context.font=`bold ${Math.max(16,width/65)}px sans-serif`;const text=`${index+1}. ${shape.label}`,x=Math.min(width-context.measureText(text).width-6,Math.max(4,points[0].x)),y=Math.max(23,points[0].y-8);context.fillStyle='#000c';context.fillRect(x-3,y-19,context.measureText(text).width+6,24);context.fillStyle=shape.color||'#22d3ee';context.fillText(text,x,y);}
  }
}

export async function loadVisualImage(frame) {
  if(!/^data:image\/(?:jpeg|png);base64,/.test(frame.data_url||''))throw Error('Saved frame is missing or unsupported.');
  const image=new Image();image.src=frame.data_url;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=frame.width;canvas.height=frame.height;canvas.getContext('2d').drawImage(image,0,0,frame.width,frame.height);return canvas;
}

export async function finalizeVisualAnnotation(annotation,reference) {
  const canvas=await loadVisualImage(annotation.frame),context=canvas.getContext('2d');
  const result={...annotation,version:VISUAL_ANNOTATION_VERSION,measurement_space:'source image pixels; optional explicit in-plane scale',color_method:'mean sRGB region converted to HSV',updated_at:new Date().toISOString(),shapes:measureVisualShapes(annotation,context.getImageData(0,0,canvas.width,canvas.height))};
  result.comparisons=compareVisualAnnotations(result,reference);
  result.reference=reference?{event_id:reference.event_id,updated_at:reference.updated_at,camera:reference.camera,session_time_s:reference.frame.session_time_s}:null;
  drawVisualShapes(context,result);result.marked_frame_data_url=canvas.toDataURL('image/jpeg',.84);
  return result;
}

// Bound and sanitize the context sent to the existing visual-review provider.
export function visualAnnotationAIContext(annotation) {
  if(annotation?.version!==1||!annotation.frame||!Array.isArray(annotation.shapes))return {prompt:'',images:[]};
  const images=[];
  if(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(annotation.marked_frame_data_url||'')&&annotation.marked_frame_data_url.length<1500000)images.push({filename:'user-marked-event-frame.jpg',media_type:'image/jpeg',data:annotation.marked_frame_data_url.split(',')[1]});
  const metadata={camera:annotation.camera?.label,frame_session_time_s:annotation.frame.session_time_s,source_width:annotation.frame.source_width,source_height:annotation.frame.source_height,shapes:annotation.shapes.map(s=>({id:s.id,type:s.type,label:String(s.label||'').slice(0,120),points:s.points?.slice(0,250),metrics:s.metrics})),calibration:annotation.calibration,reference:annotation.reference,comparisons:annotation.comparisons};
  return {images,prompt:`\nUSER VISUAL MARKINGS (the extra labeled marked frame is an attention guide at its own stated timestamp):\n${JSON.stringify(metadata)}\nCoordinates are normalized to the unmirrored original camera image, not to the playback window. Follow the numbered labels to identify exactly which region or landmarks the person means. Do not treat drawn lines as anatomy. Reference comparisons are image-plane measurements, not proof of physiological change: perspective, pose, lighting, white balance and exposure can change them. Two-point width is not circumference; pixel distance is not physical length unless an explicit in-plane scale is present. Hue is undefined at low saturation. Keep the person's labels as attention cues, not facts to validate. Report relevant visible evidence and uncertainty; never invent hidden anatomy or causation.\n`};
}
