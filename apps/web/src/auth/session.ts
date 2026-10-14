// La session est portée par un cookie HttpOnly posé par l'API (pattern BFF) :
// aucun jeton n'est accessible au JavaScript de la page.

export type Session = {
  user: {
    userId: string
    organizationId: string
    role: 'owner' | 'admin' | 'member' | 'reader'
  }
  profile: {
    name?: string
    email?: string
    username?: string
  }
}

let current: Session | null = null

export function getSession(): Session {
  if (!current) throw new Error('Session non chargée.')
  return current
}

export async function loadSession(): Promise<Session | null> {
  const response = await fetch('/api/auth/me', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  if (response.status === 401) return null
  if (!response.ok) throw new Error(`Erreur serveur (${response.status}).`)

  current = (await response.json()) as Session
  return current
}

export function login() {
  window.location.assign('/api/auth/login')
}

export async function logout() {
  let target = '/'

  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (response.ok) {
      const data = (await response.json()) as { logoutUrl?: string }
      if (data.logoutUrl) target = data.logoutUrl
    }
  } finally {
    current = null
    window.location.assign(target)
  }
}
