const number=(...values)=>values.find(v=>typeof v==='number'&&Number.isFinite(v))??null;
export function howlLiveView(sample,now=Date.now()){
  const at=Date.parse(sample?.measured_at||sample?.received_at||'');
  const fresh=sample?.connected!==false&&sample?.connection_state!=='disconnected'&&Number.isFinite(at)&&now-at<6500&&now-at>=-1000;
  const raw=sample?.raw||{},options=sample?.options||raw.options||{},player=sample?.player||raw.player||{};
  const muted=sample?.mute??options.mute;
  return {fresh,muted,activity:sample?.activity_name||player.title||player.filename||'No activity reported',playing:player.playing===true||player.is_playing===true,
    channels:['a','b'].map(key=>{
      const channel=sample?.channel_state?.[key]||sample?.channels?.[key]||raw.channels?.[key]||{};
      const power=number(sample?.[`power_${key}`],options[`power_${key}`],channel.intensity);
      const current=number(channel.current_ma,raw[`current_${key}_ma`]);
      const active=channel.output_active??channel.current_active??null;
      const waveform=channel.waveform_samples??raw.waveform_samples?.[key];
      return {key,power:fresh?power:null,current:fresh?current:null,active:fresh&&!muted?active:muted?false:null,
        frequency:fresh?number(channel.frequency_hz,sample?.frequency_hz):null,
        samples:fresh&&Array.isArray(waveform)?waveform.filter(v=>typeof v==='number'&&Number.isFinite(v)).slice(-256):[]};
    })};
}
