/**
 * Environment for a non-Node child launched from a Node test process.
 *
 * c8 instruments every Node descendant through these two variables. Chrome is
 * not one of those descendants in the sense c8 means, but it embeds V8 and can
 * still observe the coverage directory. On macOS that made the real renderer
 * gate spend three minutes starting and then exit with "Trying to load the
 * allocator multiple times". The browser must be measured by its pixel report,
 * not by Node's source-coverage machinery.
 */
export function withoutNodeInstrumentation(environment) {
  const clean = { ...environment };
  delete clean.NODE_OPTIONS;
  delete clean.NODE_V8_COVERAGE;
  return clean;
}
