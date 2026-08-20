import type { NextFunction, Request, Response } from "express"
import { ZodError } from "zod"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError) {
    response
      .status(400)
      .json({
        error: "Some request fields are invalid.",
        code: "INVALID_INPUT",
        details: error.issues,
      })
    return
  }
  if (error instanceof ApiError) {
    response
      .status(error.status)
      .json({ error: error.message, code: error.code, details: error.details })
    return
  }
  console.error(error)
  response
    .status(500)
    .json({
      error: "FirstFrame hit an unexpected server error.",
      code: "INTERNAL_ERROR",
    })
}

export function notFound(_request: Request, response: Response) {
  response
    .status(404)
    .json({
      error: "That FirstFrame endpoint does not exist.",
      code: "NOT_FOUND",
    })
}
