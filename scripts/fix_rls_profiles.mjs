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
    // Drop the overly restrictive policy
    await client.query(`DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;`);
    console.log("Dropped old policy");
    
    // Add the new permissive policy (since profiles contain no sensitive PII, just public matching info)
    await client.query(`
      CREATE POLICY "Everyone can view profiles"
      ON public.profiles FOR SELECT TO authenticated
      USING (TRUE);
    `);
    console.log("Added new relaxed policy for profile fetching");
  } catch (e) {
    console.error("Error:", e.message);
  }
  await client.end();
}
fix();
