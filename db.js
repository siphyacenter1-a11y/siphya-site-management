const { Pool } = require('pg');
require('dotenv').config();

const sitePool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'waste_tracking_db',
  max: 20,
  idleTimeoutMillis: 30000,
});

sitePool.on('error', (err) => {
  console.error('[PostgreSQL Site DB Error]:', err);
});

module.exports = {
  sitePool,
  querySite: (text, params) => sitePool.query(text, params),
};
