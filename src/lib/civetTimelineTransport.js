// Lossless wire encoding: repeated calibration/provenance objects and strings
// travel once, while every sample and its original timestamp remain present.
function packRows(rows) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return { keys, columns: keys.map(key => {
    const dictionary = [], indexes = new Map();
    const values = rows.map(row => {
      const value = row[key];
      if (value === undefined) return [0];
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      const signature = JSON.stringify(value);
      if (!indexes.has(signature)) { indexes.set(signature, dictionary.length); dictionary.push(value); }
      return [1, indexes.get(signature)];
    });
    return { values, dictionary };
  }), count: rows.length };
}
function unpackRows(table) {
  return Array.from({ length: table.count }, (_, index) => Object.fromEntries(table.keys.flatMap((key, column) => {
    const { values, dictionary } = table.columns[column];
    const value = values[index];
    return Array.isArray(value) ? value[0] === 0 ? [] : [[key, dictionary[value[1]]]] : [[key, value]];
  })));
}
function transform(data, operation) {
  const analysis = data.analysis ? { ...data.analysis } : null;
  if (analysis) for (const mode of ['live', 'review', 'reprocessed']) {
    if (analysis[mode]?.rows) analysis[mode] = { ...analysis[mode], rows: operation(analysis[mode].rows) };
  }
  return { ...data, samples: operation(data.samples), analysis };
}
export const packCivetTimeline = data => ({ ...transform(data, packRows), encoding: 'civet-columns-v1' });
export const unpackCivetTimeline = data => data.encoding === 'civet-columns-v1' ? transform(data, unpackRows) : data;
