import type Database from 'better-sqlite3';

type SchemaRow = { sql: string | null };
type ColumnRow = { name: string };

function quoted(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

// Every known historical SystemId CHECK shape, oldest first. When a new system is
// added, append the new full list here rather than writing a new one-off function.
const LEGACY_CONSTRAINTS = [
  "('letta', 'hermes')",
  "('letta', 'hermes', 'claude')",
];
const CURRENT_CONSTRAINT = "('letta', 'hermes', 'claude', 'b200')";

export function widenSystemIdCheckConstraints(db: Database.Database, table: string) {
  const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as SchemaRow | undefined;
  const sql = schema?.sql ?? '';
  if (!sql || sql.includes(CURRENT_CONSTRAINT)) return false;

  const oldConstraint = LEGACY_CONSTRAINTS.find((candidate) => sql.includes(candidate));
  if (!oldConstraint) {
    throw new Error(`Cannot widen ${table}: expected legacy SystemId CHECK was not found`);
  }
  if (db.inTransaction) throw new Error(`Cannot widen ${table} inside an active transaction`);

  const tableName = quoted(table);
  const temp = `${table}__system_id_migration`;
  const tempName = quoted(temp);
  const columns = (db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnRow[]).map((row) => row.name);
  if (!columns.length) throw new Error(`Cannot widen ${table}: no columns found`);
  const columnList = columns.map(quoted).join(', ');
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all(table) as Array<{ type: string; name: string; sql: string }>;

  const createSql = sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i, `CREATE TABLE ${tempName}`)
    .split(oldConstraint).join(CURRENT_CONSTRAINT);

  const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) !== 0;
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`DROP TABLE IF EXISTS ${tempName}`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${tempName} (${columnList}) SELECT ${columnList} FROM ${tableName}`);
    db.exec(`DROP TABLE ${tableName}`);
    db.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
    for (const object of objects) db.exec(object.sql);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length) throw new Error(`Foreign key check failed after widening ${table}`);
  return true;
}
