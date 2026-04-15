import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';

type FileStatus = {
  path: string;
  exists: boolean;
  ageMinutes: number | null;
  stale: boolean;
  severity: 'ok' | 'warn' | 'critical';
};

type HealthReport = {
  generatedAt: string;
  ok: boolean;
  summary: string;
  files: FileStatus[];
};

const WARN_AFTER_MINUTES = 30;
const CRITICAL_AFTER_MINUTES = 45;
const REPORT_PATH = 'data/weather_health.json';
const WATCHED_PATHS = [
  'data/weather_analysis.html',
  'data/weather_snapshot_latest.json',
  'data/forward_test_log.csv',
];

function main(): void {
  const files = WATCHED_PATHS.map(checkPath);
  const critical = files.filter(file => file.severity === 'critical');
  const warnings = files.filter(file => file.severity === 'warn');

  const report: HealthReport = {
    generatedAt: new Date().toISOString(),
    ok: critical.length === 0,
    summary: critical.length
      ? `critical freshness issue in ${critical.map(file => file.path).join(', ')}`
      : warnings.length
        ? `warning freshness issue in ${warnings.map(file => file.path).join(', ')}`
        : 'all watched weather artifacts are fresh',
    files,
  };

  mkdirSync('data', { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[freshness] ${report.summary}`);
  for (const file of files) {
    const age = file.ageMinutes === null ? 'missing' : `${file.ageMinutes.toFixed(1)} min`;
    console.log(`[freshness] ${file.severity.toUpperCase()} ${file.path} age=${age}`);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

function checkPath(path: string): FileStatus {
  if (!existsSync(path)) {
    return { path, exists: false, ageMinutes: null, stale: true, severity: 'critical' };
  }

  const stats = statSync(path);
  const ageMinutes = Math.max(0, (Date.now() - stats.mtimeMs) / 60_000);
  const severity = ageMinutes > CRITICAL_AFTER_MINUTES
    ? 'critical'
    : ageMinutes > WARN_AFTER_MINUTES
      ? 'warn'
      : 'ok';

  return {
    path,
    exists: true,
    ageMinutes,
    stale: severity !== 'ok',
    severity,
  };
}

if (require.main === module) {
  main();
}
