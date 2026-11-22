# Espace Documents — version Docker / Node.js

Cette version du drive tourne en conteneur Docker : Node.js 20, Express et SQLite. Elle est faite pour un VPS ou un serveur dédié, géré en ligne de commande ou avec **Portainer**.
Pour un hébergement PHP classique, utilisez plutôt la [version PHP](../php/).

## Prérequis

- Docker 20+ (avec Compose), ou Node.js 20+ pour lancer le drive sans Docker
- Un nom de domaine et un reverse proxy HTTPS (Nginx Proxy Manager, Traefik, Caddy, Nginx…)
- Facultatif : un serveur **OnlyOffice Docs** pour l'édition en ligne

## Image prête à l'emploi (recommandé)

À chaque modification du dossier `node/` sur la branche `main`, une image est construite automatiquement par GitHub Actions et publiée pour **amd64 et arm64** (PC, serveur, Raspberry Pi) :

```
ghcr.io/ticeconnect-dev/drive-ticeconnect:latest
```

Les étiquettes disponibles sont `latest` (dernière version de `main`), `x.y.z` et `x.y` (versions publiées avec un tag `vx.y.z`) et `sha-xxxxxxx` (un commit précis).

### Avec Portainer
1. Allez dans **Stacks**, puis **Add stack**, puis **Web editor**, et collez le fichier [`docker-compose.yml`](docker-compose.yml).
2. Renseignez les variables dans **Environment variables** (voir plus bas).
3. Cliquez sur **Deploy the stack**.

**Mettre à jour** : ouvrez la stack, cliquez sur **Update the stack** et cochez **Re-pull image and redeploy**. Les données ne bougent pas : elles sont dans le volume `drive_data`.

### En ligne de commande
```bash
cd node
cp .env.example .env          # puis modifiez les valeurs
docker compose pull && docker compose up -d
```

## Construire l'image soi-même

### En ligne de commande

```bash
cd node
docker build -t espace-documents:latest .
```
Dans `docker-compose.yml`, remplacez alors la ligne `image:` par `build: .` (ou par `image: espace-documents:latest`).

Le drive écoute sur le port `8290` de l'hôte (variable `HOST_PORT`). Faites pointer votre reverse proxy dessus, avec HTTPS.

### Avec Portainer

#### 1. Construire l'image
Allez dans **Images**, puis **Build a new image** :
- **Name** : `espace-documents:latest`
- **Build method** :
  - *Upload* : envoyez une archive `.tar.gz` du dossier `node/`, avec le `Dockerfile` à la racine de l'archive :
    ```bash
    cd node && tar --exclude=node_modules -czf ../espace-documents-build.tar.gz .
    ```
  - ou *URL* : l'adresse de votre dépôt Git, avec `node` comme dossier de contexte
- Cliquez sur **Build the image**.

#### 2. Créer la stack
Allez dans **Stacks**, puis **Add stack**, puis **Web editor** :

```yaml
services:
  drive:
    image: espace-documents:latest
    container_name: espace-documents
    restart: unless-stopped
    ports:
      - "8290:3000"
    environment:
      APP_URL: https://drive.exemple.fr
      ONLYOFFICE_URL: ${ONLYOFFICE_URL}
      ONLYOFFICE_JWT_SECRET: ${ONLYOFFICE_JWT_SECRET}
      SECRET: ${SECRET}
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
    volumes:
      - drive_data:/data

volumes:
  drive_data:
```

Renseignez les variables dans **Environment variables**, puis cliquez sur **Deploy the stack**.

