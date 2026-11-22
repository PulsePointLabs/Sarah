import test from 'node:test';
import assert from 'node:assert/strict';
import {imagePoint,pixelDistance,pointAngle,sampleColor,measureVisualShapes,compareVisualAnnotations,visualMetricLines,visualAnnotationAIContext} from './visualEventAnnotation.js';
const camera={key:'composite',fingerprint:'original-a',label:'Main'};
const frame={width:1000,height:500,source_width:2000,source_height:1000,session_time_s:10};
const line={id:'length',type:'distance',label:'Penile length',points:[{x:.1,y:.1},{x:.4,y:.9}]};
test('image coordinates honor letterboxing and source pixel aspect',()=>{
  const rect={left:100,top:50,width:1000,height:1000};
  assert.equal(imagePoint(rect,1000,500,600,100),null);
  assert.deepEqual(imagePoint(rect,1000,500,600,550),{x:.5,y:.5});
  assert.equal(pixelDistance(...line.points,1000,500),500);
  assert.equal(pointAngle([{x:0,y:0},{x:.5,y:0},{x:.5,y:1}],1000,500),90);
  assert.equal(pointAngle([{x:0,y:0},{x:0,y:0},{x:1,y:1}],1000,500),null);
});
test('ROI sampling reads the selected pixels; achromatic regions have no useful hue',()=>{
  const image={width:2,height:1,data:new Uint8ClampedArray([255,0,0,255,0,255,0,255])};
  const red=sampleColor(image,[{x:0,y:0},{x:.5,y:1}]);assert.deepEqual(red.rgb,[255,0,0]);assert.equal(red.hue_deg,0);
  assert.equal(sampleColor({...image,data:new Uint8ClampedArray([100,100,100,255,100,100,100,255])},[{x:0,y:0},{x:1,y:1}]).hue_deg,null);
});
test('measurements retain source pixels and only use an explicit scale for physical units',()=>{
  const raw=measureVisualShapes({frame,shapes:[line]});assert.equal(raw[0].metrics.distance_px,1000);assert.equal(raw[0].metrics.distance,undefined);
  const scale={...line,id:'scale',type:'scale'};
  const measured=measureVisualShapes({frame,shapes:[scale,line],calibration:{shape_id:'scale',length:10,unit:'cm'}});assert.equal(measured[1].metrics.distance,10);assert.equal(measured[1].metrics.unit,'cm');
});
test('comparisons match unique labels on the same source and wrap hue changes correctly',()=>{
  const shape={...line,metrics:{distance_px:100,color:{rgb:[100,20,20],hue_deg:350,saturation:.8,value:.7}}};
  const baseline={camera,frame,shapes:[shape]};
  const current={camera,frame,shapes:[{...shape,metrics:{distance_px:120,color:{rgb:[100,30,20],hue_deg:10,saturation:.7,value:.6}}}]};
  const results=compareVisualAnnotations(current,baseline);assert.equal(results[0].delta.hue_deg,20);assert.ok(Math.abs(results[0].delta.distance_percent-20)<1e-8);
  assert.deepEqual(compareVisualAnnotations({...current,camera:{...camera,fingerprint:'different-video'}},baseline),[]);
  assert.deepEqual(compareVisualAnnotations(current,{...baseline,shapes:[shape,shape]}),[]);
  assert.match(visualMetricLines({...current,comparisons:results})[0],/Δ hue \+20.0°/);
});
test('AI context includes exact labeled geometry and bounded marked images',()=>{
  const context=visualAnnotationAIContext({version:1,camera,frame,shapes:[line],marked_frame_data_url:'data:image/jpeg;base64,YQ=='});
  assert.equal(context.images.length,1);assert.match(context.prompt,/Penile length/);assert.match(context.prompt,/Two-point width is not circumference/);
  assert.equal(visualAnnotationAIContext({version:2}).images.length,0);
});
