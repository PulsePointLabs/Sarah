export function civetCsv(rows,keys) {
  const cell=value=>{const s=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;};
  return [keys.join(','),...rows.map(row=>keys.map(key=>cell(row[key])).join(','))].join('\r\n');
}
