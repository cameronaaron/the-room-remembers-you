/** Resolve any stylesheet import to an empty module. See style-imports.ts. */
const STYLESHEET = /\.(css|scss|sass|less)(\?.*)?$/;

export async function resolve(specifier, context, next) {
  if (STYLESHEET.test(specifier)) {
    return { shortCircuit: true, url: new URL('data:text/javascript,export default {}').href };
  }
  return next(specifier, context);
}
