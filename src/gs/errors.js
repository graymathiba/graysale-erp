class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.name = 'AppError';
  }
}

const badRequest = (msg = 'Bad request') => new AppError(msg, 400);
const unauthorized = (msg = 'Unauthorized') => new AppError(msg, 401);
const forbidden = (msg = 'Forbidden') => new AppError(msg, 403);
const notFound = (msg = 'Not found') => new AppError(msg, 404);
const conflict = (msg = 'Conflict') => new AppError(msg, 409);

export {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};