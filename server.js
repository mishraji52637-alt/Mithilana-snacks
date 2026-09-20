// Mithilana Makhana - orders, Razorpay, WhatsApp OTP/customer login and admin
// Node.js 18+
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }) : null;
const otpChallenges = new Map();
const adminSessions = new Map();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '918434990815';
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const WHATSAPP_OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || 'mithilana_login_otp';
const WHATSAPP_OTP_LANGUAGE = process.env.WHATSAPP_OTP_LANGUAGE || 'en_US';
const WHATSAPP_ORDER_TEMPLATE = process.env.WHATSAPP_ORDER_TEMPLATE || 'mithilana_order_confirmation';
const WHATSAPP_ORDER_LANGUAGE = process.env.WHATSAPP_ORDER_LANGUAGE || 'en_US';
const WHATSAPP_STATUS_TEMPLATE = process.env.WHATSAPP_STATUS_TEMPLATE || 'mithilana_order_status';
const WHATSAPP_STATUS_LANGUAGE = process.env.WHATSAPP_STATUS_LANGUAGE || 'en_US';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

const PRODUCTS = {
  raw100: { name: 'Premium Raw Phool Makhana', size: '100g', price: 200 },
  raw200: { name: 'Premium Raw Phool Makhana', size: '200g', price: 390 },
  raw500: { name: 'Premium Raw Phool Makhana', size: '500g', price: 900 },
  raw1kg: { name: 'Premium Raw Phool Makhana', size: '1kg', price: 1800 },
  raw5kg: { name: 'Premium Raw Phool Makhana', size: '5kg', price: 4500 }
};
const STATUS = ['New','Processing','Picked','Out for Delivery','Delivered','Cancelled','Payment Pending','Payment Failed'];

