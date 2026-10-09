const { querySite } = require('../db');
const bcrypt = require('bcryptjs');

async function initUsers() {
  console.log('Creating users table in PostgreSQL...');
  await querySite(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      role VARCHAR(20) DEFAULT 'staff',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    );
  `);

  const adminHash = await bcrypt.hash('admin1234', 10);
  const staffHash = await bcrypt.hash('staff1234', 10);

  await querySite(`
    INSERT INTO users (username, password_hash, full_name, role)
    VALUES 
      ('admin', $1, 'ผู้ดูแลระบบสูงสุด (Admin)', 'admin'),
      ('staff', $2, 'เจ้าหน้าที่หน้างาน (Staff)', 'staff')
    ON CONFLICT (username) DO NOTHING;
  `, [adminHash, staffHash]);

  console.log('✅ Users table and default accounts initialized successfully!');
  process.exit(0);
}

initUsers().catch(err => {
  console.error('❌ Error initializing users:', err);
  process.exit(1);
});
