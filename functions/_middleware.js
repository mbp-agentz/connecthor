// The site lives on connecthor.org only: www and the project's own pages.dev address answer with a
// permanent redirect, so search engines and shared links settle on one URL. Preview deployments
// (<hash or branch>.connecthor.pages.dev) are left alone for testing.
// _routes.json limits Functions to "/" and "/api/*", so static files never run this (quota).
const CANONICAL = 'connecthor.org';
const ALIASES = new Set(['www.connecthor.org', 'connecthor.pages.dev']);

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (ALIASES.has(url.hostname)) {
    url.hostname = CANONICAL;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
