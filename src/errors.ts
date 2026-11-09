export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 426 | 429 | 500 | 502 | 503;

/** An error with the status and message the API returns. */
export class HttpError extends Error {
  constructor(
    readonly status: HttpStatus,
    message: string,
  ) {
    super(message);
  }
}
