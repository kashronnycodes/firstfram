import { createHmac, randomBytes } from "node:crypto"
import type { NextFunction, Request, Response } from "express"

export const GUEST_COOKIE = "ff_guest"

export interface GuestRequest extends Request {
  guestSessionId: string
}

export function hashOpaqueValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex")
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value)
}

export function guestSession(secret: string, secureCookies: boolean) {
  return (request: Request, response: Response, next: NextFunction) => {
    let token = request.cookies?.[GUEST_COOKIE]
    if (!validToken(token)) {
      token = randomBytes(32).toString("base64url")
      response.cookie(GUEST_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookies,
        maxAge: 30 * 24 * 60 * 60 * 1_000,
        path: "/",
      })
    }
    ;(request as GuestRequest).guestSessionId = hashOpaqueValue(token, secret)
    next()
  }
}

export function requestIpHash(request: Request, secret: string): string {
  return hashOpaqueValue(
    request.ip || request.socket.remoteAddress || "unknown",
    secret,
  )
}
