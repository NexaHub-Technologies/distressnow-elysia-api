import { Elysia } from "elysia";
import { fail } from "../utils/response";

/**
 * Throw with an HTTP status from any module:
 *   throw new HttpError(404, "Store not found.");
 *   throw new HttpError(422, "Validation failed.", fieldErrors);
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors: unknown = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Convenience shortcuts. */
export const notFound = (message = "Resource not found.") =>
  new HttpError(404, message);
export const forbidden = (message = "Forbidden.") => new HttpError(403, message);
export const unauthorized = (message = "Unauthenticated.") =>
  new HttpError(401, message);
export const unprocessable = (message: string, errors: unknown = null) =>
  new HttpError(422, message, errors);
export const conflict = (message: string) => new HttpError(409, message);

/**
 * Global error map — every response uses the
 * { success, message, data, errors } envelope.
 * - Elysia VALIDATION            -> 422
 * - Elysia NOT_FOUND             -> 404
 * - HttpError                    -> its status
 * - Anything else                -> 500 (message hidden in production)
 */
export const errorsPlugin = new Elysia({ name: "errors" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.errors);
    }

    switch (code) {
      case "VALIDATION": {
        set.status = 422;
        const details =
          error instanceof Error && "validator" in (error as object)
            ? (error as { validator?: unknown }).validator
            : String(error);
        return fail("Validation failed.", details);
      }
      case "NOT_FOUND":
        set.status = 404;
        return fail("Route not found.");
      default: {
        set.status = 500;
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.error(error);
        }
        const message =
          process.env.NODE_ENV === "production"
            ? "Internal server error."
            : error instanceof Error
              ? error.message
              : "Internal server error.";
        return fail(message);
      }
    }
  },
);
