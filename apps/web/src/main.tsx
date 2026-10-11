import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import keycloak from './auth/keycloak'

const root = createRoot(document.getElementById('root')!)

async function start() {
  try {
    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    })

    if (!authenticated) {
      await keycloak.login()
      return
    }

    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch {
    root.render(
      <main style={{ padding: '2rem', color: '#e6edf7', fontFamily: 'sans-serif' }}>
        Impossible de joindre le service d'authentification.
      </main>,
    )
  }
}

void start()