function cleanPhone(v) { return String(v || '').replace(/\D/g, '').slice(-10); }
function waPhone(v) { const p = cleanPhone(v); return p ? '91' + p : ''; }
function newOrderNo() { return 'MIT' + Date.now().toString().slice(-8) + crypto.randomBytes(2).toString('hex').toUpperCase(); }
function readJsonOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; } }
function writeJsonOrders(orders) { const tmp = ORDERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(orders, null, 2)); fs.renameSync(tmp, ORDERS_FILE); }
async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', pin TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (order_no TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', pin TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, address TEXT NOT NULL, items JSONB NOT NULL, total NUMERIC NOT NULL, payment TEXT NOT NULL, payment_status TEXT NOT NULL, order_status TEXT NOT NULL, razorpay_order_id TEXT, razorpay_payment_id TEXT, razorpay_signature TEXT, placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
}
async function getOrders() {
  if (!pool) return readJsonOrders();
  const { rows } = await pool.query('SELECT order_no AS "orderNo", name, phone, email, pin, city, state, address, items, total, payment, payment_status AS "paymentStatus", order_status AS "orderStatus", razorpay_order_id AS "razorpayOrderId", razorpay_payment_id AS "razorpayPaymentId", razorpay_signature AS "razorpaySignature", placed_at AS "placedAt", updated_at AS "updatedAt" FROM orders ORDER BY placed_at DESC');
  return rows.map(r => ({...r, total:Number(r.total)}));
}
async function findOrder(orderNo) { return (await getOrders()).find(o => o.orderNo === orderNo) || null; }
async function saveOrder(order) {
  if (!pool) { const a=readJsonOrders(); a.unshift(order); writeJsonOrders(a); return order; }
  await pool.query(`INSERT INTO orders(order_no,name,phone,email,pin,city,state,address,items,total,payment,payment_status,order_status,razorpay_order_id,razorpay_payment_id,razorpay_signature,placed_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [order.orderNo,order.name,order.phone,order.email,order.pin,order.city,order.state,order.address,JSON.stringify(order.items),order.total,order.payment,order.paymentStatus,order.orderStatus,order.razorpayOrderId,order.razorpayPaymentId,order.razorpaySignature,order.placedAt,order.updatedAt]);
  return order;
}
async function updateOrder(orderNo, patch) {
  const old = await findOrder(orderNo); if (!old) return null;
  const next = {...old, ...patch, updatedAt:new Date().toISOString()};
  if (!pool) { const a=readJsonOrders(); const i=a.findIndex(o=>o.orderNo===orderNo); if(i>=0){a[i]=next;writeJsonOrders(a);} return next; }
  await pool.query(`UPDATE orders SET name=$2,phone=$3,email=$4,pin=$5,city=$6,state=$7,address=$8,items=$9,total=$10,payment=$11,payment_status=$12,order_status=$13,razorpay_order_id=$14,razorpay_payment_id=$15,razorpay_signature=$16,updated_at=$17 WHERE order_no=$1`, [orderNo,next.name,next.phone,next.email,next.pin,next.city,next.state,next.address,JSON.stringify(next.items),next.total,next.payment,next.paymentStatus,next.orderStatus,next.razorpayOrderId,next.razorpayPaymentId,next.razorpaySignature,next.updatedAt]);
  return next;
}
async function upsertCustomer(c) {
  if (!pool) return c; // customer profile is included in orders in JSON fallback
  await pool.query(`INSERT INTO customers(phone,name,email,pin,city,state,address) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,pin=EXCLUDED.pin,city=EXCLUDED.city,state=EXCLUDED.state,address=EXCLUDED.address,updated_at=NOW()`, [c.phone,c.name||'',c.email||'',c.pin||'',c.city||'',c.state||'',c.address||'']);
  return c;
}
function normaliseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error('Invalid cart.');
  return items.map(x => { const p=PRODUCTS[x.id]; const qty=Number(x.qty); if(!p || !Number.isInteger(qty)||qty<1||qty>100) throw new Error('Invalid product or quantity.'); return {id:x.id,name:p.name,size:p.size,price:p.price,qty}; });
}
function total(items){ return items.reduce((s,i)=>s+i.price*i.qty,0); }
function validateCustomer(o){ if(!o||!String(o.name||'').trim()||!/^[0-9]{10}$/.test(cleanPhone(o.phone))||!String(o.address||'').trim()||!/^[0-9]{6}$/.test(String(o.pin||''))||!String(o.city||'').trim()||!String(o.state||'').trim()) throw new Error('Please enter valid name, 10-digit phone, address, PIN, city and state.'); }
function buildOrder(input,items,t,extra={}){ const now=new Date().toISOString(); return {orderNo:input.orderNo||newOrderNo(),name:String(input.name).trim().slice(0,100),phone:cleanPhone(input.phone),email:String(input.email||'').trim().slice(0,150),pin:String(input.pin).trim(),city:String(input.city).trim().slice(0,80),state:String(input.state).trim().slice(0,80),address:String(input.address).trim().slice(0,500),items,total:t,payment:extra.payment||'COD',paymentStatus:extra.paymentStatus||'pending',orderStatus:extra.orderStatus||'New',razorpayOrderId:extra.razorpayOrderId||null,razorpayPaymentId:extra.razorpayPaymentId||null,razorpaySignature:extra.razorpaySignature||null,placedAt:now,updatedAt:now}; }
function signToken(phone,days=180){ const exp=Date.now()+days*86400000; const body=Buffer.from(JSON.stringify({phone,exp})).toString('base64url'); const sig=crypto.createHmac('sha256',process.env.SESSION_SECRET||'change-this-session-secret').update(body).digest('base64url'); return body+'.'+sig; }
function verifyToken(token){ try{const [body,sig]=String(token||'').split('.'); const expected=crypto.createHmac('sha256',process.env.SESSION_SECRET||'change-this-session-secret').update(body).digest('base64url'); if(!sig||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)) ) return null; const d=JSON.parse(Buffer.from(body,'base64url').toString()); return d.exp>Date.now()?d:null;}catch{return null;} }
function setCookie(res,name,value,maxAge){ res.setHeader('Set-Cookie',`${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`); }
function cookie(req,name){ const raw=req.headers.cookie||''; const hit=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'=')); return hit?decodeURIComponent(hit.slice(name.length+1)):''; }
async function sendWhatsAppMessage(to,body){ if(!WHATSAPP_TOKEN||!WHATSAPP_PHONE_ID)return {ok:false,skipped:true}; const r=await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body}})}); const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d?.error?.message||'WhatsApp send failed'); return {ok:true}; }
async function sendWhatsAppTemplate(to,name,language,params){ if(!WHATSAPP_TOKEN||!WHATSAPP_PHONE_ID)return {ok:false,skipped:true}; const r=await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'template',template:{name,language:{code:language},components:[{type:'body',parameters:params.map(x=>({type:'text',text:String(x)}))}]}})}); const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d?.error?.message||'WhatsApp template send failed'); return {ok:true}; }
function orderSummary(o){ return `Order ID: ${o.orderNo}\nCustomer: ${o.name}\nPhone: ${o.phone}\nAddress: ${o.address}, ${o.city}, ${o.state} - ${o.pin}\nItems: ${o.items.map(i=>`${i.name} (${i.size}) x ${i.qty}`).join(', ')}\nPayment: ${o.payment} (${o.paymentStatus})\nStatus: ${o.orderStatus}\nTotal: ₹${o.total}`; }
async function notifyOrder(order){ const text=`*MITHILANA ORDER*\n${orderSummary(order)}`; const results=[]; for(const to of [ADMIN_WHATSAPP,waPhone(order.phone)]){if(!to)continue;try{ if(to===waPhone(order.phone)) results.push(await sendWhatsAppTemplate(to,WHATSAPP_ORDER_TEMPLATE,WHATSAPP_ORDER_LANGUAGE,[order.orderNo,order.name,`₹${order.total}`,order.orderStatus])); else results.push(await sendWhatsAppMessage(to,text)); }catch(e){results.push({ok:false,error:e.message});} } return results; }
async function notifyStatus(order){ const text=`*MITHILANA ORDER STATUS UPDATE*\nOrder ${order.orderNo}\nHello ${order.name}, your order status is now: ${order.orderStatus}.\nTotal: ₹${order.total}`; const results=[]; try{results.push(await sendWhatsAppTemplate(waPhone(order.phone),WHATSAPP_STATUS_TEMPLATE,WHATSAPP_STATUS_LANGUAGE,[order.orderNo,order.name,order.orderStatus,`₹${order.total}`]));}catch(e){results.push({ok:false,error:e.message});} try{results.push(await sendWhatsAppMessage(ADMIN_WHATSAPP,text));}catch(e){results.push({ok:false,error:e.message});} return results; }
function adminAuth(req,res,next){ const t=cookie(req,'admin_session')||req.headers['x-admin-session']; if(t&&adminSessions.has(t))return next();res.status(401).json({error:'Admin login required.'}); }

app.use('/api/payment/webhook',express.raw({type:'application/json'}));
app.use(express.json({limit:'1mb'})); app.use(express.urlencoded({extended:false})); app.use(express.static(ROOT));

app.get('/api/config',(_req,res)=>res.json({razorpayKeyId:RAZORPAY_KEY_ID||null,razorpayConfigured:Boolean(RAZORPAY_KEY_ID&&RAZORPAY_KEY_SECRET),customerLoginEnabled:Boolean(WHATSAPP_TOKEN&&WHATSAPP_PHONE_ID)}));

// Meta WhatsApp webhook: instant canned replies for common customer enquiries.
app.get('/api/whatsapp/webhook',(req,res)=>{if(!WHATSAPP_VERIFY_TOKEN)return res.sendStatus(404);if(req.query['hub.verify_token']!==WHATSAPP_VERIFY_TOKEN)return res.sendStatus(403);res.type('text/plain').send(req.query['hub.challenge']||'');});
app.post('/api/whatsapp/webhook',async(req,res)=>{res.sendStatus(200);try{const changes=req.body?.entry?.flatMap(e=>e.changes||[])||[];for(const ch of changes){const msgs=ch.value?.messages||[];for(const m of msgs){if(m.type!=='text'||!m.from)continue;const text=String(m.text?.body||'').toLowerCase();let reply='Namaste! 🙏 Mithilana Makhana mein aapka swagat hai. Aap product, price, order ya bulk/private-label enquiry bhej sakte hain. Hum jaldi reply karenge.';if(text.includes('price')||text.includes('product'))reply='Namaste! 🙏 Aap website par available makhana sizes/prices dekh sakte hain. Agar aap quantity ya kisi specific product ke baare mein poochna chahte hain, details bhej dijiye.';else if(text.includes('order'))reply='Namaste! 🙏 Website par order place kar sakte hain. Order ke baad confirmation aur status updates WhatsApp par milenge.';else if(text.includes('bulk')||text.includes('private'))reply='Namaste! 🙏 Bulk / Private Label enquiry ke liye quantity, packaging aur requirement bhej dijiye. Team aapse details ke saath contact karegi.';try{await sendWhatsAppMessage(m.from,reply);}catch(_){} }}}catch(_){}});

// Customer WhatsApp OTP login. OTP is short-lived and never returned to the browser.
app.post('/api/auth/request-otp',async(req,res)=>{try{const phone=cleanPhone(req.body?.phone);if(!/^\d{10}$/.test(phone))return res.status(400).json({error:'Enter a valid 10-digit WhatsApp number.'});if(!WHATSAPP_TOKEN||!WHATSAPP_PHONE_ID)return res.status(503).json({error:'WhatsApp OTP is not configured yet.'});const now=Date.now();const prev=otpChallenges.get(phone);if(prev&&now-prev.createdAt<60000)return res.status(429).json({error:'Please wait 60 seconds before requesting another OTP.'});const otp=String(crypto.randomInt(100000,1000000));otpChallenges.set(phone,{otp,createdAt:now,expiresAt:now+5*60000,attempts:0});await sendWhatsAppTemplate('91'+phone,WHATSAPP_OTP_TEMPLATE,WHATSAPP_OTP_LANGUAGE,[otp]);res.json({ok:true,message:'OTP sent to WhatsApp.'});}catch(e){res.status(502).json({error:e.message||'Could not send OTP.'});}});
app.post('/api/auth/verify-otp',async(req,res)=>{try{const phone=cleanPhone(req.body?.phone),otp=String(req.body?.otp||'').trim(),c=otpChallenges.get(phone);if(!/^\d{10}$/.test(phone)||!/^[0-9]{6}$/.test(otp)||!c||c.expiresAt<Date.now()||c.attempts>=5||c.otp!==otp){if(c)c.attempts++;return res.status(400).json({error:'Invalid or expired OTP.'});}otpChallenges.delete(phone);setCookie(res,'customer_session',signToken(phone),180*86400);res.json({ok:true,phone});}catch(e){res.status(400).json({error:'Could not verify OTP.'});}});
app.get('/api/auth/me',async(req,res)=>{const d=verifyToken(cookie(req,'customer_session'));if(!d)return res.status(401).json({loggedIn:false});res.json({loggedIn:true,phone:d.phone});});
app.get('/api/customer/me',async(req,res)=>{const d=verifyToken(cookie(req,'customer_session'));if(!d)return res.status(401).json({error:'Login required.'});const orders=(await getOrders()).filter(o=>o.phone===d.phone);const o=orders[0];res.json({loggedIn:true,phone:d.phone,profile:o?{name:o.name,email:o.email,pin:o.pin,city:o.city,state:o.state,address:o.address}:null});});
app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie','customer_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true});});

app.post('/api/payment/create-order',async(req,res)=>{try{if(!RAZORPAY_KEY_ID||!RAZORPAY_KEY_SECRET)return res.status(503).json({error:'Razorpay online payment is not configured yet.'});const auth=verifyToken(cookie(req,'customer_session'));if(!auth||auth.phone!==cleanPhone(req.body.phone))return res.status(401).json({error:'Please login with WhatsApp OTP before ordering.'});validateCustomer(req.body);const items=normaliseItems(req.body.items),t=total(items),orderNo=newOrderNo();const r=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify({amount:Math.round(t*100),currency:'INR',receipt:orderNo,notes:{mithilana_order_id:orderNo}})});const d=await r.json().catch(()=>({}));if(!r.ok||!d?.id)return res.status(502).json({error:d?.error?.description||'Could not start Razorpay payment.'});const order=buildOrder({...req.body,orderNo},items,t,{payment:'Razorpay Online Payment',paymentStatus:'created',orderStatus:'Payment Pending',razorpayOrderId:d.id});await saveOrder(order);await upsertCustomer(order);res.json({ok:true,orderId:orderNo,razorpayOrderId:d.id,keyId:RAZORPAY_KEY_ID,amount:Math.round(t*100),amountRupees:t.toFixed(2),name:order.name,email:order.email,phone:order.phone});}catch(e){res.status(400).json({error:e.message||'Could not create Razorpay payment order.'});}});
app.post('/api/payment/verify',async(req,res)=>{try{const {orderNo,razorpayOrderId,razorpayPaymentId,razorpaySignature}=req.body||{};const order=await findOrder(orderNo);const auth=verifyToken(cookie(req,'customer_session'));if(!order||!auth||auth.phone!==order.phone)return res.status(401).json({error:'Unauthorized payment verification.'});if(order.razorpayOrderId!==razorpayOrderId||!razorpayPaymentId||!razorpaySignature)return res.status(400).json({error:'Payment verification details are invalid.'});if(order.paymentStatus==='paid')return res.json({ok:true,orderId:orderNo,status:'PAID'});const expected=crypto.createHmac('sha256',RAZORPAY_KEY_SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');if(expected!==razorpaySignature){await updateOrder(orderNo,{paymentStatus:'failed',orderStatus:'Payment Failed'});return res.status(400).json({error:'Payment signature verification failed.'});}const pr=await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpayPaymentId)}`,{headers:{Authorization:'Basic '+Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}});const p=await pr.json().catch(()=>({}));if(!pr.ok||p.order_id!==razorpayOrderId||Number(p.amount)!==Math.round(order.total*100)||p.currency!=='INR'||p.status!=='captured')return res.status(400).json({error:'Razorpay payment could not be fully verified.'});const updated=await updateOrder(orderNo,{paymentStatus:'paid',orderStatus:'New',razorpayPaymentId,razorpaySignature});try{await notifyOrder(updated);}catch(_){}res.json({ok:true,orderId:orderNo,status:'PAID'});}catch(e){res.status(500).json({error:'Razorpay payment verification failed.'});}});
app.post('/api/payment/webhook',async(req,res)=>{try{if(!RAZORPAY_WEBHOOK_SECRET)return res.status(503).send('Webhook not configured.');const sig=req.headers['x-razorpay-signature']||'',expected=crypto.createHmac('sha256',RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');if(sig!==expected)return res.status(400).send('Invalid signature');const payload=JSON.parse(req.body.toString());if(payload?.event==='payment.captured'){const p=payload.payload?.payment?.entity,o=(await getOrders()).find(x=>x.razorpayOrderId===p?.order_id);if(o&&o.paymentStatus!=='paid'&&Number(p.amount)===Math.round(o.total*100)&&p.currency==='INR'){const u=await updateOrder(o.orderNo,{paymentStatus:'paid',orderStatus:'New',razorpayPaymentId:p.id});try{await notifyOrder(u);}catch(_) {}}}res.json({ok:true});}catch(e){res.status(400).send('Invalid webhook payload');}});

app.post('/api/orders',async(req,res)=>{try{const auth=verifyToken(cookie(req,'customer_session'));if(!auth||auth.phone!==cleanPhone(req.body.phone))return res.status(401).json({error:'Please login with WhatsApp OTP before placing an order.'});validateCustomer(req.body);const items=normaliseItems(req.body.items),t=total(items),order=buildOrder(req.body,items,t,{payment:'COD',paymentStatus:'pending',orderStatus:'New'});await saveOrder(order);await upsertCustomer(order);let whatsapp={};try{whatsapp=await notifyOrder(order);}catch(e){whatsapp={ok:false,error:e.message};}res.json({ok:true,orderId:order.orderNo,whatsapp});}catch(e){res.status(400).json({error:e.message||'Could not create order.'});}});

app.post('/api/admin/login',(req,res)=>{if(!ADMIN_PASSWORD)return res.status(503).json({error:'Admin password is not configured on the server.'});if(req.body?.password!==ADMIN_PASSWORD)return res.status(401).json({error:'Incorrect admin password.'});const t=crypto.randomBytes(32).toString('hex');adminSessions.set(t,Date.now());setTimeout(()=>adminSessions.delete(t),12*3600000);setCookie(res,'admin_session',t,43200);res.json({ok:true});});
app.post('/api/admin/logout',adminAuth,(req,res)=>{adminSessions.delete(cookie(req,'admin_session'));res.setHeader('Set-Cookie','admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/admin/orders',adminAuth,async(_req,res)=>{const orders=await getOrders();res.json({summary:{totalOrders:orders.length,paidRevenue:orders.filter(o=>o.paymentStatus==='paid').reduce((s,o)=>s+o.total,0),pendingPayments:orders.filter(o=>['pending','created'].includes(o.paymentStatus)).length,activeOrders:orders.filter(o=>!['Delivered','Cancelled'].includes(o.orderStatus)).length},orders});});
app.patch('/api/admin/orders/:orderNo',adminAuth,async(req,res)=>{if(!STATUS.includes(req.body?.orderStatus))return res.status(400).json({error:'Invalid order status.'});const old=await findOrder(req.params.orderNo);if(!old)return res.status(404).json({error:'Order not found.'});if(old.orderStatus===req.body.orderStatus)return res.json({ok:true,order:old});const updated=await updateOrder(req.params.orderNo,{orderStatus:req.body.orderStatus});try{await notifyStatus(updated);}catch(_){}res.json({ok:true,order:updated});});

app.get('/admin',(_req,res)=>res.sendFile(path.join(ROOT,'admin.html')));
// WhatsApp Webhook Setup
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === "mithilana_secret_token_123") {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
});
app.get('*',(_req,res)=>res.sendFile(path.join(ROOT,'index.html')));
initDb().then(()=>app.listen(PORT,()=>console.log(`Mithilana server running on port ${PORT}${pool?' with PostgreSQL':' with JSON storage'}`))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1);});
