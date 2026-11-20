# Espace Documents — version PHP

Cette version du drive s'installe sur **n'importe quel hébergement PHP** : mutualisé (OVH, o2switch, Hostinger, IONOS, Infomaniak…), VPS avec Apache ou Nginx, ou serveur local (XAMPP, WAMP, Laragon).
Il n'y a rien à compiler : ni Composer, ni Node.js, ni Docker. Les données sont stockées dans une base SQLite et des fichiers, à l'intérieur du dossier `data/`.

## Prérequis

| | Requis | Conseillé |
|---|---|---|
| PHP | **8.1 ou plus récent** | 8.2 / 8.3 en PHP-FPM |
| Extensions | `pdo_sqlite`, `mbstring` | `zip` (téléchargement en zip, extraction, recherche dans les fichiers Office), `curl` (OnlyOffice), `fileinfo` |
| Serveur web | Apache avec `.htaccess` (`mod_rewrite`) **ou** Nginx | LiteSpeed fonctionne comme Apache |
| SQLite | 3.24+ | Avec FTS5 (présent presque partout) pour la recherche plein texte |

Pour voir ce que propose votre hébergeur, créez un fichier `info.php` contenant `<?php phpinfo();`, ouvrez-le dans le navigateur, puis supprimez-le.

## Installation

1. **Copiez** le contenu de ce dossier `php/` sur votre hébergement (par FTP ou en SSH), à la racine du site ou dans un sous-dossier (`https://exemple.fr/drive/`). Le sous-dossier est géré automatiquement.
2. **Droits d'écriture** : le dossier `data/` doit être accessible en écriture par PHP (souvent automatique en mutualisé, sinon `chmod 775 data`).
3. **Ouvrez l'adresse** dans le navigateur. Le premier compte créé devient **administrateur**.
4. Dans **Administration → Paramètres**, réglez le nom de l'application, le quota par défaut et, si vous en avez un, le serveur OnlyOffice.

C'est tout. La base de données, le secret de chiffrement et les protections du dossier `data/` se créent au premier lancement.

### Fichiers à ne pas oublier

- `.htaccess` est un fichier caché : vérifiez que votre client FTP l'envoie bien (dans FileZilla : *Serveur → Forcer l'affichage des fichiers cachés*).
- `.user.ini` augmente les limites d'envoi de PHP sur les hébergements en PHP-FPM.

### Configuration avancée (facultatif)

Copiez `config.sample.php` en `config.php` pour :
- placer les données **hors du dossier web** (`data_dir`), ce qui est recommandé quand c'est possible ;
- forcer l'adresse publique (`app_url`) derrière un proxy ou un CDN ;
- créer automatiquement un compte administrateur (`admin_email`, `admin_password`) ;
- prérégler OnlyOffice.

Les réglages faits dans l'interface d'administration ont priorité sur `config.php`.

## Nginx

Les fichiers `.htaccess` sont ignorés par Nginx. Utilisez la configuration fournie dans [`nginx.conf.example`](nginx.conf.example). Elle bloque l'accès aux dossiers `app/`, `data/` et `templates/`, sert l'interface et envoie le reste à `index.php`.

## OnlyOffice Docs (édition en ligne)

Il faut un serveur **OnlyOffice Docs** (Community Edition, gratuite), installé ailleurs, par exemple en Docker sur un VPS :

```bash
docker run -d -p 8080:80 --restart=always -e JWT_SECRET=un_secret_long onlyoffice/documentserver
```

Ensuite, dans **Administration → Paramètres** :
- **Adresse du serveur OnlyOffice** : par exemple `https://office.exemple.fr`
- **Secret JWT** : le même que `JWT_SECRET`

Points importants :
- Le serveur OnlyOffice doit pouvoir **joindre votre drive** (adresses `…/oo/file/…` et `…/oo/callback/…`). Avec un drive public en HTTPS, c'est automatique. Un drive en local (`localhost`) n'est pas joignable par un OnlyOffice distant.
- Si le drive est en HTTPS, OnlyOffice doit l'être aussi : les navigateurs bloquent le contenu mixte.
- Chaque enregistrement crée une nouvelle **version** du fichier.

## WebDAV (lecteur réseau)

L'adresse est `https://votre-site/dav/` (ou `https://exemple.fr/drive/dav/` dans un sous-dossier).
- **Identifiant** : l'adresse e-mail du compte
- **Mot de passe** : un **mot de passe d'application**, à créer dans *Mon compte → Accès WebDAV*. Il est obligatoire si la double authentification est activée.

