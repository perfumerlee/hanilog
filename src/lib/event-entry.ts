import type { EventType } from './event-command';

export const GLUCOSE_UNIT = 'mg/dL';
export const GLUCOSE_MEASUREMENT_CONDITIONS = [
  { value: 'BEFORE_MEAL', label: '식사 전' },
  { value: 'AFTER_MEAL', label: '식사 후' },
  { value: 'UNRELATED_TO_MEAL', label: '식사와 무관' },
  { value: 'BEFORE_EXERCISE', label: '운동 전' },
  { value: 'AFTER_EXERCISE', label: '운동 후' },
] as const;

export function glucoseMeasurementConditionLabel(value: string | undefined): string {
  return GLUCOSE_MEASUREMENT_CONDITIONS.find((condition) => condition.value === value)?.label ?? value ?? '미기록';
}

export interface EventEntryFields {
  eventType: EventType;
  occurredLocal: string;
  note: string;
  numericValue: string;
  unit: string;
  mealStatus: string;
  eliminationType: string;
  description: string;
  measurementSource?: string;
  measurementCondition?: string;
  doseAmount?: string;
  doseUnit?: 'U' | '';
  insulinProductLabel?: string;
  activityStartedLocal?: string;
  activityEndedLocal?: string;
  activityState?: 'STARTED' | 'COMPLETED';
}

export interface ValidatedEventEntry {
  occurredAt: string;
  value: Record<string, unknown>;
  unit: string | null;
}

function parseOptionalNumber(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validateEventEntry(fields: EventEntryFields): { value?: ValidatedEventEntry; error?: string } {
  const occurred = new Date(fields.occurredLocal);
  if (!fields.occurredLocal || Number.isNaN(occurred.getTime())) return { error: '실제 발생 시각을 확인해 주세요.' };
  if (fields.note.length > 1000) return { error: '메모는 1,000자 이내로 입력해 주세요.' };

  const value: Record<string, unknown> = {};
  const note = fields.note.trim();
  if (note) value.note = note;
  let unit: string | null = fields.unit.trim() || null;

  if (fields.eventType === 'insulin') {
    const amountText = fields.doseAmount?.trim() ?? '';
    const doseUnit = fields.doseUnit ?? '';
    const amount = parseOptionalNumber(amountText);
    if (amount === null || amount === undefined || amount <= 0) return { error: '실제 투여량을 0보다 큰 U 값으로 입력해 주세요.' };
    if (doseUnit !== 'U') return { error: '투여량 단위는 U로 기록해 주세요.' };
    unit = 'U';
    value.administered_dose_value = amount;
    value.administered_dose_unit = 'U';
    const productLabel = fields.insulinProductLabel?.trim();
    if (!productLabel) return { error: '처방받은 인슐린 제품을 입력해 주세요.' };
    if (productLabel.length > 120) return { error: '인슐린 제품명은 120자 이내로 입력해 주세요.' };
    value.insulin_product_label = productLabel;
  }

  if (fields.eventType === 'glucose' || fields.eventType === 'weight') {
    const measurement = parseOptionalNumber(fields.numericValue);
    if (measurement === null || measurement === undefined) return { error: '측정값을 숫자로 입력해 주세요.' };
    if (fields.eventType === 'glucose') unit = GLUCOSE_UNIT;
    else if (!unit) return { error: '측정 단위를 입력해 주세요.' };
    value.observed_value = measurement;
    if (fields.eventType === 'glucose') {
      const source = fields.measurementSource?.trim();
      const condition = fields.measurementCondition?.trim();
      if (source) value.measurement_source = source.slice(0, 120);
      if (condition) value.measurement_condition = condition;
    }
  }

  if (fields.eventType === 'meal') {
    if (!fields.mealStatus) return { error: '관찰한 식사 상태를 선택해 주세요.' };
    value.meal_status = fields.mealStatus;
    const amount = parseOptionalNumber(fields.numericValue);
    if (amount === undefined) return { error: '섭취량은 숫자로 입력해 주세요.' };
    if (amount !== null) value.observed_value = amount;
    unit = unit ?? null;
  }

  if (fields.eventType === 'water') {
    const amount = parseOptionalNumber(fields.numericValue);
    if (amount === undefined) return { error: '음수량은 숫자로 입력해 주세요.' };
    if (amount !== null) value.observed_value = amount;
  }

  if (fields.eventType === 'elimination') {
    if (!fields.eliminationType) return { error: '관찰한 배변·배뇨 유형을 선택해 주세요.' };
    value.observation_type = fields.eliminationType;
  }

  if (fields.eventType === 'exercise') {
    const started = new Date(fields.activityStartedLocal || fields.occurredLocal);
    if (Number.isNaN(started.getTime())) return { error: '운동 및 산책 시작 시각을 확인해 주세요.' };
    value.activity_started_at = started.toISOString();
    if (fields.activityState) value.activity_state = fields.activityState;
    const endedLocal = fields.activityEndedLocal?.trim();
    if (endedLocal) {
      const ended = new Date(endedLocal);
      if (Number.isNaN(ended.getTime())) return { error: '종료 시각을 확인해 주세요.' };
      if (ended.getTime() <= started.getTime()) return { error: '종료 시각은 시작 시각보다 늦어야 합니다.' };
      value.activity_ended_at = ended.toISOString();
    }
    const minutes = parseOptionalNumber(fields.numericValue);
    if (minutes === undefined) return { error: '운동 및 산책 시간을 숫자로 입력해 주세요.' };
    if (minutes !== null) {
      value.observed_value = minutes;
      unit = '분';
    }
    if (fields.description.trim()) value.activity_description = fields.description.trim();
  }

  return {
    value: { occurredAt: occurred.toISOString(), value, unit },
  };
}

export function formatGlucoseValue(value: number | string, storedUnit: string | null): string {
  if (storedUnit === GLUCOSE_UNIT) return `${value} ${GLUCOSE_UNIT}`;
  if (!storedUnit) return `${value} · 저장 단위 확인 필요`;
  return `${value} ${storedUnit} · 기존 단위 보존 (mg/dL 변환 안 됨)`;
}
