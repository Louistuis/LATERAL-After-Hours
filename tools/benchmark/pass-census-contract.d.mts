export interface PassCensusValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validatePassCensusRecord(record: unknown): PassCensusValidation;
