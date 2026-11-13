export function createPhoneCivetIngest(db, ingest) {
  db.exec('CREATE TABLE IF NOT EXISTS phone_civet_packets (id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, body TEXT NOT NULL)');
  const insert=db.prepare('INSERT OR IGNORE INTO phone_civet_packets (id,timestamp_ms,body) VALUES (?,?,?)');
  const store=db.transaction(packets=>packets.map(packet=>({packet,inserted:insert.run(packet.id,packet.reading.timestamp_ms,JSON.stringify(packet.reading)).changes>0})));
  return packets=>{
    if(!Array.isArray(packets)||!packets.length||packets.length>200)throw Error('Expected 1–200 phone pressure packets.');
    for(const packet of packets){
      const row=packet?.reading;
      if(!/^[a-zA-Z0-9_-]{8,160}$/.test(packet?.id||'')||!row||!Number.isFinite(row.timestamp_ms)||row.timestamp_ms<0||!Number.isFinite(row.monotonic_ms))throw Error('Invalid phone pressure packet.');
      if(!Number.isInteger(row.sequence)||!row.connection_id)throw Error('Invalid phone pressure identity.');
      if(row.type==='calibration_requested'){
        if(!['baseline','reference'].includes(row.kind)||!Number.isFinite(row.prepare_s)||row.prepare_s<0||row.prepare_s>10)throw Error('Invalid phone calibration.');
      }else if(row.type!=='hardware_zero'&&!Number.isFinite(row.pressure_kpa))throw Error('Invalid phone pressure sample.');
    }
    const result=store(packets);
    // Replay in acquisition order, including calibration commands. The monitor
    // uses acquisition timestamps so backfill never appears as fresh pressure.
    for(const {packet,inserted} of result)if(inserted)ingest(packet.reading);
    return {ok:true,acknowledged:packets.map(p=>p.id)};
  };
}
