// Local stand-in for Cloudflare's Cron Trigger: `wrangler dev` never fires crons on its own,
// so this calls the --test-scheduled endpoint once a minute. Stop it with Ctrl-C.
const url = process.env.WORKER_URL ?? 'http://localhost:8787';
const endpoint = `${url}/__scheduled?cron=${encodeURIComponent('* * * * *')}`;

async function tick() {
  const time = new Date().toLocaleTimeString();
  try {
    const res = await fetch(endpoint);
    console.log(`[${time}] cron triggered (${res.status})`);
  } catch {
    console.log(`[${time}] worker not reachable at ${url}; is \`npm run dev:worker\` or \`npm run preview\` running?`);
  }
}

console.log(`Triggering the cron every 60 s at ${url}`);
await tick();
setInterval(tick, 60_000);
