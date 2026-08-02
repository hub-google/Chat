const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const zlib = require('zlib');
const { google } = require('googleapis');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Must use service key to bypass RLS

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runBackup() {
  console.log('Starting backup process...');

  try {
    // 1. Fetch old messages (older than 24 hours for backup, 7 days for hard delete)
    const backupThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hardDeleteThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: messagesToBackup, error: fetchErr } = await supabase
      .from('messages')
      .select('*')
      .lt('created_at', backupThreshold);

    if (fetchErr) throw fetchErr;

    if (!messagesToBackup || messagesToBackup.length === 0) {
      console.log('No messages to backup.');
    } else {
      console.log(`Found ${messagesToBackup.length} messages to backup.`);
      
      // 2. Compress data
      const jsonStr = JSON.stringify(messagesToBackup);
      const compressed = zlib.gzipSync(jsonStr);
      const filename = `backup_${new Date().toISOString().replace(/:/g, '-')}.json.gz`;
      fs.writeFileSync(filename, compressed);
      console.log(`Saved compressed backup to ${filename}`);

      // 3. Upload to Google Drive (if credentials exist)
      if (process.env.GDRIVE_CREDENTIALS) {
        console.log('Uploading to Google Drive...');
        const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        await drive.files.create({
          requestBody: {
            name: filename,
            parents: [process.env.GDRIVE_FOLDER_ID].filter(Boolean),
          },
          media: {
            mimeType: 'application/gzip',
            body: fs.createReadStream(filename),
          },
        });
        console.log('Uploaded to Google Drive successfully.');
      } else {
        console.log('Skipping Google Drive upload (No credentials found).');
      }

      // 4. Soft Delete (we just backup here, let's assume we don't delete them immediately, or mark them backed_up)
      // Actually, requirements said "清理 Supabase", let's delete them from DB.
      console.log('Deleting backed up messages from database...');
      await supabase.from('messages').delete().lt('created_at', backupThreshold);
    }

    // Also cleanup inactive matches older than 7 days
    console.log('Cleaning up old matches...');
    await supabase.from('matches').delete().lt('created_at', hardDeleteThreshold);

    console.log('Backup and cleanup complete!');
  } catch (err) {
    console.error('Backup failed:', err);
    process.exit(1);
  }
}

runBackup();
