export default function Settings() {
  return (
    <>
      <div className="page-heading">
        <span className="section-kicker">PRÉFÉRENCES</span>
        <h2>Paramètres</h2>
        <p>Les informations et options de ton espace Snowfall.</p>
      </div>

      <section className="content-card settings-section">
        <div>
          <h3>Sécurité du compte</h3>
          <p>
            La connexion est gérée par Keycloak. Les identifiants et les
            politiques de sécurité sont administrés par le fournisseur
            d’identité.
          </p>
        </div>
        <span className="status-pill">Géré par Keycloak</span>
      </section>

      <section className="content-card settings-section">
        <div>
          <h3>Session</h3>
          <p>
            Ton espace utilise OpenID Connect avec PKCE S256 pour
            l’authentification.
          </p>
        </div>
        <span className="status-pill">Sécurisé</span>
      </section>
    </>
  )
}