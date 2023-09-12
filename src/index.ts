import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { poweredBy } from 'hono/powered-by';
import { match } from 'ts-pattern';

import { candidates, ftMetas, nftMetas } from './candidates';

const app = new Hono<{ Bindings: Env }>();

app.use('*', poweredBy());
app.use('*', cors());

app.route('/candidates', candidates);
app.route('/ftmetas', ftMetas);
app.route('/nftmetas', nftMetas);

app.onError(
  err =>
    new Response(null, {
      status: match(err.message)
        .with('Unauthorized', () => 401 as const)
        .with('Bad Request', () => 400 as const)
        .otherwise(() => {
          throw err;
        })
    })
);

app.notFound(() => {
  return new Response(null, { status: 404 });
});

export default {
  fetch: app.fetch,

  async scheduled(event: unknown, env: Env) {
    console.info('cron processed');
    const addr = env.CANDIDATES.idFromName('');
    const obj = env.CANDIDATES.get(addr);
    await obj.fetch('https://candidates.com', {
      method: 'POST',
      headers: {
        PIKESPEAK_API_KEY: env.PIKESPEAK_API_KEY,
        PAGODA_API_KEY: env.PAGODA_API_KEY
      }
    });
  }
};

export { Candidates } from './candidates';
