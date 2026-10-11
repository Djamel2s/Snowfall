import Keycloak from 'keycloak-js'

const keycloak = new Keycloak({
  url: 'http://localhost:8080',
  realm: 'snowfall',
  clientId: 'snowfall-web',
})

export default keycloak