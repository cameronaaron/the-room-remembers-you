/**
 * The launch agent that starts the installation when the gallery machine boots.
 *
 * Building the document is separated from installing it because the document is
 * where the mistakes are. A project path is not a safe string: it is chosen by
 * whoever checked the work out, it lands inside both an XML element and a shell
 * command, and on a gallery machine nobody reads the plist before the room is
 * supposed to open. `plutil -lint` in the installer catches malformed XML after
 * the fact; these functions are what stop it being malformed.
 */

/** The launch agent's label, and the basename of its plist. */
export const AGENT_LABEL = 'art.room-remembers-you';

export type AutostartPaths = {
  /** The checkout the agent should run from. */
  project: string;
  /** Where the agent's stdout and stderr are kept. */
  runtime: string;
};

/**
 * Escape for an XML text node.
 *
 * `&` must be replaced first: doing it after the others would re-escape the
 * ampersands they just introduced and write `&amp;lt;` into the document.
 */
export function xmlEscape(value: string): string {
  // Complete for text nodes, which is the only place this is used.
  // nosemgrep: detect-replaceall-sanitization
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Quote for `zsh -lc`.
 *
 * Single quotes take everything literally except a single quote, which has to
 * leave the quoted run, be escaped, and come back in. A path containing one —
 * `/tmp/someone/Nadia's work/room` — is otherwise a command that ends early
 * and then runs whatever followed it.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command the agent runs. Skips the build: the gallery machine boots to run, not to compile. */
export function autostartCommand(project: string): string {
  return `cd ${shellQuote(project)} && /usr/bin/env npm run exhibit -- --kiosk --skip-build`;
}

/** The complete launch agent document. */
export function launchAgentPlist({ project, runtime }: AutostartPaths): string {
  const command = autostartCommand(project);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(command)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(`${runtime}/installation.log`)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(`${runtime}/installation-error.log`)}</string>
</dict></plist>
`;
}
