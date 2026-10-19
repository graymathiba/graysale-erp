import {openDb} from '../src/db/database.js';
const db=openDb('C:/Users/PC/ERP/graysale/src/data/graysale.db');
const rows=db.prepare("SELECT id,doc_no,type,status,total_cents,ecocash_reference,ecocash_status FROM orders ORDER BY id").all();
console.log(JSON.stringify(rows,null,2));
db.close();
