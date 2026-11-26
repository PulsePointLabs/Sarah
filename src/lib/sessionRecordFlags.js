// SQLite-backed records can contain numeric flags. Never render the value itself.
export const recordFlag=value=>value===true||value===1||value==='1'||value==='true';
