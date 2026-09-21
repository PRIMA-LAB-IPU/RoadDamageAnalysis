// Pure helpers shared by recording, imported logs and playback.
export function normalizePoints(points) {
  if (!Array.isArray(points)) throw new Error('位置情報の配列がありません。');
  const result = points.map(p => {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.videoTime) || p.videoTime < 0)
      throw new Error('位置情報の時刻が不正です。');
    const valid = p.latitude != null && p.longitude != null;
    if (valid && (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180))
      throw new Error('緯度・経度が不正です。');
    return {...p, latitude: valid ? p.latitude : null, longitude: valid ? p.longitude : null,
      accuracy: Number.isFinite(p.accuracy) && p.accuracy >= 0 ? p.accuracy : null};
  }).sort((a,b) => a.videoTime - b.videoTime);
  return result.filter((p,i) => !i || p.videoTime !== result[i-1].videoTime);
}

export function positionAt(points, time) {
  if (!points.length) return null;
  let low = 0, high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].videoTime < time) low = mid + 1; else high = mid;
  }
  const b = points[Math.min(low, points.length - 1)], a = points[Math.max(0, low - 1)];
  if (b.videoTime === time) return b.latitude == null ? null : b;
  if (a.latitude == null || b.latitude == null) return null;
  const r = b.videoTime > a.videoTime ? Math.max(0, Math.min(1, (time-a.videoTime)/(b.videoTime-a.videoTime))) : 0;
  const deltaLon = ((b.longitude-a.longitude+540)%360)-180;
  return {videoTime:time, latitude:a.latitude+(b.latitude-a.latitude)*r,
    longitude:((a.longitude+deltaLon*r+540)%360)-180,
    altitude:a.altitude == null || b.altitude == null ? null : a.altitude+(b.altitude-a.altitude)*r,
    accuracy:a.accuracy == null || b.accuracy == null ? null : a.accuracy+(b.accuracy-a.accuracy)*r};
}

export function interpolateFrames(points, duration, fps) {
  return Array.from({length:Math.max(0,Math.floor(duration*fps))}, (_,frame) => {
    const videoTime = +(frame/fps).toFixed(6), p = positionAt(points,videoTime);
    return {frame,videoTime,latitude:p?.latitude??null,longitude:p?.longitude??null,altitude:p?.altitude??null,accuracy:p?.accuracy??null};
  });
}

export function parseLog(text, name) {
  if (name.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    return {points:normalizePoints(data.gps || data.frames), meta:data};
  }
  const rows = text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(row => row.split(','));
  const header = rows.shift();
  const fields = ['video_time_s','latitude','longitude'];
  if (!fields.every(f=>header.includes(f))) throw new Error('対応するGPS CSVではありません。');
  const get = (row,key) => {const s=row[header.indexOf(key)]; return s == null || s.trim()==='' ? null : Number(s)};
  const points = rows.filter(row=>row.some(v=>v.trim())).map(row=>({videoTime:get(row,'video_time_s'),
    latitude:get(row,'latitude'),longitude:get(row,'longitude'),altitude:get(row,'altitude_m'),
    accuracy:get(row,'accuracy_m'),speed:get(row,'speed_mps'),heading:get(row,'heading_deg'),absoluteTime:row[header.indexOf('absolute_time')]}));
  return {points:normalizePoints(points),meta:{}};
}

export function makeCsv(points) {
  return '\uFEFF'+['video_time_s,absolute_time,latitude,longitude,altitude_m,accuracy_m,speed_mps,heading_deg',
    ...points.map(p=>[p.videoTime.toFixed(6),p.absoluteTime??'',p.latitude??'',p.longitude??'',p.altitude??'',p.accuracy??'',p.speed??'',p.heading??''].join(','))].join('\n');
}
