/**
 * Coarse, privacy-preserving client hints for moderation dashboards.
 * Browser-supplied metadata can be spoofed and must never authorize a ban.
 */
export function getClientDeviceDetails(): { last_device: string; last_browser: string } {
  if (typeof navigator === 'undefined') return { last_device: '未知', last_browser: '未知' };
  const agent = navigator.userAgent || '';
  let device = '電腦';
  if (/iPhone/i.test(agent)) device = 'iPhone';
  else if (/iPad/i.test(agent)) device = 'iPad';
  else if (/Android/i.test(agent)) device = /Mobile/i.test(agent) ? 'Android 手機' : 'Android 平板';
  else if (/Windows/i.test(agent)) device = 'Windows 電腦';
  else if (/Macintosh|Mac OS/i.test(agent)) device = 'Mac 電腦';
  else if (/Linux/i.test(agent)) device = 'Linux 電腦';

  let browser = '其他瀏覽器';
  if (/Edg\//i.test(agent)) browser = 'Edge';
  else if (/SamsungBrowser\//i.test(agent)) browser = 'Samsung Internet';
  else if (/OPR\//i.test(agent)) browser = 'Opera';
  else if (/FxiOS|Firefox\//i.test(agent)) browser = 'Firefox';
  else if (/CriOS|Chrome\//i.test(agent)) browser = 'Chrome';
  else if (/Safari\//i.test(agent)) browser = 'Safari';
  return { last_device: device, last_browser: browser };
}