| Système | Procédure |
|---|---|
| Windows | Explorateur, clic droit sur *Ce PC*, puis *Connecter un lecteur réseau* et coller l'adresse |
| macOS | Finder, puis *Aller* → *Se connecter au serveur* (⌘K) |
| Linux | Gestionnaire de fichiers, puis `davs://votre-site/dav/` |
| Android / iOS | OnlyOffice Documents → *Stockages* → *WebDAV* |

Le dossier contient trois sous-dossiers : `Mon espace`, `Équipes` et `Partagés avec moi`.

> Par défaut, Windows limite les fichiers à 50 Mo en WebDAV. Pour lever cette limite, passez la valeur de registre `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\FileSizeLimitInBytes` à `4294967295`, puis redémarrez le service *WebClient*.

## Fonctionnement propre à la version PHP

- **Gros fichiers** : l'interface les découpe automatiquement en morceaux, d'une taille calculée d'après `upload_max_filesize` et `post_max_size`. On peut donc envoyer des fichiers de plusieurs Go même si l'hébergeur limite chaque envoi à 8 Mo. La seule limite est le quota (et l'espace disque).
- **Recherche dans le contenu** : le texte des fichiers est extrait après l'envoi de la réponse, en arrière-plan avec PHP-FPM ou LiteSpeed, sinon par petites quantités à chaque requête. Les PDF sont lus par un extracteur intégré. Les PDF scannés (images) ne contiennent pas de texte et ne sont pas indexés.
- **Tâches de maintenance** : vidage de la corbeille après N jours, nettoyage des fichiers temporaires et des liens expirés. Elles se déclenchent d'elles-mêmes lors des visites, sans tâche cron.
- **Sans l'extension `zip`** : le téléchargement de dossiers, l'extraction des archives et la recherche dans les fichiers Office ne sont pas disponibles. Le reste fonctionne.

## Mise à jour

1. Faites une sauvegarde (voir ci-dessous).
2. Remplacez tous les fichiers **sauf** `data/` et `config.php`.
3. Rechargez la page : la base est mise à jour automatiquement.

## Sauvegarde

Tout est dans le dossier `data/` (ou celui indiqué par `data_dir`) :
- `drive.db` (avec `drive.db-wal` et `drive.db-shm`) : la base SQLite (comptes, arborescence, partages…)
- `files/` : le contenu des fichiers
- `versions/` : les anciennes versions
- `secret.php` : le secret de signature. Gardez-le : sans lui, les sessions et les liens en cours deviennent invalides.

Pour une copie cohérente, copiez le dossier pendant une période calme, ou faites `sqlite3 drive.db ".backup sauvegarde.db"`.

## Dépannage

| Problème | Solution |
|---|---|
| Page blanche ou erreur 500 | Vérifiez la version de PHP (8.1+) et les extensions `pdo_sqlite` et `mbstring`. Consultez les journaux d'erreurs de l'hébergement. |
| « Le dossier de données n'est pas accessible en écriture » | `chmod 775 data` (ou 777 si l'hébergeur l'exige), ou indiquez un autre `data_dir` |
| Erreurs 404 sur `/api/…` ou `/login` | La réécriture d'URL n'est pas active : `.htaccess` est absent, `AllowOverride` est désactivé, ou c'est un serveur Nginx sans la configuration fournie |
| WebDAV demande sans cesse le mot de passe | L'en-tête `Authorization` n'est pas transmis à PHP : vérifiez que `.htaccess` est présent (règle `HTTP_AUTHORIZATION`) ou ajoutez `fastcgi_param HTTP_AUTHORIZATION` sous Nginx |
| OnlyOffice : « Le serveur OnlyOffice ne répond pas » | Vérifiez l'adresse dans Paramètres, et que le serveur est en HTTPS si le drive l'est |
| OnlyOffice : le document ne s'enregistre pas | Le secret JWT est différent, ou OnlyOffice ne joint pas le drive (pare-feu, adresse locale) |
| La recherche ne trouve pas le contenu | L'indexation est en cours (gros volume) ou le fichier est un PDF scanné |

## Structure

```
php/
├── index.php            Point d'entrée unique
├── .htaccess            Réécriture d'URL et protections (Apache / LiteSpeed)
├── .user.ini            Limites PHP (hébergements en PHP-FPM)
├── config.sample.php    Configuration facultative
├── nginx.conf.example   Configuration Nginx
├── app/                 Code serveur (API, WebDAV, OnlyOffice, recherche, 2FA)
├── public/              Interface (identique à la version Node.js)
├── templates/           Modèles vides Word, Excel et PowerPoint
└── data/                Données (créé et protégé automatiquement)
```
