import fs from 'node:fs/promises';
import pg from 'pg';

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) throw new Error('SUPABASE_DB_URL is not configured');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  for (const filename of ['./apply_takeover_fix.sql', './apply_matching_topic_fix.sql']) {
    const sql = await fs.readFile(new URL(filename, import.meta.url), 'utf8');
    await client.query(sql);
  }
  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'profiles'
        AND column_name IN ('last_ip', 'last_ip_location_zh')
      ORDER BY column_name`,
  );
  console.log(`Applied database fixes. Columns: ${rows.map(({ column_name }) => column_name).join(', ')}`);
} finally {
  await client.end();
}
