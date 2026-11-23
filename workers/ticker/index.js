// ConnecTHOR ticker: a Cloudflare Worker that starts the data tools on time.
// GitHub runs scheduled workflows "best effort" and skips most hourly runs on a quiet repo (Mjölnir
// and Loki ran about 3 times a day instead of 24). A Cron Trigger is reliable, so this Worker asks
// GitHub to run each tool's workflow (workflow_dispatch) on the hour. The workflows keep their own
// schedule as a fallback; their concurrency groups stop two runs of one tool from overlapping.
//
// Needs the secret GH_TOKEN: a fine-grained GitHub token for mbp-agentz/connecthor and
// mbp-agentz/aggregathor with only "Actions: Read and write". Deployed by .github/workflows/ticker.yml.
// Free plan: 2 cron triggers, 32 invocations and about 60 GitHub API calls a day.
const REPO = 'mbp-agentz/connecthor';
// workflow file, every how many hours (UTC hour divisible by it)
const PLAN = [
  ['mjolnir.yml', 1],
  ['loki.yml', 1],
  ['heimdall.yml', 3],
  ['valkyries.yml', 6],
];
// aggregaTHOR (sister site) turns these findings into news; its own 3-hour schedule is skipped by
// GitHub as well, so the second trigger starts its update 20 minutes after the tools, every 3 hours
const AGGREGATHOR = { cron: '25 */3 * * *', repo: 'mbp-agentz/aggregathor', wf: 'deploy.yml' };
// aggregaTHOR's daily research run (paid, on the owner's account), also skipped by GitHub: started
// with the 06:25 trigger as daily=true, so research.yml treats it as its schedule (only runs with
// RESEARCH_ENABLED=true, at most once in 20 hours)
const RESEARCH = { hour: 6, wf: 'research.yml', inputs: { daily: 'true' } };

async function dispatch(env, wf, repo = REPO, inputs) {
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'connecthor-ticker',
    },
    body: JSON.stringify(inputs ? { ref: 'main', inputs } : { ref: 'main' }),
  });
  // 204 = started; anything else is logged with GitHub's reason
  return r.status === 204 ? `${wf} started` : `${wf} HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
}

export const due = hour => PLAN.filter(([, every]) => hour % every === 0).map(([wf]) => wf);

export default {
  async scheduled(event, env, ctx) {
    if (!env.GH_TOKEN) return console.error('GH_TOKEN is not set: nothing started');
    if (event.cron === AGGREGATHOR.cron) {
      const jobs = [dispatch(env, AGGREGATHOR.wf, AGGREGATHOR.repo)];
      if (new Date(event.scheduledTime).getUTCHours() === RESEARCH.hour) jobs.push(dispatch(env, RESEARCH.wf, AGGREGATHOR.repo, RESEARCH.inputs));
      return console.log('aggregaTHOR ' + (await Promise.all(jobs)).join(' · '));
    }
    const wfs = due(new Date(event.scheduledTime).getUTCHours());
    console.log((await Promise.all(wfs.map(wf => dispatch(env, wf)))).join(' · '));
  },
};
