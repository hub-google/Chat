export type IpLocation = {
  ip: string;
  locationZh: string;
  latitude: number | null;
  longitude: number | null;
};

type IpWhoResponse = {
  success?: boolean;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
};

const toTraditionalChinese = (value: string) => value
  .replaceAll('台湾', '台灣')
  .replaceAll('台北县', '新北市')
  .replaceAll('台北市', '臺北市')
  .replaceAll('台中市', '臺中市')
  .replaceAll('台南市', '臺南市')
  .replaceAll('台东县', '臺東縣');

export async function getIpLocation(signal?: AbortSignal): Promise<IpLocation | null> {
  try {
    const response = await fetch(
      'https://ipwho.is/?lang=zh-CN&fields=success,ip,country,region,city,latitude,longitude',
      { signal, cache: 'no-store' },
    );
    if (!response.ok) return null;

    const data = await response.json() as IpWhoResponse;
    if (!data.success || !data.ip) return null;

    const locationZh = [...new Set([data.country, data.region, data.city].filter(Boolean))]
      .map((part) => toTraditionalChinese(part!))
      .join('／');

    return {
      ip: data.ip,
      locationZh: locationZh || '無法判定',
      latitude: typeof data.latitude === 'number' ? data.latitude : null,
      longitude: typeof data.longitude === 'number' ? data.longitude : null,
    };
  } catch {
    return null;
  }
}
