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
      try {
        await conn.query(stmt);
      } catch (err) {
        // Make schema.sql re-runnable by tolerating duplicate-column errors.
        // This is especially helpful for ADD COLUMN statements.
        const msg = err?.message || '';
        if (err?.code === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(msg)) {
          console.warn('Migration skipped duplicate column:', err?.code || msg);
          continue;
        }
        throw err;
      }
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

