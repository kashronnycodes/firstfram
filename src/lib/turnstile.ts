type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      "error-callback": () => void
      "expired-callback": () => void
      theme: "dark"
    },
  ): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<void> | undefined

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  const current = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error("Verification could not be loaded."))
    document.head.appendChild(script)
  })
  scriptPromise = current
  void current.catch(() => {
    if (scriptPromise === current) scriptPromise = undefined
  })
  return current
}

export async function requestTurnstileToken(siteKey: string): Promise<string> {
  await loadTurnstile()
  if (!window.turnstile)
    throw new Error("Verification is unavailable. Please try again later.")

  return new Promise((resolve, reject) => {
    const overlay = document.createElement("div")
    overlay.setAttribute("role", "dialog")
    overlay.setAttribute("aria-label", "Fallback usage verification")
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "10000",
      display: "grid",
      placeItems: "center",
      background: "rgba(5, 13, 24, .86)",
    })
    const panel = document.createElement("div")
    Object.assign(panel.style, {
      width: "min(420px, calc(100vw - 32px))",
      padding: "24px",
      border: "3px solid #2a7fc1",
      background: "#0d1b2a",
      color: "#f0e6cc",
      fontFamily: "Inter, sans-serif",
      textAlign: "center",
    })
    const copy = document.createElement("p")
    copy.textContent =
      "Please verify this higher fallback usage. Local processing never requires verification."
    const challenge = document.createElement("div")
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "CANCEL"
    Object.assign(cancel.style, {
      marginTop: "16px",
      padding: "8px 14px",
      border: "2px solid #2a7fc1",
      background: "#0f2640",
      color: "#c8b89a",
      cursor: "pointer",
    })
    panel.append(copy, challenge, cancel)
    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    let widgetId = ""
    let settled = false
    const finish = (error?: Error, token?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (widgetId) window.turnstile?.remove(widgetId)
      overlay.remove()
      error ? reject(error) : resolve(token!)
    }
    cancel.onclick = () => finish(new Error("Verification was cancelled."))
    const timer = window.setTimeout(
      () => finish(new Error("Verification timed out. Please try again.")),
      120_000,
    )
    widgetId = window.turnstile!.render(challenge, {
      sitekey: siteKey,
      theme: "dark",
      callback: (token) => finish(undefined, token),
      "error-callback": () =>
        finish(new Error("Verification failed. Please try again.")),
      "expired-callback": () =>
        finish(new Error("Verification expired. Please try again.")),
    })
  })
}
