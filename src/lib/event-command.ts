export type EventType = 'meal' | 'insulin' | 'glucose' | 'elimination' | 'exercise' | 'water' | 'weight' | 'symptom';

export interface HealthEventCommand {
  petId: string;
  eventType: EventType;
  occurredAt: string;
  occurrenceId: string | null;
  value: Record<string, unknown>;
  unit: string | null;
  clientTimezone: string;
  performerId: string | null;
  idempotencyKey: string;
}

export function createHealthEventCommand(input: Omit<HealthEventCommand, 'idempotencyKey'>): HealthEventCommand {
  return { ...input, idempotencyKey: crypto.randomUUID() };
}

export function retryOrCreateHealthEventCommand(
  input: Omit<HealthEventCommand, 'idempotencyKey'>,
  pending: HealthEventCommand | null,
): HealthEventCommand {
  if (!pending) return createHealthEventCommand(input);
  const pendingInput = { ...pending, idempotencyKey: undefined };
  return JSON.stringify(pendingInput) === JSON.stringify(input) ? pending : createHealthEventCommand(input);
}

export function safetyStatusLabel(status: string): string {
  switch (status) {
    case 'CURRENT': return '현재 서버 기록을 확인했습니다';
    case 'STALE': return '기록 변경으로 다시 확인이 필요합니다';
    case 'NOT_APPLICABLE': return '확인할 일정 슬롯이 없습니다';
    case 'UNAVAILABLE': return '서버에 연결할 수 없어 최신 상태를 확인하지 못했습니다';
    default: return '안전 상태를 확인하지 못했습니다';
  }
}

export function safetyResultLabel(code: string): string {
  switch (code) {
    case 'DUPLICATE_POSSIBLE': return '같은 일정에 투여 기록이 있어 중복 가능성이 표시되었습니다. 실제 발생 기록은 저장했습니다.';
    case 'MEAL_UNCONFIRMED': return '이 일정에 연결된 식사 기록을 확인하지 못했습니다. 실제 미실시를 뜻하지 않습니다.';
    case 'PLAN_UNVERIFIED': return '연결된 계획의 의료진 승인 상태를 확인하지 못했습니다.';
    case 'PRECONDITION_UNCONFIRMED': return '선행 단계 기록을 확인하지 못했습니다. 실제 미실시를 뜻하지 않습니다.';
    case 'ROUTINE_ORDER_UNCONFIRMED': return '개인 관리 일정에서 앞선 단계의 기록을 확인하지 못했습니다. 실제 미실시나 임상적 선행 조건을 뜻하지 않습니다.';
    case 'CLINICIAN_GUIDANCE_UNAVAILABLE': return '등록된 의료진 승인 대응 지침이 없습니다.';
    case 'MEAL_EXCEPTION_REPORTED': return '식사 예외가 기록되어 있습니다. 앱은 임상적 섭취 기준을 판단하지 않습니다.';
    default: return '기록 간 확인이 필요한 상태가 있습니다.';
  }
}

export function eventSubmissionFailure(code?: string): { kind: 'error' | 'unverified'; text: string } {
  if (code === '42501' || code === 'PGRST301') return {
    kind: 'error',
    text: '현재 Pet 접근권한이 확인되지 않아 서버에 기록하지 않았습니다. 선택된 Pet을 새로 확인해 주세요.',
  };
  if (code === '23505') return {
    kind: 'error',
    text: '같은 요청 키에 다른 입력이 연결되어 서버가 거부했습니다. 내용을 확인한 뒤 새 요청으로 다시 시도해 주세요.',
  };
  return {
    kind: 'unverified',
    text: 'UNVERIFIED · 서버 확인이 끝나지 않았습니다. 입력을 유지합니다. 같은 내용으로 재시도하면 같은 멱등 키를 사용합니다.',
  };
}

export function petAccessRefreshLabel() {
  return 'Pet 접근 범위가 변경되어 선택을 갱신했습니다.';
}
