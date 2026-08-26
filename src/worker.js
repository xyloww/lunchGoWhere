// Cloudflare entry point — the counterpart to `server.js`.
//
// Static files are served by Workers Static Assets before this ever runs (see
// `wrangler.jsonc`), so in practice only `/api/*` reaches here; the ASSETS
// fall-through covers the rest.

import { Group } from './group.js';

export { Group };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      // One object per group name. Everyone shares "default" unless GROUP_NAME is
      // set — a second deployment with a different name is a second, separate board.
      const id = env.GROUP.idFromName(env.GROUP_NAME ?? 'default');
      return env.GROUP.get(id).fetch(request);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Method not allowed', { status: 405 });
  },
};
