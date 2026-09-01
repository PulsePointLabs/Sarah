import { runMediaRetention } from '../server/services/mediaRetention.js';

const apply = process.argv.includes('--apply');
const result = await runMediaRetention({ apply, source: 'cli' });
const summary = apply ? result.manifest.deleted_summary : result.manifest.candidate_summary;
console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry_run',
  manifest: result.manifestPath,
  scanned_files: result.manifest.scanned_file_count,
  referenced_filenames: result.manifest.referenced_filename_count,
  files: summary.files,
  gigabytes: summary.gigabytes,
  categories: summary.categories,
  failures: result.manifest.failures?.length || 0,
}, null, 2));
