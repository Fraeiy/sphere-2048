import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const password = process.env.DB_PASSWORD ?? 'zeHjdW4eGWvGnioZ';
const ref = 'qikjgngheylczoqwspgl';

const urls = [
  `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
  `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`,
  `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:6543/postgres`,
];

const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

async function run(url) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected:', url.replace(password, '***'));

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`Running ${file}...`);
    await client.query(sql);
    console.log(`  OK`);
  }

  await client.end();
  return true;
}

for (const url of urls) {
  try {
    await run(url);
    console.log('\nAll migrations applied successfully.');
    process.exit(0);
  } catch (err) {
    console.error(`Failed with ${url.split('@')[1]}:`, err.message);
  }
}

console.error('\nAll connection attempts failed.');
process.exit(1);