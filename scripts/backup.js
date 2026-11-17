const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { google } = require('googleapis');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GDRIVE_CREDENTIALS', 'GDRIVE_FOLDER_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Backup disabled: missing ${missing.join(', ')}. No messages were changed.`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runBackup() {
  let filename = null;
  try {
    const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: messages, error: readError } = await supabase
      .from('messages')
      .select('*')
      .is('backup_verified_at', null)
      .lt('created_at', before)
      .order('created_at', { ascending: true })
      .limit(500);
    if (readError) throw readError;

    if (!messages?.length) {
      console.log('No unverified messages older than 24 hours.');
      return;
    }

    const archive = zlib.gzipSync(Buffer.from(JSON.stringify(messages), 'utf8'));
    filename = `tunnel-backup-${new Date().toISOString().replaceAll(':', '-')}.json.gz`;
    fs.writeFileSync(filename, archive);

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GDRIVE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const uploaded = await drive.files.create({
      requestBody: { name: filename, parents: [process.env.GDRIVE_FOLDER_ID] },
      media: { mimeType: 'application/gzip', body: fs.createReadStream(filename) },
      fields: 'id,size,md5Checksum',
    });

    const checksum = createHash('md5').update(archive).digest('hex');
    if (!uploaded.data.id ||
        Number(uploaded.data.size) !== archive.length ||
        uploaded.data.md5Checksum !== checksum) {
      throw new Error('Drive returned an unverified archive; original database messages are preserved.');
    }

    const ids = messages.map(({ id }) => id);
    const { data: marked, error: markError } = await supabase
      .from('messages')
      .update({ backup_verified_at: new Date().toISOString() })
      .in('id', ids)
      .is('backup_verified_at', null)
      .select('id');
    if (markError) throw markError;
    if ((marked?.length ?? 0) !== ids.length) {
      throw new Error('Backup uploaded but database checkpoint was incomplete. Original messages remain in place.');
    }

    console.log(`Verified ${ids.length} messages in Google Drive archive ${uploaded.data.id}; Supabase originals retained.`);
  } catch (error) {
    console.error('Backup failed without deleting any messages:', error);
    process.exitCode = 1;
  } finally {
    if (filename && fs.existsSync(filename)) fs.unlinkSync(filename);
  }
}

void runBackup();
