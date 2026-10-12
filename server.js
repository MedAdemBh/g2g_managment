import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { connectDB, User, Item, Withdrawal, ActivityLog, seedInitialUsersIfEmpty } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  // Read-only filesystem in serverless environments
}

// Initial demo seed data
const getInitialSeedData = () => {
  return {
    users: [
      {
        id: 'usr_seller_adem',
        name: 'Adem (Seller 1)',
        role: 'seller',
        g2gStoreName: 'AdemVault_G2G',
        commissionRate: 10,
        balance: 0.00,
        avatarColor: '#00f0ff'
      },
      {
        id: 'usr_seller_amine',
        name: 'Amine (Seller 2)',
        role: 'seller',
        g2gStoreName: 'AmineMarket_G2G',
        commissionRate: 10,
        balance: 0.00,
        avatarColor: '#ffb703'
      },
      {
        id: 'usr_supplier_aymen',
        name: 'Aymen (User / Supplier)',
        role: 'supplier',
        g2gStoreName: '',
        commissionRate: 0,
        balance: 0.00,
        avatarColor: '#10b981'
      },
      {
        id: 'usr_supplier_hmayma',
        name: 'Hmayma (User / Supplier)',
        role: 'supplier',
        g2gStoreName: '',
        commissionRate: 0,
        balance: 0.00,
        avatarColor: '#8b5cf6'
      },
      {
        id: 'usr_admin',
        name: 'Admin (Manager)',
        role: 'admin',
        g2gStoreName: 'Main Store Operations',
        commissionRate: 0,
        balance: 0.00,
        avatarColor: '#ec4899'
      }
    ],
    items: [],
    withdrawals: [],
    activityLogs: []
  };
};

// Database persistence helper for local JSON mode
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error reading store file, falling back to seed data:', err);
  }
  const seed = getInitialSeedData();
  saveData(seed);
  return seed;
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving store file:', err);
  }
}

let store = loadData();

// If MongoDB URI is configured, seed initial users if collection is empty
if (process.env.MONGODB_URI) {
  connectDB().then(() => {
    seedInitialUsersIfEmpty(getInitialSeedData().users);
  }).catch((err) => {
    console.error('MongoDB Atlas initialization error:', err);
  });
}

// Unified state loader (MongoDB Atlas or local JSON)
async function getFullState() {
  if (process.env.MONGODB_URI) {
    await connectDB();
    const [users, items, withdrawals, activityLogs] = await Promise.all([
      User.find({}, '-_id -__v -email').lean(),
      Item.find({}, '-_id -__v').sort({ createdAt: -1 }).lean(),
      Withdrawal.find({}, '-_id -__v').sort({ createdAt: -1 }).lean(),
      ActivityLog.find({}, '-_id -__v').sort({ timestamp: -1 }).limit(50).lean()
    ]);
    return { users, items, withdrawals, activityLogs };
  }
  return store;
}

