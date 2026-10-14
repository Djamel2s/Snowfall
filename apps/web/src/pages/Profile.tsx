import { getSession } from '../auth/session'

export default function Profile() {
  const { user: account, profile } = getSession()
  const user = {
    name: profile.name,
    preferred_username: profile.username,
    email: profile.email,
  }

  const fields = [
    ['Nom complet', user.name],
    ['Nom d’utilisateur', user.preferred_username],
    ['Adresse e-mail', user.email],
    ['Identifiant', account.userId],
  ]

  return (
    <>
      <div className="page-heading">
        <span className="section-kicker">COMPTE</span>
        <h2>Mon profil</h2>
        <p>Les informations transmises par le fournisseur d’identité à la connexion.</p>
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