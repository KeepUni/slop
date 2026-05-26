export function formatDateString(d: Date): string {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  const sc = String(d.getSeconds()).padStart(2, "0");
  const off = d.getTimezoneOffset();
  const sgn = off <= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const om = String(Math.abs(off) % 60).padStart(2, "0");
  return `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}${sgn}${oh}:${om}`;
}

export function Card({ when }: { when: Date }) {
  return <div>{formatDateString(when)}</div>;
}
