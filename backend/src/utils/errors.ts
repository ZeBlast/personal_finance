/** An error whose message is safe to show to the user and which maps to an HTTP status. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string): AppError =>
  new AppError(404, "not_found", `${what} was not found`);
