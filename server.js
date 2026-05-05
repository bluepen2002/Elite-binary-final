require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const MPESA_ENV = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
const MPESA_HOST = MPESA_ENV === 'production' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';
const MOCK_PAYMENTS = process.env.MOCK_PAYMENTS === 'false' ? false : true;

const defaultDb = {
  config: {
    settlementMode: 'fair_server',
    payoutRate: 0.9,
    winProbability: 0.5,
    settlementDelayMs: 900,
    designatedWallet: 'NCBA Loop 440200250861 / Channel ID 7598',
    mockPayments: MOCK_PAYMENTS
  },
  users: [],
  deposits: [],
  withdrawals: [],
  trades: [],
  ledger: []
};

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb, null, 2));
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.config = { ...defaultDb.config, ...(db.config || {}) };
  for (const key of ['users', 'deposits', 'withdrawals', 'trades', 'ledger']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function now() {
  return new Date().toISOString();
}

function findUser(db, userId) {
  return db.users.find((u) => u.id === userId);
}

function settleContract(contractType, params = {}, config = {}) {
  const type = String(contractType || '').toUpperCase();
  const configuredProbability = Number(config.winProbability);
  const probability = Number.isFinite(configuredProbability)
    ? Math.min(0.99, Math.max(0.01, configuredProbability))
    : null;
  if (probability !== null) {
    return {
      won: Math.random() < probability,
      outcome: { settlement: 'server_probability', winProbability: probability }
    };
  }
  const digit = crypto.randomInt(0, 10);
  const direction = crypto.randomInt(0, 2) === 1 ? 'up' : 'down';
  const barrier = Number(params.barrier);

  if (type === 'DIGITEVEN') return { won: digit % 2 === 0, outcome: { digit } };
  if (type === 'DIGITODD') return { won: digit % 2 === 1, outcome: { digit } };
  if (type === 'DIGITMATCH') return { won: digit === barrier, outcome: { digit, barrier } };
  if (type === 'DIGITDIFF') return { won: digit !== barrier, outcome: { digit, barrier } };
  if (type === 'DIGITOVER') return { won: digit > barrier, outcome: { digit, barrier } };
  if (type === 'DIGITUNDER') return { won: digit < barrier, outcome: { digit, barrier } };
  if (['CALL', 'MULTUP', 'ASIANU', 'RESETCALL', 'TICKHIGH', 'LBFLOATCALL'].includes(type)) {
    return { won: direction === 'up', outcome: { direction } };
  }
  if (['PUT', 'MULTDOWN', 'ASIAND', 'RESETPUT', 'TICKLOW', 'LBFLOATPUT'].includes(type)) {
    return { won: direction === 'down', outcome: { direction } };
  }

  return { won: crypto.randomInt(0, 2) === 1, outcome: { settlement: 'server_fair_random' } };
}

function ledger(db, entry) {
  db.ledger.push({
    id: id('led'),
    createdAt: now(),
    ...entry,
    amount: money(entry.amount),
    balanceAfter: money(entry.balanceAfter)
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(payload);
}

function providerRequest(method, requestPath, payload, token) {
  return new Promise((resolve, reject) => {
    const raw = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      hostname: MPESA_HOST,
      path: requestPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.errorMessage || parsed.ResponseDescription || `M-Pesa request failed with ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

async function mpesaToken() {
  const basicAuth = process.env.MPESA_BASIC_AUTH;
  if (basicAuth) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: MPESA_HOST,
        path: '/oauth/v1/generate?grant_type=client_credentials',
        method: 'GET',
        headers: { Authorization: `Basic ${basicAuth}` }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
          if (parsed.access_token) return resolve(parsed.access_token);
          reject(new Error(parsed.errorMessage || 'Unable to get M-Pesa access token'));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('M-Pesa credentials are not configured');
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MPESA_HOST,
      path: '/oauth/v1/generate?grant_type=client_credentials',
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
        if (parsed.access_token) return resolve(parsed.access_token);
        reject(new Error(parsed.errorMessage || 'Unable to get M-Pesa access token'));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function mpesaTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  return digits;
}

async function initiateStkPush({ amount, phone, accountReference }) {
  const shortCode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  if (!shortCode || !passkey || !callbackUrl) throw new Error('M-Pesa STK settings are not configured');
  const timestamp = mpesaTimestamp();
  const token = await mpesaToken();
  return providerRequest('POST', '/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: shortCode,
    Password: Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64'),
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: normalizePhone(phone),
    PartyB: shortCode,
    PhoneNumber: normalizePhone(phone),
    CallBackURL: callbackUrl,
    AccountReference: accountReference,
    TransactionDesc: 'Elite Binary deposit'
  }, token);
}

async function sendB2cPayment({ amount, destination, reference }) {
  const shortCode = process.env.MPESA_B2C_SHORTCODE;
  const initiatorName = process.env.MPESA_B2C_INITIATOR_NAME;
  const securityCredential = process.env.MPESA_B2C_SECURITY_CREDENTIAL;
  const resultUrl = process.env.MPESA_B2C_RESULT_URL;
  const timeoutUrl = process.env.MPESA_B2C_TIMEOUT_URL || resultUrl;
  if (!shortCode || !initiatorName || !securityCredential || !resultUrl) {
    throw new Error('M-Pesa B2C settings are not configured');
  }
  const token = await mpesaToken();
  return providerRequest('POST', '/mpesa/b2c/v3/paymentrequest', {
    OriginatorConversationID: reference,
    InitiatorName: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: 'BusinessPayment',
    Amount: Math.round(Number(amount)),
    PartyA: shortCode,
    PartyB: normalizePhone(destination),
    Remarks: 'Elite Binary withdrawal',
    QueueTimeOutURL: timeoutUrl,
    ResultURL: resultUrl,
    Occasion: 'Withdrawal'
  }, token);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function requireAdmin(req, res) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    send(res, 401, { error: 'Invalid admin key' });
    return false;
  }
  return true;
}

async function routeApi(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { config: db.config });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await parseBody(req);
      const identifier = String(body.identifier || '').trim();
      if (!identifier) return send(res, 400, { error: 'Identifier is required' });

      let user = db.users.find((u) => u.identifier === identifier);
      if (!user) {
        user = {
          id: id('usr'),
          identifier,
          name: String(body.name || identifier).trim(),
          balance: body.demo ? 10000 : 0,
          demo: Boolean(body.demo),
          createdAt: now()
        };
        db.users.push(user);
        ledger(db, {
          userId: user.id,
          type: body.demo ? 'demo_credit' : 'wallet_opened',
          amount: user.balance,
          balanceAfter: user.balance,
          reference: 'initial'
        });
      }
      writeDb(db);
      return send(res, 200, { user });
    }

    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      const user = findUser(db, url.searchParams.get('userId'));
      if (!user) return send(res, 404, { error: 'User not found' });
      return send(res, 200, { user, ledger: db.ledger.filter((l) => l.userId === user.id).slice(-50) });
    }

    if (req.method === 'POST' && url.pathname === '/api/deposits') {
      const body = await parseBody(req);
      const user = findUser(db, body.userId);
      const amount = money(body.amount);
      if (!user) return send(res, 404, { error: 'User not found' });
      if (amount <= 0) return send(res, 400, { error: 'Deposit amount must be greater than zero' });
      if (String(body.method || 'mpesa') === 'mpesa' && !String(body.phone || '').trim()) {
        return send(res, 400, { error: 'M-Pesa phone number is required' });
      }

      const deposit = {
        id: id('dep'),
        userId: user.id,
        method: String(body.method || 'mpesa'),
        phone: String(body.phone || '').trim(),
        amount,
        status: db.config.mockPayments ? 'completed' : 'pending_stk',
        providerReference: null,
        wallet: db.config.designatedWallet,
        createdAt: now()
      };

      if (!db.config.mockPayments && deposit.method === 'mpesa') {
        const stk = await initiateStkPush({ amount, phone: deposit.phone, accountReference: deposit.id });
        deposit.providerReference = stk.CheckoutRequestID || stk.MerchantRequestID || id('stk');
        deposit.providerResponse = stk;
      } else {
        deposit.providerReference = id('stk');
      }

      db.deposits.push(deposit);

      if (deposit.status === 'completed') {
        user.balance = money(user.balance + amount);
        ledger(db, {
          userId: user.id,
          type: 'deposit',
          amount,
          balanceAfter: user.balance,
          reference: deposit.id
        });
      }

      writeDb(db);
      return send(res, 200, {
        deposit,
        user,
        message: db.config.mockPayments
          ? 'Mock STK push completed and wallet credited.'
          : 'STK push initiated. Credit wallet from the provider callback.'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/mpesa/stk-callback') {
      const body = await parseBody(req);
      const callback = body.Body && body.Body.stkCallback ? body.Body.stkCallback : body.stkCallback || body;
      const checkoutId = callback.CheckoutRequestID;
      const resultCode = Number(callback.ResultCode);
      const deposit = db.deposits.find((d) => d.providerReference === checkoutId);
      if (!deposit) return send(res, 200, { ok: true, ignored: true });
      deposit.callback = callback;
      deposit.status = resultCode === 0 ? 'completed' : 'failed';
      if (resultCode === 0) {
        const user = findUser(db, deposit.userId);
        if (user && !db.ledger.some((l) => l.reference === deposit.id && l.type === 'deposit')) {
          user.balance = money(user.balance + deposit.amount);
          ledger(db, {
            userId: user.id,
            type: 'deposit',
            amount: deposit.amount,
            balanceAfter: user.balance,
            reference: deposit.id
          });
        }
      }
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/trades') {
      const body = await parseBody(req);
      const user = findUser(db, body.userId);
      const stake = money(body.stake);
      if (!user) return send(res, 404, { error: 'User not found' });
      if (stake <= 0) return send(res, 400, { error: 'Stake must be greater than zero' });
      if (user.balance < stake) return send(res, 400, { error: 'Insufficient wallet balance' });

      user.balance = money(user.balance - stake);
      ledger(db, {
        userId: user.id,
        type: 'trade_stake',
        amount: -stake,
        balanceAfter: user.balance,
        reference: body.contractType || 'trade'
      });

      const settlement = settleContract(body.contractType, body.params, db.config);
      const won = settlement.won;
      const profit = won ? money(stake * Number(db.config.payoutRate)) : -stake;
      if (won) {
        const credit = money(stake + profit);
        user.balance = money(user.balance + credit);
        ledger(db, {
          userId: user.id,
          type: 'trade_payout',
          amount: credit,
          balanceAfter: user.balance,
          reference: body.contractType || 'trade'
        });
      }

      const trade = {
        id: id('trd'),
        userId: user.id,
        contractType: String(body.contractType || 'UNKNOWN'),
        symbol: String(body.symbol || 'UNKNOWN'),
        stake,
        won,
        profit,
        outcome: settlement.outcome,
        balanceAfter: user.balance,
        createdAt: now()
      };
      db.trades.push(trade);
      writeDb(db);
      return send(res, 200, { trade, user, config: db.config });
    }

    if (req.method === 'POST' && url.pathname === '/api/withdrawals') {
      const body = await parseBody(req);
      const user = findUser(db, body.userId);
      const amount = money(body.amount);
      if (!user) return send(res, 404, { error: 'User not found' });
      if (amount <= 0) return send(res, 400, { error: 'Withdrawal amount must be greater than zero' });
      if (user.balance < amount) return send(res, 400, { error: 'Insufficient wallet balance' });

      user.balance = money(user.balance - amount);
      const withdrawal = {
        id: id('wd'),
        userId: user.id,
        method: String(body.method || 'mpesa'),
        destination: String(body.destination || '').trim(),
        amount,
        status: db.config.mockPayments ? 'paid' : 'processing',
        providerReference: id('pay'),
        createdAt: now()
      };
      if (!db.config.mockPayments && withdrawal.method.toLowerCase().includes('mpesa')) {
        const payment = await sendB2cPayment({ amount, destination: withdrawal.destination, reference: withdrawal.id });
        withdrawal.status = 'processing';
        withdrawal.providerReference = payment.OriginatorConversationID || withdrawal.id;
        withdrawal.providerResponse = payment;
      }
      db.withdrawals.push(withdrawal);
      ledger(db, {
        userId: user.id,
        type: 'withdrawal',
        amount: -amount,
        balanceAfter: user.balance,
        reference: withdrawal.id
      });
      writeDb(db);
      return send(res, 200, { withdrawal, user });
    }

    if (req.method === 'POST' && url.pathname === '/api/mpesa/b2c-result') {
      const body = await parseBody(req);
      const result = body.Result || body;
      const reference = result.OriginatorConversationID || result.ConversationID;
      const withdrawal = db.withdrawals.find((w) => w.id === reference || w.providerReference === reference);
      if (!withdrawal) return send(res, 200, { ok: true, ignored: true });
      withdrawal.callback = result;
      if (Number(result.ResultCode) === 0) {
        withdrawal.status = 'paid';
      } else {
        withdrawal.status = 'failed';
        const user = findUser(db, withdrawal.userId);
        if (user && !db.ledger.some((l) => l.reference === `${withdrawal.id}:refund`)) {
          user.balance = money(user.balance + withdrawal.amount);
          ledger(db, {
            userId: user.id,
            type: 'withdrawal_refund',
            amount: withdrawal.amount,
            balanceAfter: user.balance,
            reference: `${withdrawal.id}:refund`
          });
        }
      }
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, {
        config: db.config,
        users: db.users,
        deposits: db.deposits.slice(-100),
        withdrawals: db.withdrawals.slice(-100),
        trades: db.trades.slice(-100),
        ledger: db.ledger.slice(-200)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/config') {
      if (!requireAdmin(req, res)) return;
      const body = await parseBody(req);
      if (body.payoutRate !== undefined) {
        db.config.payoutRate = Math.min(10, Math.max(0.01, Number(body.payoutRate)));
      }
      if (body.winProbability !== undefined) {
        db.config.winProbability = Math.min(0.99, Math.max(0.01, Number(body.winProbability)));
      }
      if (body.settlementDelayMs !== undefined) {
        db.config.settlementDelayMs = Math.min(30000, Math.max(0, Number(body.settlementDelayMs)));
      }
      if (body.designatedWallet !== undefined) {
        db.config.designatedWallet = String(body.designatedWallet).trim();
      }
      if (body.mockPayments !== undefined) {
        db.config.mockPayments = Boolean(body.mockPayments);
      }
      writeDb(db);
      return send(res, 200, { config: db.config });
    }

    return send(res, 404, { error: 'API route not found' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'Server error' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return routeApi(req, res);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  }

  const filePath = path.normalize(path.join(__dirname, url.pathname));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
  return serveFile(res, filePath, type);
});

ensureDb();
server.listen(PORT, () => {
  console.log(`\n✅ Elite Binary backend running at http://localhost:${PORT}`);
  console.log(`🔐 Admin key: ${ADMIN_KEY}`);
  console.log(`🔴 Mode: ${MOCK_PAYMENTS ? 'MOCK (Testing)' : 'REAL M-Pesa (Live)'}`);
  console.log(`💳 Wallet: NCBA Loop 440200250861 / Channel ID 7598`);
  console.log(`🌍 Environment: ${MPESA_ENV}\n`);
});
