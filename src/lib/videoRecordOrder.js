export function sortVideoRecords(records) {
  const time = record => {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(record.start_time || '');
    if (!match) return -1;
    const hour = match[4] ? Number(match[1]) % 12 + (/pm/i.test(match[4]) ? 12 : 0) : Number(match[1]);
    return hour * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
  };
  return [...records].sort((a,b) => String(b.date || '').slice(0,10).localeCompare(String(a.date || '').slice(0,10))
    || time(b) - time(a) || String(b.created_date || '').localeCompare(String(a.created_date || '')));
}
