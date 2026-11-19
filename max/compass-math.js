const rad = Math.PI / 180;
export const wrap = angle => (angle % 360 + 360) % 360;
export const delta = angle => wrap(angle + 180) - 180;
const kaabaLatitude = 21.4225 * rad;
const kaabaLongitude = 39.8262;

export function centralAngle(lat, lon) {
  const p = lat * rad, d = (kaabaLongitude - lon) * rad;
  const cosine = Math.sin(p) * Math.sin(kaabaLatitude) + Math.cos(p) * Math.cos(kaabaLatitude) * Math.cos(d);
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

export function bearing(lat, lon) {
  const d = (kaabaLongitude - lon) * rad, k = kaabaLatitude, p = lat * rad;
  const y = Math.sin(d) * Math.cos(k);
  const x = Math.cos(p)*Math.sin(k) - Math.sin(p)*Math.cos(k)*Math.cos(d);
  return Math.hypot(x,y) < 1e-6 ? null : wrap(Math.atan2(y,x)/rad);
}
// Sea-level WMM-2025 horizontal field (north/east nT and yearly change), 2° grid.
export function declination(grid, lat, lon, year) {
  if (!grid || year < 2025 || year >= 2030) return null;
  const row = (lat+90)/2, col = wrap(lon+180)/2;
  let north=0, east=0;
  for (const dy of [0,1]) for (const dx of [0,1]) {
    const offset = 4*(Math.min(90,Math.floor(row)+dy)*180+(Math.floor(col)+dx)%180);
    const weight = (dy ? row%1 : 1-row%1)*(dx ? col%1 : 1-col%1);
    north += weight*(grid[offset]+(year-2025)*grid[offset+2]);
    east += weight*(grid[offset+1]+(year-2025)*grid[offset+3]);
  }
  return Math.hypot(north,east)>=6000 ? Math.atan2(east,north)/rad : null;
}
