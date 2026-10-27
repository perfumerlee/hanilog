export type TimezoneOption = { value: string; label: string };

const knownLabels: Record<string, string> = {
  'Asia/Seoul': '대한민국',
  'Asia/Tokyo': '일본, 도쿄',
  'Asia/Singapore': '싱가포르',
  'Asia/Bangkok': '태국, 방콕',
  'Asia/Shanghai': '중국, 상하이',
  'Asia/Hong_Kong': '홍콩',
  'Asia/Taipei': '대만 (타이베이)',
  'Asia/Kolkata': '인도, 콜카타',
  'Europe/London': '영국, 런던',
  'Europe/Paris': '프랑스, 파리',
  'Europe/Berlin': '독일, 베를린',
  'America/Los_Angeles': '미국, 로스앤젤레스',
  'America/Denver': '미국 (덴버)',
  'America/Chicago': '미국 (시카고)',
  'America/New_York': '미국, 뉴욕',
  'Australia/Sydney': '호주, 시드니',
  'Pacific/Auckland': '뉴질랜드, 오클랜드',
  'UTC': 'UTC',
};

export const commonTimezoneOptions: TimezoneOption[] = Object.entries(knownLabels)
  .map(([value, label]) => ({ value, label }));

export function detectBrowserTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
      return timezone;
    }
  } catch {
    // An unavailable browser time zone must remain unset instead of guessing.
  }
  return '';
}

export function formatTimezoneLabel(timezone: string): string {
  if (!timezone) return '시간대를 선택해 주세요';
  try {
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value;
    const normalizedOffset = offset === 'GMT' ? 'UTC+00:00' : offset?.replace(/^GMT/, 'UTC');
    const place = knownLabels[timezone] ?? timezone;
    if (timezone === 'Asia/Seoul') return `${place} (서울, ${normalizedOffset ?? 'UTC offset unavailable'})`;
    return `${place} (${normalizedOffset ?? 'UTC offset unavailable'})`;
  } catch {
    return timezone;
  }
}

export function timezoneOptionsFor(detectedTimezone: string): TimezoneOption[] {
  if (!detectedTimezone || commonTimezoneOptions.some((option) => option.value === detectedTimezone)) {
    return commonTimezoneOptions;
  }
  return [
    { value: detectedTimezone, label: formatTimezoneLabel(detectedTimezone) },
    ...commonTimezoneOptions,
  ];
}
