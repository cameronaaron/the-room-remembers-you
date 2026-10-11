/**
 * Hand a file to the person at the machine.
 *
 * Small, but it was written twice — once for the sensing log and once for the
 * event recording — and both copies had to remember to revoke the object URL.
 * A leaked blob URL pins its blob for the life of the document, which for this
 * installation is a twelve-hour gallery day.
 *
 * Kept apart from `session-export.ts` so that what a file *contains* stays
 * testable without a DOM, and only this — the part that genuinely needs a
 * browser — depends on one.
 */

/** Serialise, hand over, and release. Pretty-printed: people read these. */
export function downloadJson(filename: string, payload: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // In a `finally` because a click that throws still leaves the blob pinned.
    URL.revokeObjectURL(url);
  }
}
