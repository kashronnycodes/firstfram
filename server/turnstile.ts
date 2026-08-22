export type CaptchaVerifier = (
  token: string,
  remoteIp: string | undefined,
) => Promise<boolean>

export function createTurnstileVerifier(
  secret: string | undefined,
): CaptchaVerifier {
  return async (token, remoteIp) => {
    if (!secret) return false
    const body = new URLSearchParams({ secret, response: token })
    if (remoteIp) body.set("remoteip", remoteIp)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: controller.signal,
        },
      )
      if (!response.ok) return false
      const result = (await response.json()) as { success?: boolean }
      return result.success === true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
