import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadSession, login } from './auth/session'

const root = createRoot(document.getElementById('root')!)

function messageScreen(text: string, retry = false) {
  return (
    <main style={{ padding: '2rem', color: '#e6edf7', fontFamily: 'sans-serif' }}>
      <p>{text}</p>
      {retry && (
        <button type="button" onClick={login}>
          Se reconnecter
        </button>
      )}
    </main>
  )
}

async function start() {
  // Après un refus côté API, on ne relance pas la connexion automatiquement :
  // la session SSO Keycloak étant encore ouverte, cela bouclerait.
  if (new URLSearchParams(window.location.search).has('auth_error')) {
    window.history.replaceState(null, '', '/')
    root.render(
      messageScreen("Accès refusé : ce compte n'est pas autorisé sur Snowfall.", true),
    )
    return
  }

  try {
    const session = await loadSession()

    if (!session) {
      login()
      return
    }

    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch {
    root.render(messageScreen("Impossible de joindre le service d'authentification."))
  }
}

void start()
