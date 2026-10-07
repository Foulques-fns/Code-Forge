# CodeForge — version HTML / GitHub Pages

Cette version fonctionne comme un site statique : aucun serveur Node.js, aucune base PostgreSQL et aucune variable d'environnement ne sont nécessaires pour les fonctions principales.

## Fonctionnalités
- génération locale d'un vrai mini-projet HTML/CSS/JS à partir d'une description ;
- sauvegarde des projets avec `localStorage` ;
- éditeur de fichiers ;
- prévisualisation réelle dans une iframe ;
- création de nouveaux fichiers ;
- import de ZIP ;
- export d'un ZIP ;
- compatibilité GitHub Pages ;
- détection facultative d'un Ollama local (`127.0.0.1:11434`) pour générer du code avec un modèle local.

## GitHub Pages
Le fichier `index.html` est à la racine. Envoyez tout le contenu de ce dossier dans votre dépôt, puis activez GitHub Pages dans **Settings → Pages → Deploy from branch**.

Le dossier `original/` contient le projet Next.js original et n'est pas utilisé par la version statique.
