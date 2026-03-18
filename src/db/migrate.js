const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function main() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith(';') ? s : `${s};`));

  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS=0;');
    for (const stmt of statements) {
      // eslint-disable-next-line no-await-in-loop
      await conn.query(stmt);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS=1;');
    console.log('Migration completed successfully.');
  } finally {
    conn.release();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

