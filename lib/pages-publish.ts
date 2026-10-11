/**
 * What may leave the machine when the room is published to the open web.
 *
 * The exhibition runtime is `scripts/static-server.mjs` on `127.0.0.1`, and
 * that remains the thing the piece is built for. A hosted copy is a different
 * object: a link someone can open from a laptop that is not in the gallery.
 * Two details separate the two, and both are silent when they are wrong, which
 * is why they are decided here rather than in the shell command that uploads.
 *
 * The first is that the build directory is not the publish directory. Vite and
 * vinext leave their own manifests beside the artifact, and Workers hosting
 * knows to skip them because `.assetsignore` names them. Pages has no such
 * mechanism: it uploads the directory it is handed. Left alone, the exact files
 * describing every chunk and entry point in the build become public, which is
 * not a security boundary the installation depends on but is also not something
 * anyone chose to serve.
 *
 * The second is that the local server sends `Permissions-Policy` allowing the
 * camera and the microphone, and the hosted copy is only worth opening if it
 * can do the same. The generated `_headers` carries caching and nothing else,
 * so the policy has to be appended to it. Appending is the part worth testing:
 * a publish step that runs twice must not write the block twice.
 */

/**
 * Build bookkeeping that Workers hosting hides via `.assetsignore` and Pages
 * would otherwise serve. Matched against paths relative to the build root.
 */
export const BUILD_INTERNAL_PATHS = [
  '.assetsignore',
  '.vite',
  'vinext-client-entry-manifest.json',
] as const;

/** The marker that makes appending the policy idempotent. */
const POLICY_MARKER = 'Permissions-Policy:';

/**
 * The camera and microphone grant, mirroring `scripts/static-server.mjs`.
 *
 * `self` and not `*`: the installation asks for the devices from its own
 * top-level page, and nothing it embeds has any business asking.
 */
export const EXHIBITION_HEADER_BLOCK = `# Match scripts/static-server.mjs: the installation needs camera and microphone.
/*
  Permissions-Policy: camera=(self), microphone=(self)
`;

/**
 * Whether a build-relative path is bookkeeping rather than part of the room.
 *
 * Directories are matched by prefix so that `.vite/manifest.json` is excluded
 * by naming `.vite`, and a future second file inside it needs no new entry.
 * Separators are normalised because the caller walks a real filesystem.
 */
export function isBuildInternal(relativePath: string): boolean {
  const path = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return BUILD_INTERNAL_PATHS.some(
    (internal) => path === internal || path.startsWith(`${internal}/`),
  );
}

/** Split a walked build directory into what is published and what is withheld. */
export function partitionPublishable(relativePaths: readonly string[]): {
  publish: string[];
  withhold: string[];
} {
  const publish: string[] = [];
  const withhold: string[] = [];
  for (const path of relativePaths) {
    (isBuildInternal(path) ? withhold : publish).push(path);
  }
  return { publish, withhold };
}

/**
 * The generated `_headers` with the device policy added, or unchanged if it is
 * already there.
 *
 * The idempotence is not decoration. Publishing reads `_headers` out of a build
 * directory that a previous publish may have already written to, and a repeated
 * `/*` section is the kind of thing Pages accepts and no one reads again.
 */
export function withExhibitionHeaders(generatedHeaders: string): string {
  if (generatedHeaders.includes(POLICY_MARKER)) return generatedHeaders;
  const separator = generatedHeaders.endsWith('\n') ? '\n' : '\n\n';
  return `${generatedHeaders}${separator}${EXHIBITION_HEADER_BLOCK}`;
}

/**
 * Read a `--name=value` argument, or fall back.
 *
 * An empty value falls back rather than being passed on. `--project=` would
 * otherwise publish to a project named nothing: wrangler is handed
 * `--project-name=`, and what comes back is an argument-parsing complaint that
 * says nothing about the empty flag that caused it. A flag someone clearly
 * meant to fill in is better treated as absent than as the empty string.
 *
 * Matching is on the full `--name=` prefix, so `--project-name=x` is not read
 * as `project`, and the first occurrence wins.
 */
export function deployFlag(argv: readonly string[], name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = argv.find((argument) => argument.startsWith(prefix));
  if (match === undefined) return fallback;
  const value = match.slice(prefix.length);
  return value === '' ? fallback : value;
}
