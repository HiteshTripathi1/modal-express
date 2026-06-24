import type { ErrorRequestHandler } from 'express';

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

/** Make an Error carrying an HTTP status. Throw it (or pass to next()). */
export function httpError(status: number, message: string | string[]) {
  const err = new Error(Array.isArray(message) ? message.join(', ') : message) as Error & {
    status: number;
    payload: string | string[];
  };
  err.status = status;
  err.payload = message;
  return err;
}

/** Last middleware: turn any error into `{ message, error, statusCode }`. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status: number = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    message: err.payload ?? err.message ?? 'Internal server error',
    error: REASONS[status] ?? 'Error',
    statusCode: status,
  });
};
