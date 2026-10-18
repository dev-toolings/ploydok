# Style

## Typography policy

- Use **Inter Variable** for all interface text: headings, navigation, labels,
  buttons, forms, tables, dialogs, notifications, and chart labels. This follows
  the [Cloudflare dashboard](https://dash.cloudflare.com/login)'s interface typography.
- Load fonts locally through `@fontsource-variable` imports in
  `packages/ui/src/styles/globals.css`. Do not add remote font stylesheets.
- Use `font-sans` for interface text and `font-heading` for headings. Both resolve
  to the same Inter stack. Do not add component-specific font families.
- Reserve `font-mono` (**JetBrains Mono Variable**) for code, logs, terminal output,
  secrets, and technical identifiers where fixed-width characters help reading.
  Do not use monospace for decorative labels, badges, explanatory text, or counts.
- Use `tabular-nums` for aligned metrics and counters instead of switching fonts.
- Use weight 400 for body text, 500 for controls and labels, and 600 for headings.
  Keep form input text at least 16px on mobile.
- Charts inherit the shared sans token. Canvas-based terminals use the computed
  shared mono token rather than a hardcoded font stack.
- Verify the actual loaded family with `document.fonts` and computed styles on
  a public page and an authenticated page. A declared family without loaded font
  files does not satisfy this policy.

## Prettier (`.prettierrc`)

- `semi: false` — pas de `;` finaux.
- `singleQuote: false` — guillemets doubles `"`.
- `tabWidth: 2`, `printWidth: 80`, `trailingComma: "es5"`.
- `endOfLine: "lf"`.
- Plugin `prettier-plugin-tailwindcss` trie les classes. `cn` et `cva` sont reconnus — les utiliser pour composer les classes dynamiques.

## ESLint

- Web : `@tanstack/eslint-config` (flat config `apps/web/eslint.config.mjs`).
- API / packages : pas de eslint dédié — se fier à `tsc` strict + prettier.
- Lancer : `bun run lint` (turbo délègue aux packages).

## TypeScript

- `tsconfig.base.json` à la racine, `strict: true`. Ne pas relâcher localement.
- Pas de `any`. Utiliser `unknown` + narrow, ou un type précis.
- Pas de `// @ts-ignore` / `// @ts-expect-error` sans commentaire qui explique **pourquoi** et un TODO.
- Préférer `type` pour les unions/alias, `interface` pour les objets étendus.
- Import paths : `@ploydok/*` (workspaces) — jamais d'import relatif cross-package (`../../../packages/...`).

## React / TanStack

- React 19. Server components **non** utilisés (TanStack Start gère SSR via loaders/beforeLoad).
- Préférer `useSuspenseQuery` + route loader à `useEffect` pour fetch initial.
- Forms : Zod schemas de `packages/shared/` côté validation — ne jamais dupliquer les schemas entre front et back.
- Toute action mutante (POST/PUT/PATCH/DELETE, submit, deploy, sync) passe par
  `<Button loading={mutation.isPending}>` : spinner + `disabled` + `aria-busy`
  gérés par le primitive. La règle complète vit dans `AGENTS.md` § Button
  Loading State.

## Commentaires

- Par défaut : **pas** de commentaire. Un bon nom + une signature typée suffisent.
- Écrire un commentaire uniquement si le _pourquoi_ n'est pas évident : contrainte cachée, workaround pour un bug tiers, invariant subtil.
- Pas de JSDoc décoratif (`/** The name of the user */ name: string`).
- Pas de référence à une PR/tâche dans le code (`// added for #123`) — ça appartient au commit message.

## Tailwind

- Tailwind v4 (config via CSS, pas JS). `packages/ui/src/styles/globals.css` est la source.
- Classes longues → `cn(...)` + découpage par état. Éviter les string template imbriquées.

## Taille des icônes — ratio, pas constante

Une icône se dimensionne sur ce qui l'entoure. Il n'y a **pas** de taille globale :
poser `size-4` partout aplatit les états vides et décentre les glyphes en pastille.

| Contexte                             | Glyphe     | Règle                            |
| ------------------------------------ | ---------- | -------------------------------- |
| Aligné sur du texte `text-sm`        | `size-4`   | hauteur de capitale du texte     |
| Dans une boîte `size-10`             | `size-5`   | **glyphe = moitié du conteneur** |
| Dans une boîte `size-12` (état vide) | `size-6`   | idem                             |
| Chip dense à côté de `text-[11px]`   | `size-3.5` |                                  |

- **Deux tailles de conteneur seulement** : `size-10` pour un en-tête de section ou
  de ligne, `size-12` pour l'icône centrée d'un état vide. Pas de `size-11`.
- Dans un `<Button>`, ne **pas** mettre de classe de taille : le primitive injecte
  `size-4` via `[&_svg:not([class*='size-'])]:size-4`. Une taille explicite la neutralise.
- Les pastilles numérotées (`inline-flex size-5 rounded-full`) ne sont pas des icônes :
  elles suivent leur texte, pas cette table.

## Champs de formulaire — une seule surface

Tout champ passe par un primitive de `@workspace/ui` : `Input`, `Textarea`,
`InputGroup`, ou `Select` + `SelectTrigger` pour toute liste déroulante. Pas de
`<select>` natif. Ils partagent la même surface : `bg-background` (blanc dans une `Card` en clair),
`border-input`, `rounded-[10px]`, focus `ring-2 ring-ring/20`. Pas de
`<input>`/`<select>`/`<textarea>` stylé à la main, et pas de `bg-muted` sur un
champ en lecture seule (gris sur le gris du panel) : `ReadOnlyValue` ou `Input
readOnly`. Un champ dense surcharge la taille (`h-auto py-1.5 text-xs
md:text-xs`), jamais la surface. Exceptions : la barre sombre des logs, Monaco,
et `AuthShell` (`authFieldClass`).

## Couleurs de surface — utiliser les tokens panel

- Surface encastrée dans une `Card` : `bg-panel-inset` + `border-panel-border/70`.
  `bg-background` s'inverse en dark (`#0a0a0a` plus sombre que le panel `#171717`).
- Ne pas surcharger une `Card` avec `bg-*` : le primitive porte déjà `bg-panel`.
- `text-destructive-foreground` **n'existe pas** comme token. Sur un bouton d'action
  destructive, utiliser `bg-none bg-destructive text-white hover:bg-none
  hover:bg-destructive/90 active:bg-none` : `bg-none` annule le `background-image`
  du variant `default`, qui recouvrirait la couleur. Il faut le répéter en `hover:`
  et `active:`, sinon le dégradé bleu revient au survol et au clic.