// WebSocket broadcast helper
async function broadcastUpdate(actionType, detail = '', actor = '') {
  const currentState = await getFullState();
  const payload = JSON.stringify({
    type: 'STATE_UPDATE',
    actionType,
    detail,
    actor,
    timestamp: new Date().toISOString(),
    state: currentState
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

async function logActivity(type, actorName, message) {
  const logItem = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    type,
    actorName,
    message
  };

  if (process.env.MONGODB_URI) {
    try {
      await connectDB();
      await ActivityLog.create(logItem);
    } catch (e) {
      console.error('Error logging to MongoDB:', e);
    }
  } else {
    store.activityLogs.unshift(logItem);
    if (store.activityLogs.length > 50) store.activityLogs.pop();
  }
}

// Expose ARC Raiders catalog
app.get('/api/catalog', (req, res) => {
  const catalogPath = path.join(DATA_DIR, 'catalog.json');
  if (fs.existsSync(catalogPath)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      return res.json({ success: true, catalog: cat });
    } catch (e) {}
  }
  res.json({ success: true, catalog: {} });
});

// G2G Live Market Price Checker (Top 5 Lowest Prices for ARC Raiders)
const g2gPriceCache = new Map();
const CACHE_TTL_MS = 20 * 1000; // 20-second cache ensures every 30s auto-refresh pulls fresh market prices

async function fetchG2GLowestOffer(query, forceFresh = false) {
  const trimmed = (query || '').trim();
  if (!trimmed) return null;

  const cacheKey = trimmed.toLowerCase();
  const cached = g2gPriceCache.get(cacheKey);
  if (!forceFresh && cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return { ...cached.data, fromCache: true };
  }

  try {
    const url = `https://sls.g2g.com/offer/search?service_id=0765978e-3fdf-48b4-bed3-184823aa439e&brand_id=lgc_game_35181&country=US&currency=USD&q=${encodeURIComponent(trimmed)}&group=0&sort=lowest_price`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const rawResults = data?.payload?.results || [];

    const cleanQ = trimmed.toLowerCase().replace(/[\s\-_]/g, '');
    let rawOffers = rawResults;

    // Isolate genuine individual catalog item offers (e.g., "All Platform > Quick Use > Showstopper")
    const catalogMatches = rawResults.filter((r) => {
      if (!r.title || !r.title.includes('>')) return false;
      const lastPart = r.title.split('>').pop().trim().toLowerCase().replace(/[\s\-_]/g, '');
      return lastPart === cleanQ || lastPart.includes(cleanQ);
    });

    if (catalogMatches.length > 0) {
      rawOffers = catalogMatches;
    } else {
      // Exclude multi-item bundles or promotional spam packs
      const nonBundles = rawResults.filter((r) => {
        return !/bundle|pack\b|pvp|tier|k\/m\b/i.test(r.title || '');
      });
      if (nonBundles.length > 0) rawOffers = nonBundles;
    }

    const offers = rawOffers.map((r) => {
      const price = parseFloat(r.converted_unit_price || r.display_price || r.unit_price || 0);
      const formattedPrice = price > 0 && price < 0.10
        ? `$${price.toFixed(3)}`
        : `$${price.toFixed(2)}`;
      return {
        price,
        formattedPrice,
        title: r.title,
        sellerName: r.username,
        sellerRating: r.satisfaction_rate ? `${(r.satisfaction_rate * 100).toFixed(1)}%` : '100%',
        sellerOrders: r.total_success_order || r.total_rating || 0,
        sellerRanking: r.seller_ranking || '1',
        availableQty: r.available_qty || 1,
        offerId: r.offer_id,
        url: `https://www.g2g.com/offer/${r.offer_id}`
      };
    }).filter((o) => o.price > 0).sort((a, b) => a.price - b.price);

    const top5 = offers.slice(0, 5).map((o, idx) => ({ rank: idx + 1, ...o }));
    const lowestOffer = top5.length ? top5[0] : null;
    const lowestPrice = lowestOffer ? lowestOffer.price : 0;
    const formattedLowestPrice = lowestOffer ? lowestOffer.formattedPrice : '$0.00';
    const avgPrice = top5.length ? (top5.reduce((acc, curr) => acc + curr.price, 0) / top5.length) : 0;
    const recommendedPrice = lowestPrice > 0.05 ? Math.max(0.01, +(lowestPrice - 0.01).toFixed(2)) : +(lowestPrice * 0.95).toFixed(3);

    const resultPayload = {
      query: trimmed,
      game: 'ARC Raiders',
      totalFound: rawOffers.length,
      lowestPrice: +lowestPrice.toFixed(4),
      formattedLowestPrice,
      lowestSeller: lowestOffer ? {
        name: lowestOffer.sellerName,
        rating: lowestOffer.sellerRating,
        orders: lowestOffer.sellerOrders,
        stock: lowestOffer.availableQty,
        url: lowestOffer.url
      } : null,
      averagePrice: +avgPrice.toFixed(3),
      formattedAveragePrice: `$${avgPrice.toFixed(avgPrice < 0.10 ? 3 : 2)}`,
      recommendedPrice,
      formattedRecommendedPrice: `$${recommendedPrice.toFixed(recommendedPrice < 0.10 ? 3 : 2)}`,
      top5,
      fetchedAt: new Date().toISOString()
    };

    g2gPriceCache.set(cacheKey, { timestamp: Date.now(), data: resultPayload });
    return resultPayload;
  } catch (err) {
    return {
      query: trimmed,
      game: 'ARC Raiders',
      error: err.message,
      lowestPrice: 0,
      formattedLowestPrice: '$0.00',
      lowestSeller: null,
      averagePrice: 0,
      formattedAveragePrice: '$0.00',
      recommendedPrice: 0,
      formattedRecommendedPrice: '$0.00',
      totalFound: 0,
      top5: [],
      fetchedAt: new Date().toISOString()
    };
  }
}

// Single item price check
app.get('/api/g2g-prices', async (req, res) => {
  const query = (req.query.query || req.query.q || '').trim();
  const forceFresh = req.query.fresh === 'true' || req.query.forceFresh === 'true';
  if (!query) {
    return res.status(400).json({ success: false, error: 'Query parameter is required' });
  }

  const result = await fetchG2GLowestOffer(query, forceFresh);
  if (result.error && (!result.top5 || result.top5.length === 0)) {
    return res.status(500).json({ success: false, ...result });
  }
  return res.json({ success: true, ...result });
});

// Multi-item price batch check (choose multiple products at once)
app.post('/api/g2g-prices/batch', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : (Array.isArray(req.body.queries) ? req.body.queries : []);
  const cleanItems = items.map((it) => (typeof it === 'string' ? it.trim() : '')).filter(Boolean).slice(0, 30);
  const forceFresh = req.body.fresh === true || req.body.forceFresh === true;

  if (cleanItems.length === 0) {
    return res.status(400).json({ success: false, error: 'Provide at least one item name in the items array.' });
  }

  const results = await Promise.all(cleanItems.map((query) => fetchG2GLowestOffer(query, forceFresh)));
  return res.json({ success: true, count: results.length, results });
});

