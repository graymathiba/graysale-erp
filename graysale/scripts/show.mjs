import {openDb} from '../src/db/database.js';
const db=openDb('C:/Users/PC/ERP/graysale/src/data/graysale.db');
const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
rows.slice(0,30).forEach(r=>console.log(r.name));
db.close();