#### Mettre à jour
Reconstruisez l'image sous le même nom (`espace-documents:latest`), puis, dans la stack, cliquez sur **Update the stack**. Les données ne bougent pas : elles sont dans le volume `drive_data`.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | **Adresse publique** du drive (liens de partage, WebDAV, OnlyOffice) |
| `SECRET` | généré dans `/data/.secret` | Secret de signature des sessions. Ne le changez plus une fois en service. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Compte administrateur créé au démarrage s'il n'existe pas (sinon, le premier inscrit devient admin) |
| `APP_NAME` | `Espace Documents` | Nom affiché |
| `ONLYOFFICE_URL` | — | Adresse du serveur OnlyOffice Docs. Laisser vide pour le désactiver. |
| `ONLYOFFICE_JWT_SECRET` | — | Secret JWT d'OnlyOffice |
| `APP_INTERNAL_URL` | — | Adresse du drive vue depuis OnlyOffice, si elle diffère de `APP_URL` |
| `DEFAULT_QUOTA` | `10G` | Quota des nouveaux comptes (`0` = illimité) |
| `MAX_UPLOAD` | `4G` | Taille maximale d'un fichier |
| `MAX_VERSIONS` | `20` | Nombre de versions conservées par fichier |
| `TRASH_DAYS` | `30` | Durée de conservation dans la corbeille |
| `ALLOW_SIGNUP` | `false` | Inscriptions libres (modifiable aussi dans l'administration) |
| `PORT` / `DATA_DIR` | `3000` / `/data` | Port interne et dossier des données |

## OnlyOffice Docs

- Utilisez la même adresse et le même secret JWT que votre serveur OnlyOffice. Pour récupérer ce secret :
  ```bash
  docker exec <conteneur_onlyoffice> /var/www/onlyoffice/documentserver/npm/json -f /etc/onlyoffice/documentserver/local.json 'services.CoAuthoring.secret.session.string'
  ```
- OnlyOffice télécharge les fichiers depuis `APP_URL/oo/file/…` et renvoie les modifications vers `APP_URL/oo/callback/…` : ces adresses doivent être **joignables depuis le conteneur OnlyOffice**.
- Avec `APP_INTERNAL_URL` (par ex. `http://espace-documents:3000` sur un réseau Docker commun), ajoutez `ALLOW_PRIVATE_IP_ADDRESS=true` au conteneur OnlyOffice, qui refuse par défaut les adresses privées.
- Chaque enregistrement crée une nouvelle **version** du fichier.

## Reverse proxy

- Augmentez la taille maximale des envois (Nginx : `client_max_body_size 4G;`, dans Nginx Proxy Manager : onglet *Advanced*).
- Pour **WebDAV**, le proxy doit laisser passer les méthodes `PROPFIND`, `MKCOL`, `MOVE`, `COPY`, `LOCK`… et les en-têtes `Destination`, `Depth`, `Overwrite`. C'est le cas par défaut avec Nginx Proxy Manager et Traefik.

## WebDAV

L'adresse est `https://drive.exemple.fr/dav/`. L'identifiant est l'adresse e-mail du compte, et le mot de passe un **mot de passe d'application** (*Mon compte → Accès WebDAV*).

- **Windows** : clic droit sur *Ce PC*, puis *Connecter un lecteur réseau*. La limite de 50 Mo se lève avec la valeur de registre `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes` = `4294967295`, suivie d'un redémarrage du service *WebClient*.
- **macOS** : Finder, puis *Se connecter au serveur* (⌘K).
- **Linux** : `davs://drive.exemple.fr/dav/`
- **Android / iOS** : OnlyOffice Documents → *Stockages* → *WebDAV*

## Sauvegarde

Tout est dans le volume monté sur `/data` :
- `drive.db*` : la base SQLite
- `files/` : le contenu des fichiers
- `versions/` : les anciennes versions
- `.secret` : le secret de signature

```bash
docker run --rm -v drive_data:/data -v "$PWD":/backup alpine tar czf /backup/drive-$(date +%F).tar.gz -C /data .
```

## Développement local

```bash
cd node
npm install
APP_URL=http://localhost:3000 npm start
```

Sans `ONLYOFFICE_URL`, le drive fonctionne quand même, sans l'édition Office.

## Structure

```
node/
├── Dockerfile, docker-compose.yml, .env.example
├── server/
│   ├── index.js       API, authentification, partage, OnlyOffice, administration
│   ├── dav.js         Serveur WebDAV
│   ├── db.js          Schéma SQLite
│   ├── textindex.js   Recherche plein texte (Office, OpenDocument, PDF)
│   └── totp.js        Double authentification
├── public/            Interface (identique à la version PHP)
└── templates/         Modèles vides Word, Excel et PowerPoint
```

## Raccourcis clavier

`/` ou `Ctrl+K` : rechercher · `Ctrl+A` : tout sélectionner · `Suppr` : corbeille · `F2` : renommer · `I` : détails · `Ctrl+X` puis `Ctrl+V` : déplacer · `Retour arrière` : dossier parent · `Échap` : annuler
