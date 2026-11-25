import { onRequest } from '../functions/api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname === '/api/') {
      return onRequest({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
