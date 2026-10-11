export default function Dashboard() {

  return (
    <>
      <section className="welcome-banner">
        <div>
          <span className="section-kicker">VUE D’ENSEMBLE</span>
          <h2>Bienvenue sur Snowfall</h2>
          <p>Retrouve ici ton espace de travail et les informations essentielles.</p>
        </div>
        <div className="welcome-decoration">S</div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">Espace</span>
          <strong>Personnel</strong>
          <p>Ton environnement Snowfall</p>
        </article>
        <article className="stat-card">
          <span className="stat-label">Authentification</span>
          <strong>Keycloak</strong>
          <p>OpenID Connect · PKCE</p>
        </article>
        <article className="stat-card">
          <span className="stat-label">Statut</span>
          <strong className="status-value">Connecté</strong>
          <p>Session authentifiée</p>
        </article>
      </section>

      <section className="content-card">
        <div className="card-heading">
          <div>
            <span className="section-kicker">ACTIVITÉ</span>
            <h3>Ton espace de travail</h3>
          </div>
          <span className="status-pill">Opérationnel</span>
        </div>
        <p>
          L’authentification est active. Les prochaines fonctionnalités
          pourront être intégrées ici sans modifier le socle de sécurité.
        </p>
      </section>
    </>
  )
}