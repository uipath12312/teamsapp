const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createMeetingId(length = 6) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function normalizeMeetingId(value: string) {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/\/meeting\/([A-Za-z0-9-]+)/);
  return (fromUrl?.[1] ?? trimmed).replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
}

export function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "");
}

export function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
