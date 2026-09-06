export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new AppError(400, 'BAD_REQUEST', msg);
export const forbidden = (msg = 'Forbidden: insufficient role') => new AppError(403, 'FORBIDDEN', msg);
export const unauthorized = (msg = 'Unauthorized access') => new AppError(401, 'UNAUTHORIZED', msg);
export const notFound = (msg = 'NOT_FOUND') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg) => new AppError(409, 'CONFLICT', msg);