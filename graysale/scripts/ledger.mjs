import {openDb} from '../src/db/database.js';
const db=openDb('C:/Users/PC/ERP/graysale/src/data/graysale.db');
const bal=db.prepare("SELECT sum(debit_cents)-sum(credit_cents) as bal FROM journal_lines").get();
console.log('bal', bal.bal);
db.close();
