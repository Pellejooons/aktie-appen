import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

function loadDotEnv(filePath) {
  // Minimal dotenv parser (no deps) to avoid pulling secrets into logs.
  const out = {};
  const txt = readFileSync(filePath, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function waitForHealth({ baseUrl, headers, timeoutMs }) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { headers });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.ok === true) return;
      }
      lastErr = new Error(`health not ok (status ${res.status})`);
    } catch (e) {
      lastErr = e;
    }
    await delay(150);
  }
  throw lastErr ?? new Error('health timeout');
}

async function main() {
  const envPath = new URL('../.env', import.meta.url);
  const envFromFile = loadDotEnv(envPath);

  const PORT = Number(envFromFile.PORT || process.env.PORT || 3000);
  const HOST = envFromFile.HOST || process.env.HOST || '0.0.0.0';

  const env = {
    ...process.env,
    ...envFromFile,
    PORT: String(PORT),
    HOST,
  };

  const baseUrl = `http://127.0.0.1:${PORT}`;

  const headers = {};
  if (env.APP_USER && env.APP_PASSWORD) {
    headers.authorization = basicAuthHeader(env.APP_USER, env.APP_PASSWORD);
  }

  // Use npx to resolve tsx reliably even in workspaces/hoisted node_modules.
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  const logs = [];
  const onData = (buf) => {
    const s = String(buf);
    // Redact potential secrets.
    logs.push(
      s
        .replaceAll(env.OPENAI_API_KEY || '', '[REDACTED]')
        .replaceAll(env.APP_PASSWORD || '', '[REDACTED]')
    );
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  try {
    await waitForHealth({ baseUrl, headers, timeoutMs: 10_000 });

    const analyzeRes = await fetch(`${baseUrl}/api/analyze`, { method: 'POST', headers });
    const analyzeBody = await analyzeRes.json().catch(() => ({}));

    const latestRes = await fetch(`${baseUrl}/api/analysis/latest`, { headers });
    const latestBody = await latestRes.json().catch(() => ({}));

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      analyzeStatus: analyzeRes.status,
      analyzeOk: analyzeBody?.ok,
      analyzeReportStatus: analyzeBody?.report?.status ?? null,
      analyzeError: analyzeBody?.report?.error ?? analyzeBody?.error ?? null,
      latestStatus: latestRes.status,
      latestReportStatus: latestBody?.latest?.status ?? null,
    }, null, 2));
  } catch (err) {
    console.error('SMOKE_FAILED:', err?.message ?? err);
    console.error('--- last logs ---');
    process.stderr.write(logs.slice(-80).join(''));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await delay(250);
    child.kill('SIGKILL');
  }
}

main();
