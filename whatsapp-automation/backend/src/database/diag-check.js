const { Client } = require('D:/chat bot/whatsapp-automation-main/whatsapp-automation/node_modules/pg');
const DB = 'postgresql://postgres.jkxthaukalbtcwtkkyhi:Br_florino10@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
(async () => {
  const c = new Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const chk = await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'messages'::regclass AND contype = 'c'`);
  console.log('CHECKs messages:', JSON.stringify(chk.rows, null, 1));
  const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename='messages'`);
  console.log('indices:', idx.rows.map(r=>r.indexname).join(', '));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
