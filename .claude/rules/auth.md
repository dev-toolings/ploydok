# Auth — invariants

Ploydok prend en charge le mot de passe administrateur et les passkeys
(WebAuthn). Le premier administrateur et les comptes créés depuis une
invitation définissent un mot de passe ; une passkey peut ensuite être ajoutée
depuis les réglages de sécurité. Les mots de passe sont hachés côté serveur et
ne doivent jamais être stockés ou journalisés en clair.

## Cookies

| Cookie            | TTL    | Flags                                        |
| ----------------- | ------ | -------------------------------------------- |
| `ploydok_access`  | 10 min | `HttpOnly; SameSite=Lax; Secure` (prod only) |
| `ploydok_refresh` | 7 j    | `HttpOnly; SameSite=Lax; Secure` (prod only) |
| `ploydok_setup`   | 30 min | `HttpOnly; SameSite=Lax; Secure` (prod only) |

- `Secure` **uniquement** en prod (`NODE_ENV=prod`). En dev (http://localhost), `Secure` casse les cookies.
- `SameSite=Lax` (pas Strict — TanStack SSR a besoin de forwarder les cookies sur les navigations initiales).

## Setup session (`ploydok_setup`)

`/setup` doit s'ouvrir nu, sans `?token=`. `POST /auth/setup/session` dépose le
token first-boot dans un cookie `HttpOnly`, que `/auth/setup/password` et
`/auth/setup/options` acceptent en repli du token du corps.

Invariants — les trois se tiennent, n'en retirer aucun :

- **Par défaut, pas de jeton.** `/setup` affiche le formulaire tant qu'aucun
  admin n'existe. Le premier visiteur qui l'envoie devient administrateur
  (même parcours que Coolify, Dokploy et OpenShip). `PLOYDOK_SETUP_TOKEN_REQUIRED=1`
  rétablit le verrou : le cookie `ploydok_setup` n'est alors déposé que hors
  prod (`setupSessionGrantAllowed()`, `NODE_ENV !== "prod"`), et en prod le
  jeton reste à présenter dans l'URL.
- **`/auth/setup/session` n'est PAS exempté de CSRF**, contrairement aux autres
  `/auth/setup/*`. C'est ce qui empêche une page tierce de faire émettre le
  cookie. Une régression ici est couverte par `apps/api/src/csrf.test.ts`.
- **Origin vérifiée** dès que le token vient du cookie : sans double-submit sur
  `/auth/setup/password`, seule l'origine distingue le wizard d'un POST
  cross-site. `Origin` absent = appel serveur (SSR, tests), jamais un navigateur.

Le cookie est effacé sur bootstrap réussi et sur `ALREADY_BOOTSTRAPPED`.

### Validation du wizard

`SetupAdminBodySchema` (`packages/shared/src/auth.ts`) est la **source unique**
de la politique du premier admin : le navigateur valide avec lui avant d'appeler
`POST /auth/setup/password`, et la route le rejoue côté serveur.
`validateAdminPassword` (`apps/api/src/auth/password.ts`) délègue au même
`AdminPasswordSchema` — deux bornes divergentes donneraient un formulaire vert
et un 400 au submit.

- La borne haute du mot de passe est en **octets UTF-8**, pas en caractères :
  bcrypt tronque silencieusement au-delà de 72 octets.
- Les erreurs remontent via `fieldErrors` / `firstErrorMessage`
  (`packages/shared/src/validation.ts`) dans
  `{ error: { code: "VALIDATION_ERROR", message, fields } }`. `ApiError` porte
  `fields` côté web pour annoter le champ fautif.
- Les formulaires d'auth sont en `noValidate` : la bulle native est localisée
  par le navigateur et se déclenche avant le submit, ce qui court-circuiterait
  les messages Zod.

## JWT

- Access token signé par `SESSION_SECRET` (≥ 32 bytes, obligatoire en prod, auto-généré en dev si absent).
- Refresh rotatif : chaque usage émet un nouveau refresh et révoque l'ancien (anti-replay).
- Révoquer ≠ supprimer : table `sessions` marque `revoked_at`.

## CSRF

- Toutes les mutations (non-GET/HEAD/OPTIONS) exigent le header `X-CSRF-Token` qui matche le cookie CSRF.
- **Exceptions bornées** : `POST /auth/refresh` repose sur le refresh cookie
  `HttpOnly`; `POST /webhooks/stripe` repose sur la signature Stripe du corps
  brut. Toute nouvelle exception doit être exacte sur la méthode et le chemin
  et disposer d'un test full-app.
- Origin check strict : `Origin` doit matcher `WEB_ORIGIN`.

## Front — `apiFetch`

- `apps/web/src/lib/api.ts` : auto-retry 1× sur 401 via `POST /auth/refresh`, puis ré-exécute la requête.
- SSR (`beforeLoad`, loaders) : `apiFetch` forward automatiquement le header `cookie` (lu via `getCookies()` de `@tanstack/react-start/server`, chargé en dynamic import gated par `typeof window`). Les rotations (Set-Cookie émises pendant le SSR, ex: refresh) sont persistées per-request via WeakMap<Request, overrides> — le retry in-flight voit les nouveaux cookies. **Ne pas** créer de fichier `.server.ts` séparé pour ça : le plugin `import-protection` de TanStack Start bloque les imports (statiques ET dynamiques) de `**/*.server.*` depuis le graphe client.
- Les GET identiques peuvent être dédupliqués pendant leur requête en vol. Le
  cache client est vidé après résolution et ne doit jamais partager une
  identité entre deux requêtes SSR.

## Front — guards de routes (layouts pathless)

L'auth est **centralisée dans deux layouts** (voir `.claude/rules/monorepo.md` § Routes) :

- `apps/web/src/routes/_authed.tsx` : `beforeLoad: async () => ({ me: await requireMe() })`. Toutes les routes authed vivent sous `_authed/...` et héritent du contexte `{ me }` via `Route.useRouteContext()`.
- `apps/web/src/routes/_public.tsx` : `beforeLoad: async () => { await redirectIfAuthenticated() }`. Routes publiques sous `_public/...` — un user loggé est bounce vers `/dashboard`.

Les helpers `requireMe()` et `redirectIfAuthenticated()` vivent dans `apps/web/src/lib/auth-guards.ts`. **Ne JAMAIS** les dupliquer dans une route enfant — le layout parent s'en charge.

## Backup codes and recovery

- Générés côté serveur, **bcrypt hashés** (cost ≥ 10), one-shot (marqués `consumed_at`).
- Le sous-commande Rust historique `admin-recovery` cible encore un fichier
  SQLite et n'est pas une procédure de récupération PostgreSQL supportée en
  production. Ne pas le présenter à un opérateur comme filet de secours ; une
  procédure PostgreSQL auditée doit être livrée avant d'en faire un runbook.

## Ne jamais

- Logger un cookie, un JWT, ou un backup code (même tronqué).
- Commiter `apps/api/.env.local`.
- Raccourcir les TTL sans migrer les sessions actives.
- Changer `SameSite` sans vérifier le flow SSR.
