import pg from 'pg';
import fs from 'fs';
const { Client } = pg;

const env = fs.readFileSync('.env', 'utf-8');
const dbUrl = env.split('\n').find(line => line.startsWith('SUPABASE_DB_URL=')).split('=')[1].trim();

async function fix() {
  const client = new Client({
    connectionString: dbUrl
  });
  await client.connect();
  try {
    await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;`);
    console.log("Added matches to supabase_realtime");
  } catch (e) {
    console.error("Matches error:", e.message);
  }
  try {
    await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;`);
    console.log("Added messages to supabase_realtime");
  } catch (e) {
    console.error("Messages error:", e.message);
  }
  await client.end();
}
fix();
