export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}

export const asGatewayError = (error: unknown): GatewayError => {
  if (error instanceof GatewayError) return error;
  return new GatewayError(500, 'INTERNAL_ERROR', 'Internal gateway error');
};