// 1. Get entire state
app.get('/api/state', async (req, res) => {
  try {
    const currentState = await getFullState();
    res.json({ success: true, state: currentState, data: currentState });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add or update user fee
app.put('/api/users/:id/fee', async (req, res) => {
  const { id } = req.params;
  const { commissionRate } = req.body;
  const newRate = parseFloat(commissionRate) || 0;

  if (process.env.MONGODB_URI) {
    await connectDB();
    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    user.commissionRate = newRate;
    await user.save();
    await logActivity('FEE_UPDATED', user.name, `${user.name} updated seller fee to ${newRate}%`);
    await broadcastUpdate('FEE_UPDATED', `${user.name} set seller fee to ${newRate}%`, user.name);
    return res.json({ success: true, user });
  } else {
    const user = store.users.find((u) => u.id === id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    user.commissionRate = newRate;
    await logActivity('FEE_UPDATED', user.name, `${user.name} updated seller fee to ${newRate}%`);
    saveData(store);
    await broadcastUpdate('FEE_UPDATED', `${user.name} set seller fee to ${newRate}%`, user.name);
    return res.json({ success: true, user });
  }
});

// Create member
app.post('/api/users', async (req, res) => {
  const { name, email, role, g2gStoreName, commissionRate } = req.body;
  if (!name || !role) {
    return res.status(400).json({ success: false, error: 'Name and role are required' });
  }

  const palette = ['#00f0ff', '#ffb703', '#ec4899', '#10b981', '#8b5cf6', '#3b82f6', '#f43f5e'];
  const randomColor = palette[Math.floor(Math.random() * palette.length)];

  const newUser = {
    id: `usr_${Date.now()}`,
    name,
    email: email || `${name.toLowerCase().replace(/\s+/g, '')}@market.com`,
    role,
    g2gStoreName: g2gStoreName || (role === 'seller' ? `${name}_G2G` : ''),
    commissionRate: Number(commissionRate) || (role === 'seller' ? 10 : 0),
    balance: 0,
    avatarColor: randomColor
  };

  if (process.env.MONGODB_URI) {
    await connectDB();
    await User.create(newUser);
  } else {
    store.users.push(newUser);
    saveData(store);
  }

  await logActivity('USER_ADDED', 'System / Admin', `Added new ${role.toUpperCase()}: ${newUser.name}`);
  await broadcastUpdate('USER_ADDED', `New user added: ${newUser.name}`, 'System');
  res.json({ success: true, user: newUser });
});

// 3. User deposits offer
app.post('/api/items', async (req, res) => {
  const {
    title,
    category,
    quantity,
    supplierId,
    supplierTargetPrice,
    secretCredentials,
    notes,
    createdByName
  } = req.body;

  if (!title || !category || !supplierId || !supplierTargetPrice) {
    return res.status(400).json({ success: false, error: 'Missing required item fields' });
  }

  let supplierName = 'User';
  if (process.env.MONGODB_URI) {
    await connectDB();
    const sup = await User.findOne({ id: supplierId }).lean();
    if (sup) supplierName = sup.name;
  } else {
    const sup = store.users.find((u) => u.id === supplierId);
    if (sup) supplierName = sup.name;
  }

  const sPrice = parseFloat(supplierTargetPrice) || 0;
  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  const newItem = {
    id: `item_${Date.now()}`,
    title,
    game: 'ARC Raiders',
    category,
    quantity: qty,
    supplierId,
    supplierName,
    supplierTargetPrice: sPrice,
    g2gListingPrice: sPrice,
    status: 'available',
    lockedBySellerId: null,
    lockedBySellerName: null,
    lockedAt: null,
    g2gListingId: '',
    g2gOrderId: '',
    soldPrice: null,
    soldAt: null,
    secretCredentials: secretCredentials || 'No credentials supplied',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  if (process.env.MONGODB_URI) {
    await connectDB();
    await Item.create(newItem);
  } else {
    store.items.unshift(newItem);
    saveData(store);
  }

  await logActivity('ITEM_CREATED', createdByName || supplierName, `Offer added: "${newItem.title}" [${newItem.category}] — User wants $${sPrice.toFixed(2)}`);
  await broadcastUpdate('ITEM_CREATED', `New offer from ${supplierName}: "${newItem.title}" ($${sPrice.toFixed(2)})`, createdByName || supplierName);
  res.json({ success: true, item: newItem });
});

// 4. Seller locks item (Anti-collision)
app.post('/api/items/:id/claim', async (req, res) => {
  const { id } = req.params;
  const { sellerId, sellerName } = req.body;

  if (!sellerId || !sellerName) {
    return res.status(400).json({ success: false, error: 'Seller identification required' });
  }

  let item = null;
  if (process.env.MONGODB_URI) {
    await connectDB();
    item = await Item.findOne({ id });
  } else {
    item = store.items.find((i) => i.id === id);
  }

  if (!item) {
    return res.status(404).json({ success: false, error: 'Item not found' });
  }

  // Anti-collision check
  if (item.status === 'locked_by_seller' || item.status === 'listing_in_progress') {
    if (item.lockedBySellerId !== sellerId) {
      return res.status(409).json({
        success: false,
        error: `COLLISION PREVENTED: This item was taken by ${item.lockedBySellerName}! You cannot sell it.`,
        lockedBy: item.lockedBySellerName
      });
    }
  }

  if (item.status === 'sold') {
    return res.status(400).json({ success: false, error: 'Item has already been sold.' });
  }

  item.status = 'locked_by_seller';
  item.lockedBySellerId = sellerId;
  item.lockedBySellerName = sellerName;
  item.lockedAt = new Date().toISOString();

  if (process.env.MONGODB_URI) {
    await item.save();
  } else {
    saveData(store);
  }

  await logActivity('CLAIMED_FOR_G2G', sellerName, `🔒 ${sellerName} took "${item.title}" to sell on G2G. Other seller is blocked.`);
  await broadcastUpdate('CLAIMED_FOR_G2G', `🔒 "${item.title}" taken by ${sellerName} to sell on G2G`, sellerName);
  res.json({ success: true, item });
});

// 5. Seller releases lock (Leave for another seller)
app.post('/api/items/:id/release', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  let item = null;
  if (process.env.MONGODB_URI) {
    await connectDB();
    item = await Item.findOne({ id });
  } else {
    item = store.items.find((i) => i.id === id);
  }

  if (!item) {
    return res.status(404).json({ success: false, error: 'Item not found' });
  }

  const sellerName = item.lockedBySellerName || 'Seller';
  item.status = 'available';
  item.lockedBySellerId = null;
  item.lockedBySellerName = null;
  item.lockedAt = null;

  if (process.env.MONGODB_URI) {
    await item.save();
  } else {
    saveData(store);
  }

  const releaseMsg = reason || 'Left for another seller';
  await logActivity('UNLOCKED', sellerName, `🔓 "${item.title}" was unlocked by ${sellerName} (${releaseMsg}). Now available!`);
  await broadcastUpdate('UNLOCKED', `"${item.title}" was unlocked by ${sellerName} (${releaseMsg}). Available now!`, sellerName);
  res.json({ success: true, item });
});

// 6. Mark Item as Sold on G2G
app.post('/api/items/:id/mark-sold', async (req, res) => {
  const { id } = req.params;
  const { sellerId, g2gOrderId, finalPrice } = req.body;

  let item = null;
  if (process.env.MONGODB_URI) {
    await connectDB();
    item = await Item.findOne({ id });
  } else {
    item = store.items.find((i) => i.id === id);
  }

  if (!item) {
    return res.status(404).json({ success: false, error: 'Item not found' });
  }

  if (item.lockedBySellerId !== sellerId) {
    return res.status(403).json({ success: false, error: 'Only the claiming seller can finalize the sale.' });
  }

  const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
  const totalItemCost = (item.supplierTargetPrice || 0) * qty;
  const finalSoldPrice = parseFloat(finalPrice) || totalItemCost;
  const supplierPayout = totalItemCost;
  const grossProfit = Math.max(0, finalSoldPrice - supplierPayout);

  item.status = 'sold';
  item.g2gOrderId = g2gOrderId || `G2G-ORD-${Math.floor(1000000 + Math.random() * 9000000)}`;
  item.soldPrice = finalSoldPrice;
  item.soldAt = new Date().toISOString();

  if (process.env.MONGODB_URI) {
    await item.save();
    if (grossProfit > 0) {
      await User.updateOne({ id: sellerId }, { $inc: { balance: grossProfit } });
    }
    await User.updateOne({ id: item.supplierId }, { $inc: { balance: supplierPayout } });
  } else {
    const seller = store.users.find((u) => u.id === sellerId);
    const supplier = store.users.find((u) => u.id === item.supplierId);
    if (seller && grossProfit > 0) {
      seller.balance = parseFloat((seller.balance + grossProfit).toFixed(2));
    }
    if (supplier) {
      supplier.balance = parseFloat((supplier.balance + supplierPayout).toFixed(2));
    }
    saveData(store);
  }

  await logActivity(
    'ITEM_SOLD',
    item.lockedBySellerName,
    `🎉 SOLD! "${item.title}" (${qty}x) on G2G for $${finalSoldPrice.toFixed(2)} (Order ${item.g2gOrderId}). Supplier +$${supplierPayout.toFixed(2)}${grossProfit > 0 ? `, Seller +$${grossProfit.toFixed(2)}` : ''}`
  );
  await broadcastUpdate('ITEM_SOLD', `🎉 "${item.title}" (${qty}x) SOLD on G2G for $${finalSoldPrice.toFixed(2)}!`, item.lockedBySellerName);
  res.json({ success: true, item, profit: grossProfit, supplierPayout });
});

// 7. Withdraw Money ($1.00 flat + 5% fee)
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, method, destination } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!userId || isNaN(parsedAmount) || parsedAmount <= 1.00) {
    return res.status(400).json({
      success: false,
      error: 'Invalid withdrawal amount. Minimum withdrawal is $1.01 (must exceed $1.00 flat fee).'
    });
  }

  let user = null;
  if (process.env.MONGODB_URI) {
    await connectDB();
    user = await User.findOne({ id: userId });
  } else {
    user = store.users.find((u) => u.id === userId);
  }

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  if (user.balance < parsedAmount) {
    return res.status(400).json({
      success: false,
      error: `Insufficient balance. Available: $${user.balance.toFixed(2)}, Requested: $${parsedAmount.toFixed(2)}`
    });
  }

  const fixedFee = 1.00;
  const percentFee = parseFloat((parsedAmount * 0.05).toFixed(2));
  const totalFee = parseFloat((fixedFee + percentFee).toFixed(2));
  const netPayout = parseFloat((parsedAmount - totalFee).toFixed(2));

  user.balance = parseFloat((user.balance - parsedAmount).toFixed(2));

  const withdrawalRecord = {
    id: `wth_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    amount: parsedAmount,
    fixedFee,
    percentFee,
    totalFee,
    netPayout,
    method: method || 'G2G Wallet / Bank',
    destination: destination || 'Default account',
    status: 'completed',
    createdAt: new Date().toISOString()
  };

  if (process.env.MONGODB_URI) {
    await User.updateOne({ id: user.id }, { $set: { balance: user.balance } });
    await Withdrawal.create(withdrawalRecord);
  } else {
    if (!store.withdrawals) store.withdrawals = [];
    store.withdrawals.unshift(withdrawalRecord);
    saveData(store);
  }

  await logActivity(
    'WITHDRAWAL',
    user.name,
    `💸 ${user.name} withdrew $${parsedAmount.toFixed(2)} (Fee: $${totalFee.toFixed(2)} [$1.00 + 5%], Net: $${netPayout.toFixed(2)}) via ${withdrawalRecord.method}`
  );
  await broadcastUpdate('WITHDRAWAL', `💸 ${user.name} withdrew $${parsedAmount.toFixed(2)} (Net: $${netPayout.toFixed(2)})`, user.name);

  res.json({
    success: true,
    withdrawal: withdrawalRecord,
    newBalance: user.balance
  });
});

app.get('/api/withdrawals', async (req, res) => {
  if (process.env.MONGODB_URI) {
    await connectDB();
    const list = await Withdrawal.find({}, '-_id -__v').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, withdrawals: list });
  }
  res.json({ success: true, withdrawals: store.withdrawals || [] });
});

// 8. Delete item
app.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  if (process.env.MONGODB_URI) {
    await connectDB();
    const deleted = await Item.findOneAndDelete({ id });
    if (!deleted) return res.status(404).json({ success: false, error: 'Item not found' });
    await logActivity('ITEM_DELETED', 'Admin/User', `Deleted stock item "${deleted.title}"`);
    await broadcastUpdate('ITEM_DELETED', `Stock item "${deleted.title}" was removed`, 'Admin');
    return res.json({ success: true });
  } else {
    const idx = store.items.findIndex((i) => i.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Item not found' });
    const deleted = store.items.splice(idx, 1)[0];
    await logActivity('ITEM_DELETED', 'Admin/User', `Deleted stock item "${deleted.title}"`);
    saveData(store);
    await broadcastUpdate('ITEM_DELETED', `Stock item "${deleted.title}" was removed`, 'Admin');
    return res.json({ success: true });
  }
});

// 9. Reset Demo Data
app.post('/api/reset-demo', async (req, res) => {
  const seed = getInitialSeedData();
  if (process.env.MONGODB_URI) {
    await connectDB();
    await Promise.all([
      User.deleteMany({}),
      Item.deleteMany({}),
      Withdrawal.deleteMany({}),
      ActivityLog.deleteMany({})
    ]);
    await User.insertMany(seed.users);
    await broadcastUpdate('SYSTEM_RESET', 'Data has been reset to defaults', 'Admin');
    return res.json({ success: true, message: 'Reset successful', data: seed });
  } else {
    store = seed;
    saveData(store);
    await broadcastUpdate('SYSTEM_RESET', 'Data has been reset to defaults', 'Admin');
    return res.json({ success: true, message: 'Reset successful', data: store });
  }
});

// WebSocket Connection handling
wss.on('connection', async (ws) => {
  const currentState = await getFullState();
  ws.send(
    JSON.stringify({
      type: 'INIT_STATE',
      state: currentState
    })
  );

  ws.on('error', (error) => {
    console.error('WebSocket client error:', error);
  });
});

// Run server when started directly
const PORT = process.env.PORT || 3000;
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (!process.env.VERCEL && isMain) {
  server.listen(PORT, () => {
    console.log(`🚀 G2G Management Server running at http://localhost:${PORT}`);
    console.log(`⚡ WebSocket Server ready for real-time seller multi-client sync`);
  });
}

export default app;
