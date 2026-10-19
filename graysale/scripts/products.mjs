import {openDb} from '../src/db/database.js';
const db=openDb('C:/Users/PC/ERP/graysale/src/data/graysale.db');
const rows=db.prepare("SELECT id,sku,name,price_cents FROM products").all();
console.log(JSON.stringify(rows,null,2));
db.close();
