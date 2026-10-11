import keycloak from '../auth/keycloak'

export default function Profile() {
  const user = keycloak.tokenParsed

  const fields = [
    ['Nom complet', user?.name],
    ['Nom d’utilisateur', user?.preferred_username],
    ['Adresse e-mail', user?.email],
    ['Identifiant', user?.sub],
  ]

  return (
    <>
      <div className="page-heading">
        <span className="section-kicker">COMPTE</span>
        <h2>Mon profil</h2>
        <p>Les informations disponibles dans ta session Keycloak.</p>
      </div>

      <section className="content-card profile-card">
        <div className="profile-heading">
          <div className="profile-avatar">
            {(user?.preferred_username ?? 'U').slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h3>{user?.name ?? user?.preferred_username ?? 'Utilisateur'}</h3>
            <p>{user?.email ?? 'Aucune adresse e-mail fournie'}</p>
          </div>
        </div>

        <div className="profile-fields">
          {fields.map(([label, value]) => (
            <div className="profile-field" key={label}>
              <span>{label}</span>
              <strong>{value || 'Non renseigné'}</strong>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}