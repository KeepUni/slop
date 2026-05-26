export function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const tz = date.getTimezoneOffset();
  const sign = tz <= 0 ? "+" : "-";
  const tzh = String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0");
  const tzm = String(Math.abs(tz) % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${tzh}:${tzm}`;
}
