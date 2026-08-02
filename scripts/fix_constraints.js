const { Client } = require('pg');
const connectionString = process.env.SUPABASE_DB_URL;

async function fixConstraints() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log('Connected to database.');

    // Fix messages.sender_id
    console.log('Fixing messages.sender_id foreign key...');
    await client.query(`
      ALTER TABLE public.messages
      DROP CONSTRAINT IF EXISTS messages_sender_id_fkey,
      ADD CONSTRAINT messages_sender_id_fkey
        FOREIGN KEY (sender_id)
        REFERENCES public.profiles(id)
        ON DELETE CASCADE;
    `);

    // Fix chat_reports.reporter_id and target_id
    console.log('Fixing chat_reports foreign keys...');
    await client.query(`
      ALTER TABLE public.chat_reports
      DROP CONSTRAINT IF EXISTS chat_reports_reporter_id_fkey,
      ADD CONSTRAINT chat_reports_reporter_id_fkey
        FOREIGN KEY (reporter_id)
        REFERENCES public.profiles(id)
        ON DELETE CASCADE;
        
      ALTER TABLE public.chat_reports
      DROP CONSTRAINT IF EXISTS chat_reports_target_id_fkey,
      ADD CONSTRAINT chat_reports_target_id_fkey
        FOREIGN KEY (target_id)
        REFERENCES public.profiles(id)
        ON DELETE CASCADE;
    `);

    // Fix admin_takeovers.admin_id and target_user_id
    console.log('Fixing admin_takeovers foreign keys...');
    await client.query(`
      ALTER TABLE public.admin_takeovers
      DROP CONSTRAINT IF EXISTS admin_takeovers_admin_id_fkey,
      ADD CONSTRAINT admin_takeovers_admin_id_fkey
        FOREIGN KEY (admin_id)
        REFERENCES public.profiles(id)
        ON DELETE CASCADE;
        
      ALTER TABLE public.admin_takeovers
      DROP CONSTRAINT IF EXISTS admin_takeovers_target_user_id_fkey,
      ADD CONSTRAINT admin_takeovers_target_user_id_fkey
        FOREIGN KEY (target_user_id)
        REFERENCES public.profiles(id)
        ON DELETE CASCADE;
    `);
    
    // Also matches.takeover_by and takeover_target? Wait, matches have an array of participants which is not a foreign key natively enforcing delete cascade, but takeover_by and takeover_target are.
    console.log('Fixing matches foreign keys...');
    await client.query(`
      ALTER TABLE public.matches
      DROP CONSTRAINT IF EXISTS matches_takeover_by_fkey,
      ADD CONSTRAINT matches_takeover_by_fkey
        FOREIGN KEY (takeover_by)
        REFERENCES public.profiles(id)
        ON DELETE SET NULL;
        
      ALTER TABLE public.matches
      DROP CONSTRAINT IF EXISTS matches_takeover_target_fkey,
      ADD CONSTRAINT matches_takeover_target_fkey
        FOREIGN KEY (takeover_target)
        REFERENCES public.profiles(id)
        ON DELETE SET NULL;
    `);

    console.log('Successfully updated constraints to CASCADE/SET NULL on delete.');

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

fixConstraints();
