import {openDb} from '../src/db/database.js';
const db=openDb('C:/Users/PC/ERP/graysale/src/data/graysale.db');
const rows=db.prepare("SELECT id,username,role,tenant_id,active FROM users").all();
console.log(JSON.stringify(rows,null,2));
db.close();
