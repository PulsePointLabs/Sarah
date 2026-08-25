import { prepareCloudAnalysisPreflight } from '../server/services/cloudAnalysis/preflight.js';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const sessionId = argument('id');
const recordType = argument('type', 'session');

if (!sessionId) {
  console.error('Usage: npm run cloud:preflight -- --type session|body_exploration --id RECORD_ID');
  process.exitCode = 2;
} else {
  try {
    const result = await prepareCloudAnalysisPreflight({ sessionId, recordType });
    console.log(JSON.stringify(result, null, 2));
    if (!result.readiness.ready_to_package) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

