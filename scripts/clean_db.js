const { Client } = require('pg');

const connectionString = process.env.SUPABASE_DB_URL;

const projectTables = [
  'profiles',
  'matching_pool',
  'matches',
  'messages',
  'chat_reports',
  'topic_categories',
  'topic_cards',
  'admin_takeovers'
];

async function cleanDB() {
  if (!connectionString) {
    console.error('Missing SUPABASE_DB_URL in .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
  });

  try {
    await client.connect();
    console.log('Connected to database.');

    const res = await client.query(`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public';
    `);

    const allTables = res.rows.map(r => r.tablename);
    console.log('All public tables:', allTables);

    const tablesToDrop = allTables.filter(t => !projectTables.includes(t));
    
    if (tablesToDrop.length === 0) {
      console.log('No extra tables to drop.');
    } else {
      console.log('Tables to drop:', tablesToDrop);
      for (const t of tablesToDrop) {
        console.log(`Dropping table ${t} CASCADE...`);
        await client.query(`DROP TABLE IF EXISTS "public"."${t}" CASCADE;`);
      }
      console.log('Done dropping extra tables.');
    }

  } catch (err) {
    console.error('Error cleaning db:', err);
  } finally {
    await client.end();
  }
}

cleanDB();
