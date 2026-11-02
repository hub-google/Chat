const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const zlib = require('zlib');
const { google } = require('googleapis');
const { createHash } = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Must use service key to bypass RLS

if (!supabaseUrl || !supabaseKey || !process.env.GDRIVE_CREDENTIALS || !process.env.GDRIVE_FOLDER_ID) {
  console.error('Backup disabled: Supabase and Google Drive credentials/folder are required. No data will be deleted.');
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
      .lt('created_at', backupThreshold)
      .order('created_at', { ascending: true })
      .limit(500);

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

        const upload = await drive.files.create({
          requestBody: {
            name: filename,
            parents: [process.env.GDRIVE_FOLDER_ID].filter(Boolean),
          },
          media: {
            mimeType: 'application/gzip',
            body: fs.createReadStream(filename),
          },
          fields: 'id,size,md5Checksum',
        });
        const expectedChecksum = createHash('md5').update(compressed).digest('hex');
        if (!upload.data.id || Number(upload.data.size) !== compressed.length || upload.data.md5Checksum !== expectedChecksum) {
          throw new Error('Drive backup verification failed; database records retained');
        }
        console.log('Uploaded to Google Drive successfully.');
      } else {
        console.log('Skipping Google Drive upload (No credentials found).');
      }

      // 4. Soft Delete (we just backup here, let's assume we don't delete them immediately, or mark them backed_up)
      // Actually, requirements said "清理 Supabase", let's delete them from DB.
      console.log('Deleting backed up messages from database...');
      const { error: deleteError } = await supabase.from('messages').delete().in('id', messagesToBackup.map(message => message.id));
      if (deleteError) throw deleteError;
    }

    // Also cleanup inactive matches older than 7 days
    console.log('Cleaning up old matches...');
    const { error: cleanupError } = await supabase.from('matches').delete().eq('is_active', false).lt('created_at', hardDeleteThreshold);
    if (cleanupError) throw cleanupError;

    console.log('Backup and cleanup complete!');
  } catch (err) {
    console.error('Backup failed:', err);
    process.exit(1);
  }
}

runBackup();
